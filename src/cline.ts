/**
 * Forgevi — the Cline CLI bridge. THE IN-VM AGENT LAW, second generation.
 *
 * The engine executes the REAL Cline CLI (the npm package `cline` — a
 * platform binary, no Node runtime needed) INSIDE the run's sandbox,
 * headless: `--json` (NDJSON event stream on stdout) + `--auto-approve`
 * (full autonomy) + `-c /workspace`. Its events are relayed into the SAME
 * OpenHandsEvent vocabulary the run journal already speaks — the manager,
 * the wire contract, the soul law, the studio surface: all unchanged.
 *
 * Nothing here runs an agent loop, picks tools, or talks to an LLM — Cline
 * owns all of that. The engine's job is identical to the OpenHands era:
 * pick the lane (pooled OpenRouter key + chain model), authenticate the
 * binary per lane (`cline auth -p openrouter …` — a persisted key survives
 * config reloads; the `-k` run-flag alone proved NOT to send the header),
 * stream stdout, translate events, settle honestly.
 *
 * VERIFIED CONTRACT (clined 2026-09-23 against cline@3.0.64 with a mock
 * OpenRouter): one NDJSON line per event —
 *   {"type":"hook_event","hookEventName":"agent_start|agent_end|agent_error|tool_call|tool_result",…}
 *   {"type":"agent_event","event":{
 *      type:"iteration_start"|"iteration_end",
 *      iteration:number, hadToolCalls?:boolean, toolCallCount?:number}}
 *   {"type":"agent_event","event":{
 *      type:"content_start", contentType:"text"|"tool",
 *      text?:string, accumulated?:string,            // text (per-delta; may repeat)
 *      toolName?:string, toolCallId?:string, input?:unknown}}   // tool
 *   {"type":"agent_event","event":{
 *      type:"content_end", contentType:"text"|"tool",
 *      text?:string,                                  // FULL text once per block
 *      toolName?:string, toolCallId?:string, output?:unknown, durationMs?:number}}
 *   {"type":"agent_event","event":{type:"usage",…}}
 *   {"type":"agent_event","event":{type:"error", error:{message:string,…}}}
 *   {"type":"agent_event","event":{type:"done", reason:string, text:string, iterations:number}}
 *   {"type":"run_result", finishReason:"completed"|"error"|"aborted"|…,
 *      text:string, iterations:number, usage:{…}, durationMs:number,
 *      model:{id:string, provider:string}}
 * THE CONTENT-END LAW: text blocks emit content_start per delta but exactly
 * ONE content_end carrying the full text — messages are relayed at END.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { platformRulesMarkdown } from "./platform-law.ts";
import type { SandboxAdapter } from "./e2b-backblaze/sandbox.ts";
import { runOpenHands, type OpenHandsEvent, type LlmConfig, type OpenHandsRunOpts } from "./openhands.ts";

export type { OpenHandsEvent, LlmConfig };

/** The pinned CLI version — the one this contract was verified against. */
export const CLINE_VERSION = "3.0.64";

/** Isolated config dir in the VM — THE RUNTIME-USER LAW: E2B exec commands
 *  run as the sandbox's unprivileged user, so everything cline writes
 *  (config + data) must live in USER-WRITABLE space. /tmp is world-writable
 *  and ephemeral per boot — perfect (auth is re-issued per run lane
 *  anyway). NEVER /opt/forgevi: it is root-owned (live-verified EACCES:
 *  mkdir '/opt/forgevi/cline/config/data'). */
const VM_CLINE_DIR = "/tmp/forgevi-cline";
const VM_CLINE_CONFIG = `${VM_CLINE_DIR}/config`;
/** Lazy-install prefix for old-template sandboxes — npm's global prefix is
 *  root-owned; a HOME prefix installs without privileges. */
const VM_CLINE_HOME_BIN = "$HOME/.npm-global/bin/cline";
/** THE BINARY-RESOLUTION LAW (live-observed 2026-09-25, the rotation-lane
 *  death): the run exec's shell PATH can disagree with the probe exec's
 *  (lane 1 ran the baked /usr/local/bin/cline fine; the rotation lane's
 *  `command -v cline` came up empty and fell to the un-installed HOME
 *  path → exit 127, run dead). The binary now resolves to an ABSOLUTE
 *  path with layered fallbacks INSIDE one exec — PATH lookup first, then
 *  the baked location, then the lazy-install prefix — so no single
 *  shell-environment quirk can kill a lane. */
const VM_CLINE_RESOLVE =
  `__cline=$(command -v cline 2>/dev/null || true); ` +
  `[ -n "$__cline" ] && [ -x "$__cline" ] || __cline=/usr/local/bin/cline; ` +
  `[ -x "$__cline" ] || __cline=$HOME/.npm-global/bin/cline; ` +
  `[ -x "$__cline" ] || { echo "cline binary not found (PATH, /usr/local/bin/cline, $HOME/.npm-global/bin/cline) — the sandbox template is broken" >&2; exit 127; }; ` +
  `export __cline`;

/** THE CODE-STREAM LAW cap: the file body forwarded per editor event. */
const FILE_EVENT_CAP = 32 * 1024;

// ── THE SYSTEM-PROMPT LAW (user mandate 2026-09-24) ─────────────────────
// The platform's standing instructions (THE FINISH LAW above all: the
// agent spins up the dev server itself when it finishes making edits)
// ride Cline's SYSTEM PROMPT through its native workspace-rules mechanism:
// .clinerules/forgevi-platform.md is injected into the system prompt's
// "# Rules" section (verified against cline@3.0.64 — the built-in Cline
// prompt, tool docs and tool surface are all preserved). Root-anchored
// exclusion from the project tar keeps the platform's control file out of
// the user's snapshots; the file is re-injected before every run.
const RULES_REL_PATH = ".clinerules/forgevi-platform.md";

async function ensurePlatformRules(sandbox: SandboxAdapter, workspace: string, devPort: number | null | undefined): Promise<void> {
  const markdown = platformRulesMarkdown(devPort ?? null);
  try {
    if (sandbox.kind === "e2b") {
      // E2B's files.write handles parents, but a tiny mkdir keeps the
      // write single-shot honest even when a flat .clinerules FILE
      // existed and was removed between runs.
      await sandbox.exec(`mkdir -p '${workspace}/${path.posix.dirname(RULES_REL_PATH)}'`, { timeoutMs: 15_000 }).catch(() => undefined);
      await sandbox.writeFile(RULES_REL_PATH, markdown);
    } else {
      await sandbox.writeFile(RULES_REL_PATH, markdown);
    }
  } catch {
    // best-effort: the task prompt still carries the platform laws — a
    // missing rules file never kills the run.
  }
}

// ── availability probe (per lane — NEVER cached across lanes) ────────────

/** THE RE-PROBE LAW (live-observed 2026-09-25, both E2E runs): the cline
 *  binary can VANISH from the sandbox's exec view mid-run (lane 1 ran the
 *  baked binary fine; the rotation lane's execs saw no PATH binary, no
 *  /usr/local/bin/cline, no HOME prefix — then a later probe saw a
 *  user-owned re-materialized symlink; the controlled experiment on a fresh
 *  sandbox showed a stable FS, so this is an E2B pause/resume-class
 *  filesystem quirk). The WeakMap cache lied across lanes; the probe now
 *  runs on EVERY lane (a ~100ms exec) and self-heals by reinstalling under
 *  the HOME prefix when the binary is gone — a rotation lane never dies on
 *  a missing binary again. */
async function ensureCline(sandbox: SandboxAdapter): Promise<boolean> {
  // the layered probe: PATH lookup, the baked absolute path, the lazy prefix
  const probe = await sandbox
    .exec(
      `command -v cline >/dev/null 2>&1 || test -x /usr/local/bin/cline || test -x ${VM_CLINE_HOME_BIN}`,
      { timeoutMs: 10_000 },
    )
    .catch(() => null);
  if (probe && probe.exitCode === 0) return true;
  if (sandbox.kind !== "e2b") return false; // no lazy install on dev hosts
  // the binary vanished (or never existed on an old-template sandbox):
  // one lazy install under a USER-WRITABLE prefix (npm -g needs root on the
  // default prefix — live-verified).
  const install = await sandbox
    .exec(`npm install -g --prefix "$HOME/.npm-global" cline@${CLINE_VERSION} 2>&1 | tail -n 3`, { timeoutMs: 300_000 })
    .catch(() => null);
  if (!install || install.exitCode !== 0) return false;
  const reprobe = await sandbox.exec(`test -x ${VM_CLINE_HOME_BIN}`, { timeoutMs: 10_000 }).catch(() => null);
  return Boolean(reprobe && reprobe.exitCode === 0);
}

// ── per-lane auth ────────────────────────────────────────────────────────

/** The bare model id for the lane (`openai/` litellm prefix stripped —
 *  OpenRouter provider ids are bare). */
function bareModel(model: string): string {
  return model.replace(/^openai\//, "");
}

/** Authenticate cline for THIS lane (pooled key + chain model). Persisted
 *  auth is what actually sends the Authorization header (verified: the
 *  `-k` run-flag alone does not). A non-OpenRouter base URL (the NIM
 *  failover lane) rides the openai-compatible provider with `-b`.
 *  THE BINARY-RESOLUTION LAW: the same layered resolution guards auth. */
async function clineAuth(sandbox: SandboxAdapter, llm: LlmConfig, configDir: string): Promise<void> {
  const isVanillaOpenRouter = !llm.baseUrl || /^https:\/\/openrouter\.ai\//i.test(llm.baseUrl);
  const model = bareModel(llm.model);
  const cmd = isVanillaOpenRouter
    ? `${VM_CLINE_RESOLVE} && "$__cline" auth -p openrouter -k '${llm.apiKey}' -m '${model}' --config '${configDir}'`
    : `${VM_CLINE_RESOLVE} && "$__cline" auth -p openai-compatible -k '${llm.apiKey}' -m '${model}' -b '${llm.baseUrl}' --config '${configDir}'`;
  const res = await sandbox.exec(cmd, { timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new Error(`cline auth failed (exit ${res.exitCode}): ${(res.stdout || res.stderr || "").slice(-300)}`);
  }
}

// ── the NDJSON → OpenHandsEvent translation ──────────────────────────────

interface ClineToolInput {
  path?: string;
  new_text?: string;
  commands?: string[];
  [k: string]: unknown;
}

/** Translate one parsed NDJSON record. Pure — the caller owns the queue. */
function translateClineRecord(
  rec: Record<string, unknown>,
  toolInputs: Map<string, { toolName: string; input: ClineToolInput }>,
): OpenHandsEvent[] {
  const out: OpenHandsEvent[] = [];
  const type = typeof rec.type === "string" ? rec.type : "";

  if (type === "agent_event") {
    const ev = (rec.event ?? {}) as Record<string, unknown>;
    const et = typeof ev.type === "string" ? ev.type : "";

    if (et === "content_end" && ev.contentType === "text") {
      // THE CONTENT-END LAW: the one full-text emission per block.
      const text = typeof ev.text === "string" ? ev.text : "";
      if (text.trim()) out.push({ type: "message", text });
      return out;
    }

    if (et === "content_start" && ev.contentType === "tool") {
      const toolName = typeof ev.toolName === "string" ? ev.toolName : "tool";
      const toolCallId = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
      const input = (ev.input ?? {}) as ClineToolInput;
      if (toolCallId) toolInputs.set(toolCallId, { toolName, input });
      const brief = describeToolInput(toolName, input);
      // THE CALL-MERGE LAW: the start and end of ONE tool call share the
      // callId — the frontend timeline renders ONE row that updates in
      // place when the result lands (was: two rows per call, the second
      // dragging the raw output into its label).
      out.push({ type: "action", tool: toolName, detail: brief, ...(toolCallId ? { callId: toolCallId } : {}) });
      return out;
    }

    if (et === "content_end" && ev.contentType === "tool") {
      const toolName = typeof ev.toolName === "string" ? ev.toolName : "tool";
      const toolCallId = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
      const remembered = toolInputs.get(toolCallId);
      const input = remembered?.input ?? {};
      const output = ev.output ?? null;
      // THE CODE-STREAM LAW: the editor's new_text rides the file event so
      // the studio fragments panel streams real code, not just paths.
      if (toolName === "editor" && typeof input.path === "string") {
        const content = typeof input.new_text === "string" ? input.new_text.slice(0, FILE_EVENT_CAP) : undefined;
        out.push({ type: "file", path: input.path, ...(content !== undefined ? { content } : {}) });
      }
      const ok = Boolean((output as { success?: boolean } | null)?.success);
      out.push({
        type: "action",
        tool: toolName,
        detail: `${describeToolInput(toolName, input)} → ${ok ? "ok" : summarizeOutput(output)}`.slice(0, 400),
        ...(toolCallId ? { callId: toolCallId } : {}),
      });
      return out;
    }

    if (et === "error") {
      const err = (ev.error ?? {}) as { message?: unknown };
      const message = typeof err.message === "string" ? err.message : JSON.stringify(err).slice(0, 300);
      out.push({ type: "error", error: message });
      return out;
    }
    return out; // iteration_start/end, usage, done, content_start(text) — journal-silent
  }

  if (type === "run_result") {
    const finishReason = typeof rec.finishReason === "string" ? rec.finishReason : "error";
    const text = typeof rec.text === "string" ? rec.text : "";
    if (finishReason === "completed") {
      out.push({ type: "finished", status: "complete", summary: text || "(cline finished)", issues: [] });
    } else {
      out.push({
        type: "finished",
        status: "incomplete",
        summary: text || `The Cline agent ended (${finishReason}).`,
        issues: [finishReason],
      });
    }
    return out;
  }

  if (type === "error") {
    const message = typeof rec.message === "string" ? rec.message : JSON.stringify(rec).slice(0, 300);
    out.push({ type: "error", error: message });
    return out;
  }

  return out; // hook_event + unknown records: never break the run
}

/** The commands of a run_commands input — the models sometimes send the
 *  array as a JSON-encoded STRING (live-observed: `commands: "[\"npm create…\"]"`),
 *  which fell to the raw-JSON fallback and put a wall of escaped JSON in
 *  the stream row's label. */
function commandList(input: ClineToolInput): string[] | null {
  const c: unknown = input.commands;
  if (Array.isArray(c)) return c.filter((x): x is string => typeof x === "string");
  if (typeof c === "string" && c.trim()) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* a bare command string */
    }
    return [c];
  }
  return null;
}

function describeToolInput(toolName: string, input: ClineToolInput): string {
  if (toolName === "editor" && typeof input.path === "string") {
    const kind = typeof input.old_text === "string" ? "edit" : typeof input.insert_line === "number" ? "insert" : "write";
    return `${kind} ${input.path}`;
  }
  if (toolName === "run_commands") {
    const cmds = commandList(input);
    if (cmds && cmds.length > 0) return `$ ${cmds.join(" && ").slice(0, 200)}`;
  }
  if (toolName === "read_files" && Array.isArray(input.files)) {
    const paths = (input.files as Array<{ path?: string }>).map((f) => f.path).filter(Boolean);
    return `read ${paths.slice(0, 4).join(", ")}${paths.length > 4 ? ` +${paths.length - 4}` : ""}`;
  }
  return JSON.stringify(input).slice(0, 200);
}

function summarizeOutput(output: unknown): string {
  if (output && typeof output === "object") {
    const o = output as { result?: unknown; error?: unknown };
    const r = typeof o.result === "string" ? o.result : typeof o.error === "string" ? o.error : "";
    if (r) return r.slice(0, 200);
  }
  return JSON.stringify(output).slice(0, 200);
}

// ── one cline execution (the openhands.ts shape, cline's soul) ───────────

export interface ClineRunOpts extends Omit<OpenHandsRunOpts, "maxIterations"> {
  /** Unused by cline (its autonomy budget is --retries + the wall clock);
   *  kept in the type for manager drop-in symmetry. */
  maxIterations?: number;
  /** THE SYSTEM-PROMPT LAW: the run's assigned dev-server port — it rides
   *  the platform rules file (Cline's system-prompt Rules section), never
   *  a hardcoded engine-side start. */
  devPort?: number | null;
}

/** One headless Cline run — yields OpenHandsEvents, settles honestly.
 *  E2B: the CLI executes INSIDE the microVM (streamed stdout over the
 *  commands API). Local: host spawn (dev engines with cline installed). */
export async function* runCline(opts: ClineRunOpts): AsyncGenerator<OpenHandsEvent> {
  const sandbox = opts.sandbox;

  const queue: OpenHandsEvent[] = [];
  let waker: (() => void) | null = null;
  let sawFinished = false;
  let closed = false;
  let exitCode: number | null = null;
  let stderrTail = "";
  const toolInputs = new Map<string, { toolName: string; input: ClineToolInput }>();

  const wake = () => waker?.();

  /** Line-buffered NDJSON feed — chunks may split lines at any byte. */
  const makeFeeder = () => {
    let buffer = "";
    return (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith("Warning:") || line.startsWith("DeprecationWarning:")) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // never let a bad line break the run
        }
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          for (const ev of translateClineRecord(parsed as Record<string, unknown>, toolInputs)) {
            if (ev.type === "finished") sawFinished = true;
            queue.push(ev);
          }
        }
      }
      wake();
    };
  };

  // THE COMMAND WINDOW: identical to the OpenHands era (the wall clock
  // bounds the run; the abort signal still kills it instantly).
  const wallClockMs = config.maxWallclockMs > 0 ? config.maxWallclockMs : 50 * 60_000;

  const lane = (async () => {
    // E2B: THE RUNTIME-USER LAW — the prompt + config live under
    // /tmp/forgevi-cline (user-writable; /opt/forgevi is root-owned —
    // live-verified EACCES). Local dev engines: a host temp dir.
    let promptPath: string;
    let configDir: string;
    let localDir: string | null = null;
    try {
      // THE SYSTEM-PROMPT LAW: the platform rules land in the WORKSPACE
      // (before auth/run so the very first conversation turn already
      // carries them in the system prompt).
      await ensurePlatformRules(sandbox, opts.workspace, opts.devPort);
      if (sandbox.kind === "e2b") {
        const mkdir = await sandbox.exec(`mkdir -p ${VM_CLINE_DIR}`, { timeoutMs: 15_000 }).catch(() => null);
        if (!mkdir || mkdir.exitCode !== 0) {
          throw new Error("cannot create the user-writable cline dir in the sandbox");
        }
        configDir = VM_CLINE_CONFIG;
        const promptId = crypto.randomUUID();
        promptPath = `${VM_CLINE_DIR}/prompt-${promptId}.txt`;
        await sandbox.writeVmFile(promptPath, opts.prompt);
      } else {
        localDir = await mkdtemp(path.join(tmpdir(), "forgevi-cline-"));
        configDir = path.join(localDir, "config");
        promptPath = path.join(localDir, "prompt.txt");
        await writeFile(promptPath, opts.prompt);
      }
      await clineAuth(sandbox, opts.llm, configDir);
      // THE PROMPT-FILE LAW: the task prompt (soul contract included) is
      // passed via command substitution — robust against quotes/newlines/size.
      // THE BINARY-RESOLUTION LAW: the run command resolves the cline binary
      // through the same layered fallback chain as auth — PATH lookup, the
      // baked /usr/local/bin location, then the lazy-install prefix — so a
      // shell-PATH disagreement between execs can never kill a lane.
      const runCmd =
        `${VM_CLINE_RESOLVE} && exec "$__cline" --json --auto-approve true -c '${opts.workspace}' --config '${configDir}' "$(cat '${promptPath}')"; ` +
        `__rc=$?; rm -f '${promptPath}'; exit $__rc`;
      const feed = makeFeeder();
      const res = await sandbox.execStream(runCmd, {
        onStdout: feed,
        onStderr: (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
        },
        timeoutMs: wallClockMs,
        signal: opts.signal,
      });
      exitCode = res.exitCode;
    } catch (err) {
      stderrTail = (stderrTail + `\n[lane error] ${err instanceof Error ? err.message : String(err)}`).slice(-4000);
    } finally {
      if (localDir) await rm(localDir, { recursive: true, force: true }).catch(() => undefined);
      closed = true;
      wake();
    }
  })();

  const wait = () =>
    new Promise<void>((resolve) => {
      waker = resolve;
      setTimeout(resolve, 500).unref?.(); // belt-and-braces poll
    });

  try {
    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift()!;
        yield ev;
        if (ev.type === "finished") return;
      }
      if (closed) break;
      if (opts.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      await wait();
    }
  } finally {
    await lane.catch(() => undefined);
  }

  // The agent died without settling — settle honestly.
  if (!sawFinished) {
    yield {
      type: "finished",
      status: "incomplete",
      summary: opts.signal.aborted
        ? "Aborted by the user. Work done so far is saved in the workspace."
        : `The Cline agent exited (code ${exitCode ?? "?"}) without finishing.${stderrTail ? ` Agent log tail: ${stderrTail.slice(-800)}` : ""}`,
      issues: opts.signal.aborted ? [] : ["cline exited unexpectedly"],
    };
  }
}

// ── THE AGENT-LANE DISPATCHER (manager's single entry point) ─────────────

/** Run the configured agent lane with automatic fallback: cline is the
 *  default; when it is unavailable in this sandbox (old template, install
 *  failure, dev host without cline) the run transparently rides the
 *  OpenHands worker instead — never a failed run for a missing binary. */
export async function* runAgent(opts: ClineRunOpts): AsyncGenerator<OpenHandsEvent> {
  if (config.agentLane === "openhands") {
    yield* runOpenHands(opts);
    return;
  }
  let usable = false;
  try {
    usable = await ensureCline(opts.sandbox);
  } catch {
    usable = false;
  }
  if (!usable) {
    yield {
      type: "error",
      error: "Cline CLI unavailable in this sandbox — the run falls back to the OpenHands worker.",
    };
    yield* runOpenHands(opts);
    return;
  }
  yield* runCline(opts);
}
