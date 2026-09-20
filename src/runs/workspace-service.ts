/**
 * Forgevi 3.0 — the project workspace service (the studio surface).
 *
 * The studio's Files tab, Terminal and Preview operate on the PROJECT's
 * workspace — not on a run. A run is transient; the workspace persists:
 *   - local-disk: `workspaces/<projectId>/` — the SAME directory a run
 *     boots (the run's workspaceKey IS the projectId), so studio reads
 *     see exactly what the agent wrote, live and after the run.
 *   - E2B: a lazily-created project sandbox restored from the persisted
 *     snapshot, evicted (persist + destroy) after an idle TTL.
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
}

const projects = new Map<string, ProjectEntry>();

/** How long an idle E2B project sandbox lives before persist + destroy. */
const E2B_IDLE_TTL_MS = 10 * 60_000;

function touch(entry: ProjectEntry): void {
  entry.lastUsedAt = Date.now();
  if (entry.evictTimer) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }
  if (entry.sandbox.kind === "e2b") {
    entry.evictTimer = setTimeout(() => void evict(entry.sandbox.id), E2B_IDLE_TTL_MS + 1_000);
    entry.evictTimer.unref?.();
  }
}

async function evict(sandboxId: string): Promise<void> {
  for (const [pid, entry] of projects) {
    if (entry.sandbox.id !== sandboxId) continue;
    projects.delete(pid);
    try {
      await persistWorkspace({ sandbox: entry.sandbox, storage: createStorage(), workspaceKey: pid });
    } catch {
      /* honest best effort — the snapshot retry on next boot */
    } finally {
      await entry.sandbox.destroy().catch(() => undefined);
    }
    return;
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
  const entry: ProjectEntry = { sandbox, lastUsedAt: Date.now(), evictTimer: null };
  projects.set(projectId, entry);
  touch(entry);
  return sandbox;
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
    driver: config.e2bKey ? "e2b" : "local",
    configured: true,
    session: entry
      ? { id: entry.sandbox.id, kind: entry.sandbox.kind, lastUsedAt: entry.lastUsedAt }
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
