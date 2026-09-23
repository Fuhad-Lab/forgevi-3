/**
 * Forgevi — the sandbox abstraction (THE POOL RUNTIME).
 *
 * TWO implementations, ONE interface:
 *   - E2B   : production cloud sandboxes through the KeyPoolBroker —
 *             20 seats/key, >=1s spawn throttle, least-loaded cascade,
 *             bounded queue, 429 telemetry, provider-truth reconcile,
 *             55-min seamless migration, 1-hour hard cap exposure
 *   - local : development sandboxes on engine-local disk (no key needed)
 *
 * The agent's every command, file read and file write flows through here.
 * Boot injection (workspace restore + uploads) is SILENT by law — it never
 * surfaces in the event stream, only in engine stderr on failure.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { KeyPoolBroker, PoolExhaustedError, type Lease } from "./pool/broker.ts";

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxFile {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface BootFile {
  path: string;
  content: string | Buffer;
}

export interface SandboxAdapter {
  readonly kind: "e2b" | "local";
  readonly id: string;
  /** Absolute path inside the sandbox that is the workspace root. */
  readonly cwd: string;
  /** E2B only: the pooled API key that spawned this sandbox (the OpenHands
   *  worker may reconnect with it). Undefined locally. */
  readonly apiKey?: string;
  /** Age of this sandbox in ms (the migration / hard-cap clocks). */
  ageMs(): number;
  /** THE 55-MINUTE MIGRATION: swap onto a fresh sandbox (E2B; local: no-op). */
  migrate(): Promise<void>;

  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** THE IN-VM AGENT LAW: stream a long-running command (the OpenHands
   *  worker executes INSIDE the sandbox; its stdout JSON event lines
   *  flow live through onStdout). */
  execStream(command: string, opts?: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ExecResult>;
  /** E2B only: write a file at an ABSOLUTE sandbox path (the worker
   *  script + job spec land in /opt/forgevi, never the workspace).
   * Local: writes under the workspace root when the path is inside it,
   * else throws (dev engines run the worker on the host). */
  writeVmFile(absPath: string, content: string | Buffer): Promise<void>;
  /** Extend the sandbox's own lifetime (E2B setTimeout; local: no-op) —
   *  a live run holds the machine so it outlives the run. */
  extendTimeout(timeoutMs: number): Promise<void>;
  readTextFile(relPath: string): Promise<string>;
  readBytesFile(relPath: string): Promise<Buffer>;
  /** Write a file — text (string) or binary (Buffer). Creates parent dirs. */
  writeFile(relPath: string, content: string | Buffer): Promise<void>;
  listDir(relPath?: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<SandboxFile[]>;
  removePath(relPath: string): Promise<void>;
  pathExists(relPath: string): Promise<boolean>;

  /** tar.gz of the workspace (minus heavy caches) — snapshot artifact. */
  createSnapshot(): Promise<Buffer>;
  /** Extract a snapshot back into the workspace (silent boot path). */
  restoreSnapshot(tar: Buffer): Promise<void>;
  /** Public URL for a port the workspace serves (E2B) or localhost (local). */
  appUrl(port: number): string | null;
  /** Stop the sandbox (E2B: seat released). Local: no-op. */
  destroy(): Promise<void>;
}

// ── shared helpers ─────────────────────────────────────────────────────

const MAX_EXEC_OUTPUT = 2_000_000; // 2 MB per stream — tool layer truncates further for the model

/** Snapshot excludes: rebuildable caches, never source. */
const SNAPSHOT_EXCLUDES = ["node_modules", ".next", ".cache", "dist", ".turbo", ".npm", ".yarn"];

export function safeRelPath(input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const clean = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.includes("\0") || clean.length > 512) return null;
  if (clean === "." || clean === "..") return null;
  // THE DOTFILE LAW (live-observed 2026-09-21, first E2B-pool run): reject
  // TRAVERSAL (a ".."/"." path COMPONENT) — never dotFILES. The old
  // startsWith(".") check killed every fresh-workspace boot: the scaffold
  // seeds .gitignore, safeRelPath(null)'d it, and the run died at spawn
  // with "path escapes the workspace: .gitignore". Legit dotfiles
  // (.gitignore, .env, .eslintrc, .f3-previews/) stay legal.
  if (clean.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return clean;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_EXEC_OUTPUT) return text;
  const head = text.slice(0, MAX_EXEC_OUTPUT / 2);
  const tail = text.slice(-MAX_EXEC_OUTPUT / 2);
  return `${head}\n… [truncated ${text.length - MAX_EXEC_OUTPUT} chars] …\n${tail}`;
}

// ── local sandbox adapter (development) ────────────────────────────────

export class LocalSandbox implements SandboxAdapter {
  readonly kind = "local" as const;
  readonly id: string;
  readonly cwd: string;
  private readonly bornAt = Date.now();

  constructor(
    private readonly root: string,
    id: string,
  ) {
    this.id = id;
    this.cwd = root;
  }

  ageMs(): number {
    return Date.now() - this.bornAt;
  }

  resolve(rel: string): string {
    const clean = safeRelPath(rel);
    const target = clean === null ? path.resolve(this.root, rel) : path.resolve(this.root, clean);
    if (!target.startsWith(this.root)) throw new Error(`path escapes the workspace: ${rel}`);
    return target;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const cwd = opts.cwd ? path.resolve(this.root, opts.cwd.replace(/^\/+/, "")) : this.root;
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 600_000);
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const kill = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(kill, timeoutMs);
      const onAbort = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_EXEC_OUTPUT * 2) stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < MAX_EXEC_OUTPUT * 2) stderr += d.toString();
      });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: timedOut ? 124 : (code ?? 0),
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          timedOut,
          durationMs: Date.now() - started,
        });
      };
      child.on("close", finish);
      child.on("error", (err) => {
        stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
        finish(null);
      });
    });
  }

  /** Local dev fallback for the in-VM agent lane — same spawn plumbing
   *  with live chunk callbacks (used when the engine runs locally). */
  async execStream(
    command: string,
    opts: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = Math.max(opts.timeoutMs ?? 600_000, 1_000);
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd: this.root });
      let stdoutAll = "";
      let stderrTail = "";
      let timedOut = false;
      let settled = false;
      const kill = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(kill, timeoutMs);
      const onAbort = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdoutAll.length < MAX_EXEC_OUTPUT * 2) stdoutAll += chunk;
        opts.onStdout?.(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        opts.onStderr?.(chunk);
      });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: opts.signal?.aborted ? 130 : timedOut ? 124 : (code ?? 0),
          stdout: truncateOutput(stdoutAll),
          stderr: truncateOutput(stderrTail),
          timedOut,
          durationMs: Date.now() - started,
        });
      };
      child.on("close", finish);
      child.on("error", (err) => {
        stderrTail += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
        finish(null);
      });
    });
  }

  async readTextFile(relPath: string): Promise<string> {
    return await readFile(this.resolve(relPath), "utf8");
  }

  async writeVmFile(absPath: string, content: string | Buffer): Promise<void> {
    // Local dev engines run the worker on the host — only workspace paths
    // are meaningful here; /opt/forgevi writes are E2B-only by design.
    const target = path.resolve(absPath);
    if (!target.startsWith(path.resolve(this.root))) {
      throw new Error(`writeVmFile outside the local workspace: ${absPath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async extendTimeout(_timeoutMs: number): Promise<void> {
    // Local workspaces have no platform lifetime — a no-op by design.
  }

  async readBytesFile(relPath: string): Promise<Buffer> {
    return await readFile(this.resolve(relPath));
  }

  async writeFile(relPath: string, content: string | Buffer): Promise<void> {
    const target = this.resolve(relPath);
    await mkdir(path.dirname(target), { recursive: true });
    if (typeof content === "string") {
      await writeFile(target, content, "utf8");
    } else {
      await writeFile(target, content);
    }
  }

  async listDir(relPath = "", opts: { recursive?: boolean; maxEntries?: number } = {}): Promise<SandboxFile[]> {
    const start = relPath ? this.resolve(relPath) : this.root;
    const maxEntries = opts.maxEntries ?? 2000;
    const out: SandboxFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (out.length >= maxEntries) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= maxEntries) return;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push({ path: childRel, type: "dir" });
          if (opts.recursive) await walk(path.join(dir, entry.name), childRel);
        } else {
          let size: number | undefined;
          try {
            size = (await stat(path.join(dir, entry.name))).size;
          } catch {
            /* raced away */
          }
          out.push({ path: childRel, type: "file", size });
        }
      }
    };
    try {
      await walk(start, relPath.replace(/^\/+/, ""));
    } catch {
      /* missing dir → empty listing (honest empty, not an error) */
    }
    return out;
  }

  async removePath(relPath: string): Promise<void> {
    await rm(this.resolve(relPath), { recursive: true, force: true });
  }

  async pathExists(relPath: string): Promise<boolean> {
    try {
      await stat(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async createSnapshot(): Promise<Buffer> {
    const excludeArgs = SNAPSHOT_EXCLUDES.flatMap((e) => ["--exclude", e]);
    const proc = spawn("tar", ["-czf", "-", ...excludeArgs, "-C", this.root, "."]);
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    return await new Promise<Buffer>((resolve, reject) => {
      proc.stdout.on("data", (d: Buffer) => {
        total += d.length;
        if (total > 500 * 1024 * 1024) {
          proc.kill("SIGKILL");
          reject(new Error("snapshot exceeds 500 MB"));
          return;
        }
        chunks.push(d);
      });
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`snapshot tar failed (${code}): ${stderr.slice(0, 300)}`));
      });
      proc.on("error", reject);
    });
  }

  async restoreSnapshot(tar: Buffer): Promise<void> {
    const tmp = ".f3-restore.tar.gz";
    await writeFile(this.resolve(tmp), tar);
    try {
      const res = await this.exec(`tar -xzf ${tmp} -C . && rm -f ${tmp}`, { timeoutMs: 120_000 });
      if (res.exitCode !== 0) throw new Error(`restore failed: ${res.stderr.slice(0, 300)}`);
    } finally {
      await rm(this.resolve(tmp), { force: true });
    }
  }

  appUrl(port: number): string | null {
    return `http://127.0.0.1:${port}`;
  }

  async destroy(): Promise<void> {
    /* local sandboxes persist on disk — that IS their persistence */
  }

  async migrate(): Promise<void> {
    /* local sandboxes never expire — migration is an E2B-seat law */
  }
}

// ── THE E2B KEY POOL (module singleton — the broker is the one
//    serialization point the 1-spawn/second law demands) ─────────────────

export let e2bBroker = new KeyPoolBroker({
  keys: config.e2bKeys,
  maxSlotsPerKey: config.e2bSeatsPerKey,
  spawnThrottleMs: config.e2bSpawnThrottleMs,
  queueMax: config.e2bSpawnQueueMax,
});

/** Rebuild the broker after a config push (the deploy surface calls this). */
export function reloadE2BBroker(): void {
  e2bBroker = new KeyPoolBroker({
    keys: config.e2bKeys,
    maxSlotsPerKey: config.e2bSeatsPerKey,
    spawnThrottleMs: config.e2bSpawnThrottleMs,
    queueMax: config.e2bSpawnQueueMax,
  });
}

// THE TEMPLATE-ACCESS LAW (2026-09-22 evening — the autopsy correction):
// the 4 pooled keys span 4 DIFFERENT E2B accounts, and the forgevi
// template is PRIVATE — only its owner account can spawn it. Every other
// key fails with "404: template … not found" / "403: You don't have
// access to this sandbox template" on EVERY spawn attempt, poisoning the
// cascade (and masking the owner key's real error — the live incident's
// "last error: 404" hid whichever failure the owner key actually hit).
// A key whose spawn fails with one of these signatures is BLOCKED from
// further picks until the broker rebuilds (config push / restart).
const TEMPLATE_ACCESS_FAILURE =
  /(?:\b40[34]\b[^\n]{0,200}\btemplate\b)|(?:\btemplate\b[^\n]{0,200}\b40[34]\b)|(?:\btemplate\b[^\n]{0,80}\bnot found\b)|(?:don'?t have access to this sandbox template)/i;

/** Spawn through the pool — acquire → create → rollback on failure.
 * THE AGGREGATE-ERROR LAW: the exhaustion message reports EVERY key's
 * failure (the live incident showed only the LAST error — the owner
 * key's real failure was invisible behind the no-access keys' 404s). */
async function spawnPooledSandbox(template: string | undefined): Promise<{ sandbox: E2BSandbox; lease: Lease }> {
  const { Sandbox } = (await import("e2b")) as {
    Sandbox: { create: (opts: Record<string, unknown>) => Promise<E2BSandbox> };
  };
  const failures: Array<{ key: string; error: string }> = [];
  // cascade attempts: each acquire() may hand a different (least-loaded) key
  for (let attempt = 0; attempt < Math.max(1, e2bBroker.keyCount); attempt++) {
    const lease = await e2bBroker.acquire();
    try {
      const sandbox = await Sandbox.create({
        ...(template ? { template } : {}),
        apiKey: lease.key, // THE POOL: this spawn rides the leased key
        timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
        envs: { FORGEVI: "3" },
      });
      return { sandbox, lease };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ key: lease.keyLabel, error: message.slice(0, 200) });
      if (/429|rate.?limit|too many|capacity/i.test(message)) {
        lease.report429(); // telemetry + cooldown — the cascade moves on
      } else if (TEMPLATE_ACCESS_FAILURE.test(message)) {
        // this key's account cannot spawn the configured (private)
        // template — stop letting it poison every cascade round
        lease.reportBlocked(`cannot spawn the configured template (${message.slice(0, 120)})`);
      }
      lease.release(); // rollback on failed acquisition — the seat returns
    }
  }
  const detail = failures.map((f) => `${f.key}: ${f.error}`).join(" | ");
  throw new PoolExhaustedError(
    `E2B spawn failed on every pooled key — ${failures.length} attempt(s) failed: ${detail || "no attempts recorded"}`,
  );
}

// ── E2B sandbox adapter (production) ───────────────────────────────────

/** The e2b CommandHandle (background run) — the subset the engine uses. */
type E2BCommandHandle = {
  kill: (opts?: Record<string, unknown>) => Promise<unknown>;
  wait: () => Promise<{ exitCode?: number; error?: string }>;
};

type E2BSandbox = {
  sandboxId: string;
  commands: {
    /** Overloaded like the real SDK: `background: true` hands back a
     *  handle (with wait/kill); every other call settles with the
     *  command's result object. The background overload comes FIRST so
     *  a literal `background: true` in the opts resolves to the handle. */
    run: {
      (cmd: string, opts: Record<string, unknown> & { background: true }): Promise<E2BCommandHandle>;
      (cmd: string, opts?: Record<string, unknown>): Promise<{
        exitCode: number;
        error?: string;
        stdout: string;
        stderr: string;
      }>;
    };
  };
  files: {
    read: (p: string, opts?: Record<string, unknown>) => Promise<string | Uint8Array>;
    write: (entries: Array<{ path: string; data: string | ArrayBuffer }>, opts?: Record<string, unknown>) => Promise<unknown>;
    list: (p: string, opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    remove: (p: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  getHost: (port: number) => string;
  kill: (opts?: Record<string, unknown>) => Promise<unknown>;
  setTimeout: (timeoutMs: number, opts?: Record<string, unknown>) => Promise<unknown>;
};

const E2B_WORKSPACE = "/workspace";
// THE MIGRATION-RACE LAW (2026-09-23): the seamless migration fires at
// e2bMigrateAtMs (default 55 min). The E2B sandbox timeout must sit
// comfortably PAST that mark so the swap always wins the race — 59 min
// gives the migration a 4-minute runway (snapshot → fresh spawn → restore
// → swap → kill old). At 55/55 the server-side kill raced the swap.
const E2B_SANDBOX_TIMEOUT_MS = 59 * 60_000;

export class E2BSandboxAdapter implements SandboxAdapter {
  readonly kind = "e2b" as const;
  readonly id: string;
  readonly cwd = E2B_WORKSPACE;
  private readonly bornAt = Date.now();
  /** The pooled E2B API key that spawned this sandbox — the OpenHands
   *  worker reconnects to the SAME sandbox (Sandbox.connect) with it, so
   *  the agent's terminal/file tools execute INSIDE the microVM while the
   *  engine's studio surface (exec/files/preview) shares the very same
   *  sandbox through this adapter. Swapped on migration (fresh sandbox,
   *  fresh lease). */
  apiKey: string;

  private constructor(
    private sandbox: E2BSandbox,
    id: string,
    private lease: Lease | null,
    apiKey: string,
  ) {
    this.id = id;
    this.apiKey = apiKey;
  }

  static async create(template: string | undefined): Promise<E2BSandboxAdapter> {
    const { sandbox, lease } = await spawnPooledSandbox(template);
    // boot shape: a real, WRITABLE /workspace directory (silent — never in
    // the stream). THE BOOT-CWD LAW (live-observed 2026-09-21, first
    // E2B-pool run): the E2B SDK validates `cwd` BEFORE executing the
    // command — on a fresh sandbox /workspace does not exist yet, so a
    // boot command carrying cwd=/workspace is rejected with
    // "[invalid_argument] cwd '/workspace' does not exist" and the whole
    // run dies at spawn. The mkdir therefore runs on the sandbox's DEFAULT
    // cwd (no cwd option). THE ROOT-PERMISSION LAW (same session): the
    // DEFAULT E2B template ships a read-only / owned by root — plain
    // mkdir fails with EACCES. The default image's `user` carries
    // passwordless sudo, so the fallback sudo-creates and chowns
    // /workspace; the baked forgevi template (root-owned RUN mkdir) takes
    // the plain path. Every later command may use cwd=/workspace because
    // this one created it.
    let bootOk = false;
    try {
      const boot = await sandbox.commands.run(
        `mkdir -p ${E2B_WORKSPACE} 2>/dev/null || sudo -n mkdir -p ${E2B_WORKSPACE} && sudo -n chown user:user ${E2B_WORKSPACE}; test -w ${E2B_WORKSPACE}`,
        { timeoutMs: 30_000 },
      );
      bootOk = boot.exitCode === 0;
    } catch (err) {
      // THE HONEST-EXIT LAW: the SDK raises on non-zero exits — the
      // writability test failing surfaces here, not as a return code.
      const thrown = err as { exitCode?: number };
      bootOk = typeof thrown.exitCode === "number" && thrown.exitCode === 0;
    }
    if (!bootOk) {
      await sandbox.kill().catch(() => undefined);
      lease.release();
      throw new Error(`the E2B sandbox has no writable ${E2B_WORKSPACE}`);
    }
    return new E2BSandboxAdapter(sandbox, sandbox.sandboxId, lease, lease.key);
  }

  ageMs(): number {
    return Date.now() - this.bornAt;
  }

  private sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  /**
   * THE 55-MINUTE SEAMLESS MIGRATION — swap this adapter's handle onto a
   * fresh sandbox (snapshot → spawn → restore → swap → kill old). The
   * run/viewer never notices; the seat accounting migrates with it.
   */
  async migrate(): Promise<void> {
    const tar = await this.createSnapshot();
    const { sandbox: fresh, lease } = await spawnPooledSandbox(config.e2bTemplate);
    const old = this.sandbox;
    const oldLease = this.lease;
    this.sandbox = fresh;
    this.lease = lease;
    this.apiKey = lease.key;
    // restore the old workspace into the fresh VM (silent)
    const adapter = new E2BSandboxAdapter(fresh, fresh.sandboxId, null, lease.key); // temp holder for restore ops
    try {
      await adapter.restoreSnapshot(tar);
    } finally {
      await old.kill().catch(() => undefined);
      oldLease?.release();
    }
  }

  resolve(relPath: string): string {
    const clean = safeRelPath(relPath);
    if (clean === null) throw new Error(`path escapes the workspace: ${relPath}`);
    return `${E2B_WORKSPACE}/${clean}`;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 600_000);
    try {
      const res = await this.sandbox.commands.run(command, {
        cwd: E2B_WORKSPACE,
        timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const timedOut = /timeout/i.test(res.error ?? "");
      return {
        exitCode: timedOut ? 124 : res.exitCode,
        stdout: truncateOutput(res.stdout ?? ""),
        stderr: truncateOutput(res.stderr ?? (res.error ? String(res.error) : "")),
        timedOut,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      // THE HONEST-EXIT LAW (live-observed 2026-09-21): the e2b SDK v2
      // REJECTS commands.run on ANY non-zero exit (CommandExitError carries
      // exitCode/stdout/stderr). A legitimate failure (npm test red, a
      // build error) must surface as its REAL exit code + output — mapping
      // every throw to "timeout 124, no output" lied to the studio
      // terminal and blinded the agent's own verification commands.
      const thrown = err as { exitCode?: number; stdout?: string; stderr?: string; error?: string };
      if (typeof thrown.exitCode === "number") {
        return {
          exitCode: thrown.exitCode,
          stdout: truncateOutput(thrown.stdout ?? ""),
          stderr: truncateOutput(thrown.stderr ?? (thrown.error ? String(thrown.error) : "")),
          timedOut: false,
          durationMs: Date.now() - started,
        };
      }
      return {
        exitCode: 124,
        stdout: "",
        stderr: `e2b exec error: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: opts.signal?.aborted === true,
        durationMs: Date.now() - started,
      };
    }
  }

  /** THE IN-VM AGENT LAW: stream a long-running command's output live
   *  (the OpenHands worker executes INSIDE this microVM; its stdout JSON
   *  event lines flow through onStdout chunk-by-chunk). Settles with the
   *  command's REAL exit code — a non-zero exit is a fact, not an error. */
  async execStream(
    command: string,
    opts: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = Math.max(opts.timeoutMs ?? 600_000, 1_000);
    let stdoutAll = "";
    let stderrTail = "";
    try {
      const handle = await this.sandbox.commands.run(command, {
        cwd: E2B_WORKSPACE,
        timeoutMs,
        background: true,
        onStdout: (chunk: string) => {
          if (stdoutAll.length < MAX_EXEC_OUTPUT * 2) stdoutAll += chunk;
          opts.onStdout?.(chunk);
        },
        onStderr: (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
          opts.onStderr?.(chunk);
        },
      });
      // abort wiring — kill the in-VM command when the run is aborted
      const onAbort = () => {
        void handle.kill().catch(() => undefined);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let res: { exitCode?: number; error?: string };
      try {
        res = await handle.wait();
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const timedOut = /timeout/i.test(res.error ?? "");
      return {
        exitCode: opts.signal?.aborted ? 130 : timedOut ? 124 : (res.exitCode ?? 0),
        stdout: truncateOutput(stdoutAll),
        stderr: truncateOutput(stderrTail),
        timedOut,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const thrown = err as { exitCode?: number };
      if (opts.signal?.aborted) {
        return {
          exitCode: 130,
          stdout: truncateOutput(stdoutAll),
          stderr: truncateOutput(stderrTail),
          timedOut: false,
          durationMs: Date.now() - started,
        };
      }
      if (typeof thrown.exitCode === "number") {
        return {
          exitCode: thrown.exitCode,
          stdout: truncateOutput(stdoutAll),
          stderr: truncateOutput(stderrTail),
          timedOut: false,
          durationMs: Date.now() - started,
        };
      }
      return {
        exitCode: 124,
        stdout: truncateOutput(stdoutAll),
        stderr: truncateOutput((stderrTail + ` e2b execStream error: ${err instanceof Error ? err.message : String(err)}`).slice(-4000)),
        timedOut: false,
        durationMs: Date.now() - started,
      };
    }
  }

  async readTextFile(relPath: string): Promise<string> {
    const data = await this.sandbox.files.read(this.resolve(relPath), { format: "text" });
    return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  }

  async readBytesFile(relPath: string): Promise<Buffer> {
    const data = await this.sandbox.files.read(this.resolve(relPath), { format: "bytes" });
    return Buffer.from(data as Uint8Array);
  }

  async writeFile(relPath: string, content: string | Buffer): Promise<void> {
    const data: string | ArrayBuffer =
      typeof content === "string"
        ? content
        : (new Uint8Array(content).buffer as ArrayBuffer);
    await this.sandbox.files.write([{ path: this.resolve(relPath), data }]);
  }

  async writeVmFile(absPath: string, content: string | Buffer): Promise<void> {
    // Absolute-path write (the in-VM worker script + job spec live in
    // /opt/forgevi — never inside the user's workspace).
    const data: string | ArrayBuffer =
      typeof content === "string"
        ? content
        : (new Uint8Array(content).buffer as ArrayBuffer);
    if (!path.posix.isAbsolute(absPath) || absPath.includes("..")) {
      throw new Error(`writeVmFile requires a clean absolute path: ${absPath}`);
    }
    await this.sandbox.files.write([{ path: absPath, data }]);
  }

  async extendTimeout(timeoutMs: number): Promise<void> {
    // Keep the machine alive through a live run (the hard cap still
    // bounds it — the holders law defers the evict while held).
    await this.sandbox.setTimeout(Math.max(60_000, timeoutMs));
  }

  async listDir(relPath = "", opts: { recursive?: boolean; maxEntries?: number } = {}): Promise<SandboxFile[]> {
    const start = relPath ? this.resolve(relPath) : E2B_WORKSPACE;
    const maxEntries = opts.maxEntries ?? 2000;
    const out: SandboxFile[] = [];
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (out.length >= maxEntries) return;
      if (!opts.recursive && depth > 0) return;
      let entries: Array<Record<string, unknown>>;
      try {
        entries = await this.sandbox.files.list(dir);
      } catch {
        return; // missing dir → honest empty
      }
      for (const entry of entries) {
        if (out.length >= maxEntries) return;
        const name = typeof entry["name"] === "string" ? entry["name"] : String(entry["path"] ?? "").split("/").pop()!;
        const childRel = rel ? `${rel}/${name}` : name;
        // THE SDK-TYPE LAW (live-observed 2026-09-23): e2b SDK v2.51's
        // files.list returns {name, path, type: FileType, size: bigint}
        // where FileType's enum values are "file" | "dir" | "symlink" —
        // "dir", NOT "directory". Matching only "directory" misclassified
        // every directory as a file, so the workspace tree never descended
        // into uploads/ and the studio's Files tab could not see uploaded
        // files. BigInt sizes convert to Number for the JSON relay.
        const rawType = entry["type"];
        const isDir =
          rawType === "dir" ||
          rawType === "directory" ||
          entry["isDirectory"] === true ||
          entry["isDir"] === true ||
          entry["fileType"] === "directory";
        if (isDir) {
          out.push({ path: childRel, type: "dir" });
          if (opts.recursive) await walk(`${dir}/${name}`, childRel, depth + 1);
        } else {
          const rawSize = entry["size"];
          const size = typeof rawSize === "number" ? rawSize : typeof rawSize === "bigint" ? Number(rawSize) : undefined;
          out.push({
            path: childRel,
            type: "file",
            ...(size !== undefined ? { size } : {}),
          });
        }
      }
    };
    await walk(start, relPath.replace(/^\/+/, ""), 0);
    return out;
  }

  async removePath(relPath: string): Promise<void> {
    try {
      await this.sandbox.files.remove(this.resolve(relPath));
    } catch {
      /* already gone */
    }
  }

  async pathExists(relPath: string): Promise<boolean> {
    try {
      const abs = this.resolve(relPath);
      const entries = await this.sandbox.files.list(path.posix.dirname(abs));
      const name = path.posix.basename(abs);
      return entries.some(
        (e) => e["name"] === name || String(e["path"] ?? "").split("/").pop() === name,
      );
    } catch {
      return false;
    }
  }

  async createSnapshot(): Promise<Buffer> {
    const excludeArgs = SNAPSHOT_EXCLUDES.flatMap((e) => ["--exclude", `./${e}`, "--exclude", e]);
    const res = await this.sandbox.commands.run(
      `cd ${E2B_WORKSPACE} && tar -czf /tmp/f3-snapshot.tar.gz ${excludeArgs.join(" ")} .`,
      { cwd: E2B_WORKSPACE, timeoutMs: 300_000 },
    );
    if (res.exitCode !== 0) throw new Error(`snapshot tar failed: ${res.stderr.slice(0, 300)}`);
    const bytes = await this.sandbox.files.read("/tmp/f3-snapshot.tar.gz", { format: "bytes" });
    await this.sandbox.commands.run("rm -f /tmp/f3-snapshot.tar.gz", { timeoutMs: 15_000 }).catch(() => undefined);
    return Buffer.from(bytes as Uint8Array);
  }

  async restoreSnapshot(tar: Buffer): Promise<void> {
    await this.sandbox.files.write([{ path: "/tmp/f3-restore.tar.gz", data: tar.toString("base64") }]);
    const res = await this.sandbox.commands.run(
      "base64 -d /tmp/f3-restore.tar.gz > /tmp/f3-restore.bin.tar.gz && tar -xzf /tmp/f3-restore.bin.tar.gz -C /workspace && rm -f /tmp/f3-restore.tar.gz /tmp/f3-restore.bin.tar.gz",
      { cwd: E2B_WORKSPACE, timeoutMs: 300_000 },
    );
    if (res.exitCode !== 0) throw new Error(`restore failed: ${res.stderr.slice(0, 300)}`);
  }

  appUrl(port: number): string | null {
    try {
      // THE SCHEME LAW (2026-09-22): the SDK's getHost returns the bare
      // host ("4171-<id>.e2b.app") — the engine's `public` verdict and the
      // studio's `new URL(appUrl)` both require the scheme. E2B's public
      // port URLs serve https (the SDK's own URL builders prefix it).
      const host = this.sandbox.getHost(port);
      return host.startsWith("http") ? host : `https://${host}`;
    } catch {
      return null;
    }
  }

  async destroy(): Promise<void> {
    await this.sandbox.kill().catch(() => undefined);
    this.lease?.release(); // THE SEAT LAW: a destroyed sandbox frees its seat
    this.lease = null;
  }
}

// ── factory ────────────────────────────────────────────────────────────

/** The local-disk sandbox (the engine container's own filesystem). */
async function createLocalSandbox(workspaceKey: string): Promise<LocalSandbox> {
  const dir = path.resolve(process.cwd(), "workspaces", workspaceKey.replace(/[^a-zA-Z0-9._-]/g, "_"));
  await mkdir(dir, { recursive: true });
  return new LocalSandbox(dir, `local-${workspaceKey}`);
}

// THE DEGRADED-BUILD LAW (user fix 2026-09-22, live-observed: the E2B
// account died mid-day — first the custom template 404'd, then every key
// returned "401 Invalid auth provider token", and every build died with
// "E2B spawn failed on every pooled key"). A build that runs on the
// engine's local disk — full agent, real files, B2 persistence, the
// Redis journal — beats a build that never starts. The preview honestly
// reports public:false (the dev server's 127.0.0.1 is not browser-
// reachable) until E2B is alive again. PERMANENT failure signatures
// only: dead keys (401/403) or a dead template (404) — transient 429 /
// quota / capacity errors keep throwing (the queue handles those).
const E2B_PERMANENT_FAILURE =
  /401|403|invalid auth|unauthorized|forbidden|template[^.]{0,60}not found|not found[^.]{0,60}template/i;

export async function createSandbox(workspaceKey: string): Promise<SandboxAdapter> {
  if (config.e2bKeys.length > 0) {
    try {
      return await E2BSandboxAdapter.create(config.e2bTemplate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (E2B_PERMANENT_FAILURE.test(message)) {
        console.warn(
          `[sandbox] E2B is unusable (${message.slice(0, 160)}) — THE DEGRADED-BUILD LAW: running on the local-disk sandbox (no public preview until E2B recovers)`,
        );
        return await createLocalSandbox(workspaceKey);
      }
      throw err;
    }
  }
  return createLocalSandbox(workspaceKey);
}
