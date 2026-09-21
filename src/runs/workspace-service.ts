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
  /** THE ONE-SANDBOX LAW: live runs HOLD the project sandbox — the idle
   *  reaper, the 55-min migration, and the hard cap all defer while a
   *  run is executing inside the machine (the E2B window is extended to
   *  the hard cap so the VM outlives the run). */
  holders: number;
  /** THE DEV-SERVER LAW (user fix 2026-09-21): the dev port OUTLIVES the
   *  run that was assigned it — the preview surface serves the URL as
   *  long as the sandbox lives, and `ensureProjectDevServer` can restart
   *  the server on this exact port after a run ends (or after a manual
   *  restart request). Null when no port was ever assigned. */
  devPort: number | null;
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
    if (entry.busy || entry.holders > 0) {
      // a migration is in flight, or a run is executing inside the
      // machine — re-arm the reaper for after it
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

/** THE 55-MINUTE SEAMLESS MIGRATION also kills the in-VM dev server — the
 *  port memory survives (the fresh VM rehydrates the workspace), and the
 *  next preview GET / dev-server ensure restarts the server on it. */

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
  if (!entry || entry.busy || entry.holders > 0) {
    // a run is executing inside the machine — deferring the swap keeps
    // the in-VM worker alive; retry once the run releases.
    if (entry && entry.holders > 0) {
      entry.migrateTimer = setTimeout(() => void migrate(pid), 2 * 60_000);
      entry.migrateTimer.unref?.();
    }
    return;
  }
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
    holders: 0,
    devPort: null,
  };
  projects.set(projectId, entry);
  touch(entry);
  armLifecycle(projectId, entry);
  return sandbox;
}

// ── THE DEV-SERVER LAW (user fix 2026-09-21) ────────────────────────────
// THE PREVIEW-SURVIVAL LAW: a run's dev port is remembered on the PROJECT
// entry (not the run), the preview route serves the URL for as long as the
// port actually answers inside the sandbox, and a restart (manual button
// or the post-run auto-ensure) rehydrates the sandbox from the B2 snapshot
// when the reaper already evicted it — then boots the dev server on the
// remembered port. The preview therefore survives: run end → release →
// idle TTL → eviction → user reopens → rehydrate + restart.

/** Remember the project's dev port (called when a run is assigned one). */
export function rememberProjectDevPort(projectId: string, port: number): void {
  const entry = projects.get(projectId);
  if (entry) entry.devPort = port;
}

/** The project's remembered dev port — survives run end, dies with the
 *  entry (eviction/migration clear it implicitly: fresh VM, fresh server). */
export function projectDevPort(projectId: string): number | null {
  return projects.get(projectId)?.devPort ?? null;
}

/** Probe whether anything is serving on a port INSIDE the sandbox. */
async function probePort(sandbox: SandboxAdapter, port: number): Promise<boolean> {
  const res = await sandbox.exec(
    `curl -s -o /dev/null -m 4 -w "%{http_code}" http://127.0.0.1:${port} || true`,
    { timeoutMs: 8_000 },
  ).catch(() => null);
  if (!res) return false;
  const code = res.stdout.trim();
  return /^\d{3}$/.test(code) && code !== "000";
}

/** The project's dev-server preview URL — only when the port answers. */
export async function projectPreviewUrl(
  projectId: string,
): Promise<{ appUrl: string | null; devPort: number | null; serving: boolean }> {
  const entry = projects.get(projectId);
  const port = entry?.devPort ?? null;
  if (!entry || !port) return { appUrl: null, devPort: null, serving: false };
  const serving = await probePort(entry.sandbox, port);
  const appUrl = serving ? entry.sandbox.appUrl(port) : null;
  return { appUrl, devPort: port, serving };
}

/** One dev-server lifecycle op at a time per project. */
const devServerOps = new Map<string, Promise<{ appUrl: string | null; devPort: number | null; error?: string }>>();

/** Find the app root inside the workspace — the shallowest directory with
 *  a package.json carrying a dev/start script (workspace root preferred). */
async function findAppRoot(sandbox: SandboxAdapter): Promise<string> {
  const res = await sandbox.exec(
    `node -e "const fs=require('fs');const cands=['.','app','web','frontend','client','src/app/..'].map(d=>d.replace(/\\/\.$/,''));for(const d of cands){try{const p=JSON.parse(fs.readFileSync(d+'/package.json','utf8'));if(p.scripts&&(p.scripts.dev||p.scripts.start)){console.log(d);process.exit(0)}}catch(e){}}console.log('.')" 2>/dev/null || echo .`,
    { timeoutMs: 15_000 },
  ).catch(() => null);
  const out = (res?.stdout ?? ".").trim().split("\n").filter(Boolean).pop() ?? ".";
  return out === "" ? "." : out;
}

/** Kill whatever serves on a port inside the sandbox — belt AND
 *  suspenders: `pkill -f --` (the `--` separator is MANDATORY — a pattern
 *  starting with `--` is parsed as pkill OPTIONS and silently no-ops),
 *  fuser (psmisc), and lsof (procps) — whichever image provides. */
async function killPort(sandbox: SandboxAdapter, port: number): Promise<void> {
  await sandbox
    .exec(
      [
        `pkill -f -- "--port ${port}" 2>/dev/null`,
        `pkill -f -- "port ${port}" 2>/dev/null`,
        `fuser -k ${port}/tcp 2>/dev/null`,
        `lsof -t -i:${port} 2>/dev/null | xargs -r kill 2>/dev/null`,
        "true",
      ].join("; "),
      { timeoutMs: 20_000 },
    )
    .catch(() => undefined);
  // a beat for the socket to actually free
  await new Promise((r) => setTimeout(r, 1_000));
}

function devServerStartCommand(root: string, port: number): string {
  // PORT env covers Vite/CRA/Next custom servers; the explicit flags cover
  // stock Next.js (`next dev`). setsid+nohup: the server must OUTLIVE the
  // exec call (the E2B commands API kills the command's process group —
  // a plain child dies with it; a detached session survives).
  return (
    `cd ${JSON.stringify(root)} && ` +
    `if [ -d node_modules ] || npm install --no-audit --no-fund >/tmp/dev-install.log 2>&1; then ` +
    `(setsid nohup env PORT=${port} npm run dev -- --port ${port} --hostname 0.0.0.0 -p ${port} -H 0.0.0.0 >/tmp/dev-server.log 2>&1 &) && ` +
    `echo started; else echo "install failed: $(tail -n 5 /tmp/dev-install.log 2>/dev/null)"; fi`
  );
}

/** Ensure the project's dev server is running on its remembered port.
 *
 * THE REHYDRATION LAW: `getProjectSandbox` restores the B2 snapshot when
 * the reaper already evicted the VM — a manual restart after eviction
 * brings BOTH the workspace and the dev server back. Bounded wait: npm
 * install + next dev compile can legitimately take a while on a fresh VM.
 */
export async function ensureProjectDevServer(
  projectId: string,
  opts: { restart?: boolean; waitMs?: number } = {},
): Promise<{ appUrl: string | null; devPort: number | null; error?: string }> {
  const existing = devServerOps.get(projectId);
  if (existing) return existing;

  const op = (async () => {
    try {
      const sandbox = await getProjectSandbox(projectId);
      const entry = projects.get(projectId);
      const port = entry?.devPort ?? null;
      if (!port) {
        return { appUrl: null, devPort: null, error: "no dev port assigned for this project yet — run a build first" };
      }

      if (!opts.restart && (await probePort(sandbox, port))) {
        return { appUrl: sandbox.appUrl(port), devPort: port };
      }

      // stop any straggler bound to the port, then start fresh on it
      await killPort(sandbox, port);

      const root = await findAppRoot(sandbox);
      await sandbox.exec(devServerStartCommand(root, port), { timeoutMs: 120_000 }).catch(() => undefined);

      const deadline = Date.now() + (opts.waitMs ?? 75_000);
      while (Date.now() < deadline) {
        if (await probePort(sandbox, port)) {
          return { appUrl: sandbox.appUrl(port), devPort: port };
        }
        await new Promise((r) => setTimeout(r, 2_500));
      }
      const log = await sandbox
        .exec("tail -n 8 /tmp/dev-server.log /tmp/dev-install.log 2>/dev/null", { timeoutMs: 10_000 })
        .catch(() => null);
      return {
        appUrl: null,
        devPort: port,
        error: `the dev server did not answer on port ${port} in time${log?.stdout ? ` — tail: ${log.stdout.slice(0, 400)}` : ""}`,
      };
    } catch (err) {
      return {
        appUrl: null,
        devPort: null,
        error: err instanceof Error ? err.message.slice(0, 400) : String(err),
      };
    } finally {
      devServerOps.delete(projectId);
    }
  })();

  devServerOps.set(projectId, op);
  return op;
}

/** Stop the project's dev server (the preview pause button). */
export async function stopProjectDevServer(projectId: string): Promise<{ ok: boolean }> {
  const entry = projects.get(projectId);
  const port = entry?.devPort;
  if (!entry || !port) return { ok: true };
  await killPort(entry.sandbox, port);
  return { ok: true };
}

// ── THE ONE-SANDBOX LAW: run holds ─────────────────────────────────

/** A run started on the project's sandbox — hold it: the reaper, the
 *  migration, and the hard cap all defer while the run is live, and the
 *  E2B window extends to the hard cap so the VM outlives the run. */
export function holdProjectSandbox(projectId: string): void {
  const entry = projects.get(projectId);
  if (!entry) return;
  entry.holders += 1;
  clearLifecycleTimers(entry);
  if (entry.sandbox.kind === "e2b") {
    // keep the machine alive through the run (bounded by the hard cap)
    void entry.sandbox.extendTimeout(config.e2bHardCapMs + 60_000).catch(() => undefined);
  }
}

/** The run ended — release the hold; the idle reaper re-arms (the studio
 *  surface keeps the machine alive through normal traffic). */
export function releaseProjectSandbox(projectId: string): void {
  const entry = projects.get(projectId);
  if (!entry) return;
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders === 0) {
    touch(entry);
    armLifecycle(projectId, entry);
  }
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
