/**
 * Forgevi — the OpenHands bridge.
 *
 * THE IN-VM AGENT LAW: the engine executes the real openhands-sdk worker
 * (`openhands/worker.py`) INSIDE the run's sandbox — E2B microVM (streamed
 * stdout over the commands API) or local disk (host spawn, dev engines).
 * The engine relays the worker's stdout JSON lines into the run journal.
 * Nothing here runs an agent loop, picks tools, or talks to an LLM —
 * OpenHands owns all of that.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { platformLawText } from "./platform-law.ts";
import { OpenRouterKeyPool, isOpenRouterQuotaSignature, isOpenRouterModelUnavailableSignature, type KeyPick } from "./llm/openrouter-pool.ts";
import type { SandboxAdapter } from "./e2b-backblaze/sandbox.ts";

export interface LlmConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/** THE OPENROUTER POOL (module singleton — round-robin + 429/quota latching). */
export let openrouterPool = new OpenRouterKeyPool(config.openrouterKeys);

/** Rebuild the pool after a config push (the deploy surface calls this). */
export function reloadOpenRouterPool(): void {
  openrouterPool = new OpenRouterKeyPool(config.openrouterKeys);
}

export interface LlmResolution {
  ok: boolean;
  error?: string;
  llm?: LlmConfig;
  /** The pool pick this resolution rode — the manager reports outcomes to it. */
  pick?: KeyPick;
  /** The full free-model chain (the manager's lane fallback order). */
  modelChain: string[];
  /** The NVIDIA NIM lane (NVIDIA_API_KEY) — the last-resort failover. */
  nvidia?: LlmConfig;
  /** Pool telemetry for /health + /stats. */
  pool: ReturnType<OpenRouterKeyPool["stats"]>;
}

/** The engine's LLM lanes: the OpenRouter KEY POOL (round-robin, cascade on
 *  429/quota) + the model CHAIN (ENGINE_MODELS, comma-separated, first
 *  healthy wins) + the NVIDIA NIM failover lane when configured. */
export function resolveLlmConfig(): LlmResolution {
  if (config.openrouterKeys.length === 0) {
    return {
      ok: false,
      error: "OPENROUTER_API_KEYS is not set — the engine has no LLM",
      modelChain: config.modelChain,
      pool: openrouterPool.stats(),
    };
  }
  let pick: KeyPick;
  try {
    pick = openrouterPool.pick();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      modelChain: config.modelChain,
      pool: openrouterPool.stats(),
    };
  }
  const model = `openai/${config.modelChain[0] ?? "nvidia/nemotron-3-ultra-550b-a55b:free"}`;
  const nvidiaKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || undefined;
  const nvidiaBare = (process.env.NVIDIA_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b").replace(/^openai\//, "");
  return {
    ok: true,
    llm: {
      model,
      apiKey: pick.apiKey,
      baseUrl: config.openrouterBaseUrl,
    },
    pick,
    modelChain: config.modelChain,
    ...(nvidiaKey
      ? {
          nvidia: {
            model: `openai/${nvidiaBare}`,
            apiKey: nvidiaKey,
            baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
          },
        }
      : {}),
    pool: openrouterPool.stats(),
  };
}

/** Resolve a SPECIFIC lane (the manager's rotation): a given model index
 *  through a FRESH pool pick. Returns null when the pool is exhausted. */
export function resolveLaneLlm(modelIndex: number): { llm: LlmConfig; pick: KeyPick } | null {
  if (config.openrouterKeys.length === 0) return null;
  const bare = config.modelChain[modelIndex % Math.max(1, config.modelChain.length)];
  if (!bare) return null;
  try {
    const pick = openrouterPool.pick();
    return {
      llm: { model: `openai/${bare}`, apiKey: pick.apiKey, baseUrl: config.openrouterBaseUrl },
      pick,
    };
  } catch {
    return null;
  }
}

export { isOpenRouterQuotaSignature, isOpenRouterModelUnavailableSignature };

export type OpenHandsEvent =
  | { type: "thinking"; text: string }
  | { type: "message"; text: string }
  | { type: "action"; tool: string; detail?: string }
  | { type: "file"; path: string; content?: string }
  | { type: "error"; error: string }
  | { type: "finished"; status: "complete" | "incomplete"; summary: string; issues?: string[] };

export interface OpenHandsRunOpts {
  workspace: string;
  prompt: string;
  llm: LlmConfig;
  maxIterations?: number;
  signal: AbortSignal;
  /** THE IN-VM AGENT LAW: the run's sandbox — the OpenHands worker
   *  executes INSIDE it. E2B: the worker script + job spec are written
   *  into the microVM and its stdout JSON events stream back live over
   *  the commands API (the SDK's LocalWorkspace/tmux terminal/file
   *  editor then operate on the sandbox's OWN filesystem — the REAL
   *  OpenHands, unmodified, inside the user's machine). Local: the
   *  worker spawns on this host against the sandbox's local disk. */
  sandbox: SandboxAdapter;
  /** THE SYSTEM-PROMPT LAW (user mandate 2026-09-24): the run's assigned
   *  dev-server port — the platform law text (THE FINISH LAW: the agent
   *  spins up the dev server when it finishes making edits) rides the
   *  worker's system prompt as an addendum, with this port baked in per
   *  run. Dynamic facts stay dynamic — never a hardcoded engine start. */
  devPort?: number | null;
}

function pythonBin(): string {
  return process.env.OH_PYTHON || "python3";
}

function engineRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

function workerPath(): string {
  return path.join(engineRoot(), "openhands", "worker.py");
}

// ── the in-VM worker install (E2B) ──────────────────────────────────────

const VM_WORKER_DIR = "/opt/forgevi";
const VM_WORKER_PATH = `${VM_WORKER_DIR}/worker.py`;
/** The in-VM interpreter — the baked template's venv python. Invoked
 *  EXPLICITLY (never bare python3): the sandbox runtime's PATH belongs
 *  to the platform (system python3 is 3.11, the SDK needs >=3.12). */
const VM_PYTHON = process.env.OH_VM_PYTHON || "/opt/venv/bin/python3";

async function sha256Hex(data: string | Buffer): Promise<string> {
  // Buffer<ArrayBufferLike> is not a BufferSource under the current lib
  // types — a fresh Uint8Array copy satisfies both worlds.
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

/** Ensure the VM has the current worker.py (skip the write when the
 *  on-disk hash matches — one tiny exec beats a 20KB upload per run). */
async function ensureVmWorker(sandbox: SandboxAdapter): Promise<void> {
  const src = await readFile(workerPath(), "utf8");
  const hash = await sha256Hex(src);
  const probe = await sandbox.exec(`test "$(cat ${VM_WORKER_DIR}/.worker-hash 2>/dev/null)" = '${hash}'`);
  if (probe.exitCode === 0) return;
  await sandbox.exec(`mkdir -p ${VM_WORKER_DIR}`, { timeoutMs: 15_000 });
  // the worker script + hash marker land at ABSOLUTE paths in /opt/forgevi
  // (never the user's workspace); the job spec carries live credentials
  // (the LLM key) and dies the moment the worker has read it.
  await sandbox.writeVmFile(VM_WORKER_PATH, src);
  await sandbox.writeVmFile(`${VM_WORKER_DIR}/.worker-hash`, hash);
}

/** One OpenHands worker execution — yields its events, settles honestly.
 *
 *  E2B: the worker runs INSIDE the microVM (streamed stdout). Local: the
 *  worker spawns on this host. Both feed the same event queue with the
 *  same line-buffered JSON parsing and the same honest settlement. */
export async function* runOpenHands(opts: OpenHandsRunOpts): AsyncGenerator<OpenHandsEvent> {
  const sandbox = opts.sandbox;

  const queue: OpenHandsEvent[] = [];
  let waker: (() => void) | null = null;
  let sawFinished = false;
  let closed = false;
  let exitCode: number | null = null;
  let stderrTail = "";

  const wake = () => waker?.();

  /** Line-buffered event feed — chunks may split lines at any byte. */
  const makeFeeder = () => {
    let buffer = "";
    return (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // never let a bad line break the run
        }
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          const ev = parsed as OpenHandsEvent;
          if (ev.type === "finished") sawFinished = true;
          queue.push(ev);
        }
      }
      wake();
    };
  };

  const jobSpec = JSON.stringify({
    workspace: opts.workspace,
    prompt: opts.prompt,
    model: opts.llm.model,
    api_key: opts.llm.apiKey,
    ...(opts.llm.baseUrl ? { base_url: opts.llm.baseUrl } : {}),
    max_iterations: opts.maxIterations ?? (Number(process.env.OH_MAX_ITERATIONS || 0) || 500),
    max_output_tokens: Number(process.env.OH_MAX_OUTPUT_TOKENS || 0) || 16384,
    // THE SYSTEM-PROMPT LAW: the platform law addendum — the worker
    // appends it to the SDK default agent's system prompt (the default
    // prompt is preserved, never replaced — verified against
    // openhands-sdk 1.44.1's Agent.model_copy semantics).
    system_addendum: platformLawText(opts.devPort ?? null),
  });

  // THE COMMAND WINDOW: the in-VM worker command's timeout. A configured
  // wall clock (FORGVI3_MAX_WALLCLOCK_MS) bounds it; unconfigured runs
  // ride the sandbox window (the hold extends the E2B timeout to the hard
  // cap; the run's abort signal still kills it instantly on user abort).
  const wallClockMs =
    config.maxWallclockMs > 0 ? config.maxWallclockMs : 50 * 60_000;

  const lane = (async () => {
    try {
      if (sandbox.kind === "e2b") {
        // ── THE IN-VM AGENT LAW ── the real OpenHands worker executes
        // INSIDE the microVM; its stdout events stream back live.
        await ensureVmWorker(sandbox);
        const jobId = crypto.randomUUID();
        const jobPath = `${VM_WORKER_DIR}/job-${jobId}.json`;
        await sandbox.writeVmFile(jobPath, jobSpec);
        const feed = makeFeeder();
        const res = await sandbox.execStream(`${VM_PYTHON} ${VM_WORKER_PATH} --job ${jobPath}`, {
          onStdout: feed,
          onStderr: (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-4000);
          },
          timeoutMs: wallClockMs,
          signal: opts.signal,
        });
        exitCode = res.exitCode;
      } else {
        // ── local lane ── the worker spawns on this host (dev engine,
        // no E2B keys): same worker, LocalWorkspace on local disk.
        const dir = await mkdtemp(path.join(tmpdir(), "forgevi-job-"));
        const jobFile = path.join(dir, "job.json");
        await writeFile(jobFile, jobSpec);
        // THE JOB-FILE CLEANUP LAW: the worker reads it then deletes it.
        const child = spawn(pythonBin(), [workerPath(), "--job", jobFile], {
          cwd: engineRoot(),
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const feed = makeFeeder();
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => feed(chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
        });
        child.on("error", () => {
          closed = true;
          wake();
        });
        child.on("close", (code) => {
          exitCode = code;
          closed = true;
          wake();
        });
        const onAbort = () => {
          try {
            child.kill("SIGTERM");
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
            }, 8000).unref();
          } catch {
            /* already gone */
          }
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        // wait for child close (the settle path below handles the rest)
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (closed) {
              clearInterval(poll);
              resolve();
            }
          }, 250);
          poll.unref?.();
        });
        opts.signal.removeEventListener("abort", onAbort);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err) {
      // lane-level failure (write/exec problems) — honest settlement below
      stderrTail = (stderrTail + `\n[lane error] ${err instanceof Error ? err.message : String(err)}`).slice(-4000);
    } finally {
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
        // give the worker a beat to flush its abort settlement
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      await wait();
    }
  } finally {
    await lane.catch(() => undefined);
  }

  // The worker died without settling — settle honestly.
  if (!sawFinished) {
    yield {
      type: "finished",
      status: "incomplete",
      summary: opts.signal.aborted
        ? "Aborted by the user. Work done so far is saved in the workspace."
        : `The OpenHands worker exited (code ${exitCode ?? "?"}) without finishing.${stderrTail ? ` Worker log tail: ${stderrTail.slice(-800)}` : ""}`,
      issues: opts.signal.aborted ? [] : ["worker exited unexpectedly"],
    };
  }
}

// ── capability probe (for /health) ──────────────────────────────────────

let probeCache: ProbeResult | null = null;

export interface ProbeResult {
  ok: boolean;
  sdk?: string;
  tools?: string[];
  error?: string;
}

export function probeOpenHandsSync(): ProbeResult | null {
  return probeCache;
}

export async function probeOpenHands(): Promise<ProbeResult> {
  if (probeCache) return probeCache;
  return await new Promise<ProbeResult>((resolve) => {
    const child = spawn(pythonBin(), [workerPath(), "--probe"], {
      cwd: engineRoot(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 90_000);
    timer.unref?.();
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    const settle = (result: ProbeResult) => {
      clearTimeout(timer);
      probeCache = result;
      resolve(result);
    };
    child.on("close", () => {
      try {
        const lines = out.trim().split("\n").filter(Boolean);
        const parsed = JSON.parse(lines[lines.length - 1] || "{}");
        settle(parsed as ProbeResult);
      } catch {
        settle({ ok: false, error: "probe produced no parsable output" });
      }
    });
    child.on("error", (err) => settle({ ok: false, error: err.message }));
  });
}
