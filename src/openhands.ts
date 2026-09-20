/**
 * Forgevi — the OpenHands bridge.
 *
 * The engine shell spawns ONE worker process per run
 * (`openhands/worker.py` — the real openhands-sdk agent) and relays its
 * stdout JSON lines into the run journal. Nothing here runs an agent
 * loop, picks tools, or talks to an LLM — OpenHands owns all of that.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface LlmConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface LlmResolution {
  ok: boolean;
  error?: string;
  llm?: LlmConfig;
  /** The NVIDIA NIM lane (NVIDIA_API_KEY) — used when the OpenRouter
   *  free tier's account-wide daily budget is exhausted. */
  nvidia?: LlmConfig;
}

/** The engine's LLM lanes: one env-driven OpenAI-compatible gateway,
 *  plus the NVIDIA NIM failover lane when its key is configured. */
export function resolveLlmConfig(): LlmResolution {
  const env = process.env;
  const apiKey = env.OPENROUTER_API_KEY || undefined;
  const rawModel = env.ENGINE_MODEL || "nvidia/nemotron-3-super-120b-a12b:free";
  if (!apiKey) {
    return { ok: false, error: "OPENROUTER_API_KEY is not set — the engine has no LLM" };
  }
  const bare = rawModel.replace(/^openai\//, "");
  const model = `openai/${bare}`; // litellm gateway form: openai/<model> + base_url
  const nvidiaKey = env.NVIDIA_API_KEY || env.NVIDIA_NIM_API_KEY || undefined;
  const nvidiaBare = (env.NVIDIA_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b").replace(/^openai\//, "");
  return {
    ok: true,
    llm: {
      model,
      apiKey,
      baseUrl: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    },
    ...(nvidiaKey
      ? {
          nvidia: {
            model: `openai/${nvidiaBare}`,
            apiKey: nvidiaKey,
            baseUrl: env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
          },
        }
      : {}),
  };
}

export type OpenHandsEvent =
  | { type: "thinking"; text: string }
  | { type: "message"; text: string }
  | { type: "action"; tool: string; detail?: string }
  | { type: "file"; path: string }
  | { type: "error"; error: string }
  | { type: "finished"; status: "complete" | "incomplete"; summary: string; issues?: string[] };

export interface OpenHandsRunOpts {
  workspace: string;
  prompt: string;
  llm: LlmConfig;
  maxIterations?: number;
  signal: AbortSignal;
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

/** One OpenHands worker process — yields its events, settles honestly. */
export async function* runOpenHands(opts: OpenHandsRunOpts): AsyncGenerator<OpenHandsEvent> {
  const dir = await mkdtemp(path.join(tmpdir(), "forgevi-job-"));
  const jobFile = path.join(dir, "job.json");
  await writeFile(
    jobFile,
    JSON.stringify({
      workspace: opts.workspace,
      prompt: opts.prompt,
      model: opts.llm.model,
      api_key: opts.llm.apiKey,
      ...(opts.llm.baseUrl ? { base_url: opts.llm.baseUrl } : {}),
      max_iterations: opts.maxIterations ?? (Number(process.env.OH_MAX_ITERATIONS || 0) || 500),
      max_output_tokens: Number(process.env.OH_MAX_OUTPUT_TOKENS || 0) || 16384,
    }),
  );

  const child = spawn(pythonBin(), [workerPath(), "--job", jobFile], {
    cwd: engineRoot(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // ── worker output plumbing ─────────────────────────────────────────
  const queue: OpenHandsEvent[] = [];
  let waker: (() => void) | null = null;
  let sawFinished = false;
  let closed = false;
  let exitCode: number | null = null;
  let stderrTail = "";

  const wake = () => waker?.();

  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
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
  });

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

  // ── abort wiring ───────────────────────────────────────────────────
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
    opts.signal.removeEventListener("abort", onAbort);
    if (!sawFinished && !closed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
