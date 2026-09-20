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
  /** Age of this sandbox in ms (the migration / hard-cap clocks). */
  ageMs(): number;
  /** THE 55-MINUTE MIGRATION: swap onto a fresh sandbox (E2B; local: no-op). */
  migrate(): Promise<void>;

  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
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
  const clean = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.includes("..") || clean.includes("\0")) return null;
  if (clean.startsWith(".")) return null;
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

  async readTextFile(relPath: string): Promise<string> {
    return await readFile(this.resolve(relPath), "utf8");
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

/** Spawn through the pool — acquire → create → rollback on failure. */
async function spawnPooledSandbox(template: string | undefined): Promise<{ sandbox: E2BSandbox; lease: Lease }> {
  const { Sandbox } = (await import("e2b")) as {
    Sandbox: { create: (opts: Record<string, unknown>) => Promise<E2BSandbox> };
  };
  let lastError: unknown = null;
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
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/429|rate.?limit|too many|capacity/i.test(message)) {
        lease.report429(); // telemetry + cooldown — the cascade moves on
      }
      lease.release(); // rollback on failed acquisition — the seat returns
    }
  }
  throw new PoolExhaustedError(
    `E2B spawn failed on every pooled key — last error: ${lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError)}`,
  );
}

// ── E2B sandbox adapter (production) ───────────────────────────────────

type E2BSandbox = {
  sandboxId: string;
  commands: {
    run: (cmd: string, opts?: Record<string, unknown>) => Promise<{
      exitCode: number;
      error?: string;
      stdout: string;
      stderr: string;
    }>;
  };
  files: {
    read: (p: string, opts?: Record<string, unknown>) => Promise<string | Uint8Array>;
    write: (entries: Array<{ path: string; data: string | ArrayBuffer }>, opts?: Record<string, unknown>) => Promise<unknown>;
    list: (p: string, opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    remove: (p: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };
  getHost: (port: number) => string;
  kill: (opts?: Record<string, unknown>) => Promise<unknown>;
};

const E2B_WORKSPACE = "/workspace";
const E2B_SANDBOX_TIMEOUT_MS = 55 * 60_000; // soft window — the hard cap law lives in workspace-service

export class E2BSandboxAdapter implements SandboxAdapter {
  readonly kind = "e2b" as const;
  readonly id: string;
  readonly cwd = E2B_WORKSPACE;
  private readonly bornAt = Date.now();

  private constructor(
    private sandbox: E2BSandbox,
    id: string,
    private lease: Lease | null,
  ) {
    this.id = id;
  }

  static async create(template: string | undefined): Promise<E2BSandboxAdapter> {
    const { sandbox, lease } = await spawnPooledSandbox(template);
    // boot shape: a real /workspace directory (silent — never in the stream)
    await sandbox.commands.run(`mkdir -p ${E2B_WORKSPACE} && cd ${E2B_WORKSPACE} && pwd`, {
      cwd: E2B_WORKSPACE,
      timeoutMs: 30_000,
    });
    return new E2BSandboxAdapter(sandbox, sandbox.sandboxId, lease);
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
    // restore the old workspace into the fresh VM (silent)
    const adapter = new E2BSandboxAdapter(fresh, fresh.sandboxId, null); // temp holder for restore ops
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
      return {
        exitCode: 124,
        stdout: "",
        stderr: `e2b exec error: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: opts.signal?.aborted === true,
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
        const isDir = entry["isDirectory"] === true || entry["isDir"] === true || entry["type"] === "directory" || entry["fileType"] === "directory";
        if (isDir) {
          out.push({ path: childRel, type: "dir" });
          if (opts.recursive) await walk(`${dir}/${name}`, childRel, depth + 1);
        } else {
          out.push({
            path: childRel,
            type: "file",
            ...(typeof entry["size"] === "number" ? { size: entry["size"] } : {}),
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
      return this.sandbox.getHost(port);
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

export async function createSandbox(workspaceKey: string): Promise<SandboxAdapter> {
  if (config.e2bKeys.length > 0) {
    return await E2BSandboxAdapter.create(config.e2bTemplate);
  }
  const dir = path.resolve(process.cwd(), "workspaces", workspaceKey.replace(/[^a-zA-Z0-9._-]/g, "_"));
  await mkdir(dir, { recursive: true });
  return new LocalSandbox(dir, `local-${workspaceKey}`);
}
