/**
 * Forgevi — the project workspace service (the studio surface).
 *
 * The studio's Files tab, Terminal and Preview operate on the PROJECT's
 * workspace — not on a run. A run is transient; the workspace persists:
 *   - local-disk: `workspaces/<projectId>/` — the SAME directory a run
 *     boots (the run's workspaceKey IS the projectId), so studio reads
 *     see exactly what the agent wrote, live and after the run.
 *   - E2B: a lazily-created project sandbox restored from the persisted
 *     snapshot, evicted (persist + destroy) after the idle TTL.
 *
 * THE LIFECYCLE LAWS (ported from e2b_backblaze/pool/runtime.py):
 *   - 5-minute idle reaper → persist workspace → destroy VM → seat freed
 *   - DATA-SAFETY LAW: a failed B2 upload keeps the VM alive — never
 *     destroy work you haven't saved (the eviction retries next touch)
 *   - 55-minute seamless migration → fresh VM, in-place handle swap
 *   - 1-hour hard cap → persist + destroy + evict (rehydrated on demand)
 *
 * These routes are guarded by the relay key (the edge relay verifies
 * project ownership BEFORE dialing; the engine trusts the relay). The
 * projectId is not a capability — the guard is mandatory.
 */

import { config } from "../config.ts";
import { createSandbox, safeRelPath, type SandboxAdapter, type ExecResult, type SandboxFile } from "../e2b-backblaze/sandbox.ts";
import { persistWorkspace } from "../e2b-backblaze/template.ts";
import { createStorage } from "../e2b-backblaze/storage.ts";

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Validate a project id (the relay sends UUIDs — charset-hardened anyway). */
export function validProjectId(input: unknown): string | null {
  return typeof input === "string" && PROJECT_ID_RE.test(input) ? input : null;
}

/** Studio-safe relative path: dotfiles ALLOWED (screenshots live under
 *  .f3-previews/, settings under .gitignore-style names) — traversal blocked. */
export function studioSafePath(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const clean = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.includes("..") || clean.includes("\0") || clean.length > 512) return null;
  return clean;
}

// ── project sandbox registry ───────────────────────────────────────────

interface ProjectEntry {
  sandbox: SandboxAdapter;
  lastUsedAt: number;
  evictTimer: NodeJS.Timeout | null;
  migrateTimer: NodeJS.Timeout | null;
  hardCapTimer: NodeJS.Timeout | null;
  /** In-flight eviction/migration guard — one lifecycle op at a time. */
  busy: boolean;
}

const projects = new Map<string, ProjectEntry>();

function clearLifecycleTimers(entry: ProjectEntry): void {
  if (entry.evictTimer) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }
  if (entry.migrateTimer) {
    clearTimeout(entry.migrateTimer);
    entry.migrateTimer = null;
  }
  if (entry.hardCapTimer) {
    clearTimeout(entry.hardCapTimer);
    entry.hardCapTimer = null;
  }
}

function touch(entry: ProjectEntry): void {
  entry.lastUsedAt = Date.now();
  if (entry.evictTimer) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }
  if (entry.sandbox.kind === "e2b") {
    // THE 5-MINUTE IDLE REAPER (+1s grace so the timer never races the TTL)
    entry.evictTimer = setTimeout(() => void evict(entry.sandbox.id), config.e2bIdleTtlMs + 1_000);
    entry.evictTimer.unref?.();
  }
}

/** THE 5-MINUTE IDLE REAPER — persist → destroy → seat freed. */
async function evict(sandboxId: string): Promise<void> {
  for (const [pid, entry] of projects) {
    if (entry.sandbox.id !== sandboxId) continue;
    if (entry.busy) {
      // a migration is in flight — re-arm the reaper for after it
      entry.evictTimer = setTimeout(() => void evict(sandboxId), 30_000);
      entry.evictTimer.unref?.();
      return;
    }
    entry.busy = true;
    clearLifecycleTimers(entry);
    try {
      await persistWorkspace({ sandbox: entry.sandbox, storage: createStorage(), workspaceKey: pid });
    } catch (err) {
      // THE DATA-SAFETY LAW: a failed B2 upload keeps the VM alive —
      // never destroy work you haven't saved. Retry at the next touch.
      console.error(
        `[reaper ${pid}] persist failed — the sandbox stays ALIVE (data-safety law): ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      );
      entry.busy = false;
      touch(entry);
      return;
    }
    projects.delete(pid);
    await entry.sandbox.destroy().catch(() => undefined);
    entry.busy = false;
    return;
  }
}

/** Arm the age-based lifecycle clocks on a fresh E2B entry. */
function armLifecycle(pid: string, entry: ProjectEntry): void {
  if (entry.sandbox.kind !== "e2b") return;
  // THE 55-MINUTE SEAMLESS MIGRATION — a fresh VM takes over before the
  // hard cap; the handle swaps in place, the viewer never notices.
  const migrateIn = Math.max(60_000, config.e2bMigrateAtMs - entry.sandbox.ageMs());
  entry.migrateTimer = setTimeout(() => void migrate(pid), migrateIn);
  entry.migrateTimer.unref?.();
  // THE 1-HOUR HARD CAP — persist + destroy + evict (rehydrated on demand).
  const hardCapIn = Math.max(90_000, config.e2bHardCapMs - entry.sandbox.ageMs());
  entry.hardCapTimer = setTimeout(() => void evict(entry.sandbox.id), hardCapIn);
  entry.hardCapTimer.unref?.();
}

/** The 55-minute migration — swap the entry's sandbox onto a fresh VM. */
async function migrate(pid: string): Promise<void> {
  const entry = projects.get(pid);
  if (!entry || entry.busy) return;
  entry.busy = true;
  entry.migrateTimer = null;
  try {
    await entry.sandbox.migrate();
    console.error(`[migrate ${pid}] sandbox swapped onto a fresh microVM (seamless — age reset)`);
    // re-arm the clocks against the fresh sandbox
    armLifecycle(pid, entry);
    entry.busy = false;
  } catch (err) {
    console.error(
      `[migrate ${pid}] failed — keeping the current sandbox, hard cap still armed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
    );
    entry.busy = false;
    // retry the migration once after 2 minutes; the hard cap still guards
    entry.migrateTimer = setTimeout(() => void migrate(pid), 2 * 60_000);
    entry.migrateTimer.unref?.();
  }
}

/**
 * Get (or lazily create) the project's workspace sandbox. Local-disk is
 * instant (the run and the studio share the directory). E2B restores the
 * persisted snapshot on first touch.
 */
export async function getProjectSandbox(projectId: string): Promise<SandboxAdapter> {
  const existing = projects.get(projectId);
  if (existing) {
    touch(existing);
    return existing.sandbox;
  }
  const sandbox = await createSandbox(projectId);
  // E2B sandboxes are born empty — restore the project snapshot (silent law)
  if (sandbox.kind === "e2b") {
    const storage = createStorage();
    const tar = await storage.loadSnapshot(projectId).catch(() => null);
    if (tar && tar.length > 0) {
      await sandbox.restoreSnapshot(tar).catch(() => undefined);
    }
  }
  const entry: ProjectEntry = {
    sandbox,
    lastUsedAt: Date.now(),
    evictTimer: null,
    migrateTimer: null,
    hardCapTimer: null,
    busy: false,
  };
  projects.set(projectId, entry);
  touch(entry);
  armLifecycle(projectId, entry);
  return sandbox;
}

/** The live registry (the /e2b/pool dashboard's session list). */
export function projectSessions(): Array<{ projectId: string; kind: "e2b" | "local"; sandboxId: string; lastUsedAt: number; ageMs: number; idleForMs: number }> {
  const now = Date.now();
  return [...projects.entries()].map(([projectId, entry]) => ({
    projectId,
    kind: entry.sandbox.kind,
    sandboxId: entry.sandbox.id,
    lastUsedAt: entry.lastUsedAt,
    ageMs: entry.sandbox.ageMs(),
    idleForMs: now - entry.lastUsedAt,
  }));
}

// ── studio operations ──────────────────────────────────────────────────

export interface FileReadResult {
  path: string;
  content: string;
  encoding: "text" | "base64";
  bytes: number;
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonc", "json5", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "css", "scss", "sass", "less", "html", "htm", "xml", "svg", "yaml", "yml", "toml", "ini",
  "cfg", "conf", "env", "gitignore", "gitattributes", "sh", "bash", "zsh", "fish", "sql",
  "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs", "php", "lua",
  "vue", "svelte", "astro", "graphql", "gql", "prisma", "lock", "csv", "tsv", "log", "diff", "patch",
]);

function isTextPath(p: string): boolean {
  const name = p.split("/").pop() ?? "";
  if (!name.includes(".")) return true; // README, LICENSE, Makefile…
  const ext = name.split(".").pop()!.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/** List the project workspace tree (files + dirs, recursive, bounded). */
export async function projectFiles(projectId: string): Promise<SandboxFile[]> {
  const sandbox = await getProjectSandbox(projectId);
  return await sandbox.listDir("", { recursive: true, maxEntries: 600 });
}

/** Read one file — text as text, binary as base64 (screenshots). */
export async function projectReadFile(projectId: string, relPath: string): Promise<FileReadResult | null> {
  const sandbox = await getProjectSandbox(projectId);
  const exists = await sandbox.pathExists(relPath).catch(() => false);
  if (!exists) return null;
  if (isTextPath(relPath)) {
    const content = await sandbox.readTextFile(relPath);
    return { path: relPath, content, encoding: "text", bytes: Buffer.byteLength(content, "utf8") };
  }
  const buf = await sandbox.readBytesFile(relPath);
  if (buf.length > 8 * 1024 * 1024) {
    throw new Error("file too large to relay (max 8MB)");
  }
  return { path: relPath, content: buf.toString("base64"), encoding: "base64", bytes: buf.length };
}

/** Write one file (a user edit from the Files tab). */
export async function projectWriteFile(projectId: string, relPath: string, content: string): Promise<{ bytes: number }> {
  const sandbox = await getProjectSandbox(projectId);
  await sandbox.writeFile(relPath, content);
  return { bytes: Buffer.byteLength(content, "utf8") };
}

/** Execute a terminal command in the project workspace (the studio Terminal). */
export async function projectExec(projectId: string, command: string, cwd?: string): Promise<ExecResult> {
  if (!command.trim()) {
    return { exitCode: 1, stdout: "", stderr: "empty command", timedOut: false, durationMs: 0 };
  }
  if (command.length > 20_000) {
    return { exitCode: 1, stdout: "", stderr: "command too long", timedOut: false, durationMs: 0 };
  }
  const sandbox = await getProjectSandbox(projectId);
  const safeCwd = cwd ? safeRelPath(cwd) ?? undefined : undefined;
  return await sandbox.exec(command, { timeoutMs: 120_000, ...(safeCwd ? { cwd: safeCwd } : {}) });
}

/** The public app URL for the project's dev server, when one is reachable. */
export function projectAppUrl(projectId: string, port: number): string | null {
  const entry = projects.get(projectId);
  return entry ? entry.sandbox.appUrl(port) : null;
}

// ── THE UPLOAD-FOLDER LAW (user mandate) ───────────────────────────────

/** Store one user upload (binary-safe base64) into uploads/. */
export async function projectUpload(projectId: string, filename: string, contentB64: string): Promise<{ bytes: number }> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(filename) || filename.startsWith(".")) {
    throw new Error("invalid filename");
  }
  const buf = Buffer.from(contentB64, "base64");
  if (buf.length === 0) throw new Error("empty upload");
  if (buf.length > 8 * 1024 * 1024) throw new Error("file too large (max 8MB)");
  const sandbox = await getProjectSandbox(projectId);
  await sandbox.writeFile(`uploads/${filename}`, buf);
  return { bytes: buf.length };
}

/** The workspace's uploads/ manifest — the run's USER prompt is enhanced
 *  with exactly these names (never the system prompt). */
export async function projectUploadsManifest(projectId: string): Promise<Array<{ path: string; contentType: string; bytes: number }>> {
  const sandbox = await getProjectSandbox(projectId);
  const exists = await sandbox.pathExists("uploads").catch(() => false);
  if (!exists) return [];
  const entries = await sandbox.listDir("uploads", { maxEntries: 50 }).catch(() => []);
  return entries
    .filter((e) => e.type === "file")
    .map((e) => ({
      path: e.path.replace(/^uploads\//, ""),
      contentType: isTextPath(e.path) ? "text" : "binary",
      bytes: e.size ?? 0,
    }));
}

// ── Seat status + heartbeat (the E2B-mandate surface) ──────────────────

export interface WorkspaceSeatStatus {
  driver: "e2b" | "local";
  configured: boolean;
  session: Record<string, unknown> | null;
  previewPort: number | null;
}

/** The project's workspace seat status (the studio's terminal banner +
 *  preview boot states read this). */
export async function projectStatus(projectId: string, liveDevPort: number | null): Promise<WorkspaceSeatStatus> {
  const entry = projects.get(projectId);
  return {
    driver: config.e2bKeys.length > 0 ? "e2b" : "local",
    configured: true,
    session: entry
      ? { id: entry.sandbox.id, kind: entry.sandbox.kind, lastUsedAt: entry.lastUsedAt, ageMs: entry.sandbox.ageMs() }
      : null,
    previewPort: liveDevPort,
  };
}

/** Keep the seat warm — touches the registry so an idle E2B sandbox is
 *  not evicted under an active viewer. */
export async function projectHeartbeat(projectId: string): Promise<void> {
  const entry = projects.get(projectId);
  if (entry) touch(entry);
}
