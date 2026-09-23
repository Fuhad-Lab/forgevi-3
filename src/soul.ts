/**
 * Forgevi — THE SOUL LAW (global cross-project agent memory).
 *
 * soul.md is the user's GLOBAL agent memory — ONE file per ACCOUNT, shared
 * across every project they own on the platform. It stores user coding
 * patterns, framework preferences, architecture decisions and lessons
 * learned across debugging sessions. The project snapshot tar NEVER
 * carries it (SNAPSHOT_EXCLUDES carries "soul.md"); the engine intercepts
 * the lifecycle at the orchestration level instead:
 *
 *   - RESTORE LOOP (getProjectSandbox): after the workspace tar is
 *     extracted into a fresh VM — and before the agent is ever launched —
 *     the engine pulls the user's latest soul from the central store
 *     (B2 `souls/<userId>.md`) and injects it at the workspace root.
 *   - BACKUP LOOP (persistWorkspace — at run end AND the 5-minute idle
 *     reaper): the engine extracts soul.md from the VM FIRST and uploads
 *     its contents to the central store under the user's account id
 *     (overwriting their global profile state), THEN zips the remaining
 *     project files for the Backblaze upload.
 *
 * Identity: the fg1. workspace grant carries {projectId, userId} HMAC-
 * signed by the platform backend AFTER it verifies ownership — the run's
 * userId is trusted without the engine ever seeing a user credential.
 * Studio-only touches (Files/Terminal/Preview) arrive unauthenticated-by-
 * user; the entry's userId is remembered from the first bound run, so the
 * idle reaper can still sync the soul at teardown.
 */

import type { SandboxAdapter } from "./e2b-backblaze/sandbox.ts";
import type { StorageAdapter } from "./e2b-backblaze/storage.ts";

/** Where the soul lives inside every workspace — the root. */
export const SOUL_PATH = "soul.md";

/** A soul larger than this is truncated on push — the soul is memory,
 *  not a dump; the agent is instructed to keep it concise. */
export const SOUL_MAX_BYTES = 256 * 1024;

/** The seed every first-bound account starts from (zero tokens burned —
 *  the agent fills it in as it learns). */
export const DEFAULT_SOUL = `# Soul — the agent's persistent memory for this user

> This file is the agent's GLOBAL long-term memory. It is shared across
> ALL of this user's projects on this platform and survives every VM
> teardown. The agent reads it at the start of each run and records
> durable lessons at the end. The platform syncs it automatically.

## User preferences
- (not yet learned)

## Framework & stack choices
- (not yet learned)

## Architecture decisions
- (not yet learned)

## Lessons learned
- (not yet learned)
`;

/** Read the workspace's current soul — null when absent or empty. */
export async function extractSoul(sandbox: SandboxAdapter): Promise<string | null> {
  const exists = await sandbox.pathExists(SOUL_PATH).catch(() => false);
  if (!exists) return null;
  const content = await sandbox.readTextFile(SOUL_PATH).catch(() => null);
  if (content === null || content.trim().length === 0) return null;
  if (Buffer.byteLength(content, "utf8") > SOUL_MAX_BYTES) {
    return (
      Buffer.from(content, "utf8").subarray(0, SOUL_MAX_BYTES).toString("utf8") +
      "\n\n… (truncated by the engine — keep soul.md concise)\n"
    );
  }
  return content;
}

// ── THE PULL-MERGE-PUSH LAW ─────────────────────────────────────────────
// A user may hold SEVERAL live project VMs at once, each carrying its own
// copy of the soul. Whole-file last-writer-wins would let a STALER VM's
// eviction clobber a FRESHER push (live-observed 2026-09-23: project B's
// unedited copy overwrote project A's lesson). The cure: every run start
// MERGES the store's soul into the workspace (remote-only lines survive),
// and every push is the workspace's consolidated whole-file view. Deletion
// semantics: plain line deletion can resurrect while another VM holds the
// line — retire a lesson by REPLACING or striking it, not deleting it.

/** Split a soul document into (preamble, sections: heading → bullet lines). */
function parseSoul(doc: string): { preamble: string[]; sections: Array<{ heading: string; lines: string[] }> } {
  const lines = doc.split("\n");
  const preamble: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const raw of lines) {
    const heading = /^#{1,3}\s+(.*)$/.exec(raw.trim());
    if (heading) {
      current = { heading: heading[1]!.trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(raw);
    } else {
      preamble.push(raw);
    }
  }
  return { preamble, sections };
}

function renderSoul(preamble: string[], sections: Array<{ heading: string; lines: string[] }>): string {
  const chunks: string[] = [];
  const pre = preamble.join("\n").trim();
  if (pre) chunks.push(pre);
  for (const s of sections) {
    const body = s.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    chunks.push(`## ${s.heading}${body ? `\n${body}` : ""}`);
  }
  return chunks.join("\n\n") + "\n";
}

/** Section-aware line union: `local`'s structure wins; every unique
 *  non-empty bullet line from `remote` survives (appended into its
 *  section; remote-only sections appended at the end). */
export function mergeSouls(local: string, remote: string): string {
  const L = parseSoul(local);
  const R = parseSoul(remote);
  const localLineKeys = new Set(
    L.sections.flatMap((s) => s.lines.map((l) => l.trim())).filter((l) => l.length > 0 && l !== "-"),
  );
  const sectionByName = new Map(L.sections.map((s) => [s.heading.toLowerCase(), s]));
  for (const rs of R.sections) {
    const target = sectionByName.get(rs.heading.toLowerCase());
    const remoteOnly = rs.lines.filter((l) => {
      const t = l.trim();
      return t.length > 0 && t !== "-" && !localLineKeys.has(t);
    });
    if (!target) {
      if (remoteOnly.length > 0 || rs.lines.some((l) => l.trim())) {
        L.sections.push({ heading: rs.heading, lines: rs.lines });
      }
      continue;
    }
    if (remoteOnly.length > 0) {
      const lastContent = [...target.lines].reverse().find((l) => l.trim().length > 0);
      const insertAt = lastContent ? target.lines.lastIndexOf(lastContent) + 1 : target.lines.length;
      target.lines.splice(insertAt, 0, "", ...remoteOnly);
    }
  }
  return renderSoul(L.preamble, L.sections);
}

/**
 * Inject the user's global soul into a workspace — the RESTORE LOOP half
 * of the law. Pulls the latest from the central store (seeding a fresh
 * account with the default); `overwrite` decides what happens to a copy
 * already in the workspace:
 *   - fresh VM restore → true (the global store is the truth; the tar
 *     never carried a soul anyway — this is belt-and-braces)
 *   - live VM bind    → false (an in-run edit is newer than the store)
 */
export async function injectSoul(opts: {
  sandbox: SandboxAdapter;
  storage: StorageAdapter;
  userId: string;
  overwrite: boolean;
}): Promise<void> {
  const { sandbox, storage, userId, overwrite } = opts;
  if (!overwrite) {
    const exists = await sandbox.pathExists(SOUL_PATH).catch(() => false);
    if (exists) return;
  }
  const stored = await storage.loadSoul(userId).catch(() => null);
  await sandbox.writeFile(SOUL_PATH, stored ?? DEFAULT_SOUL);
}

/**
 * THE RUN-START SYNC (the pull half of PULL-MERGE-PUSH): a live sandbox
 * that predates its first bound run gets the soul injected; a live
 * sandbox that already HAS a soul gets the store's unique lines merged
 * in — so a lesson learned in project A reaches project B's VM even
 * while B's VM stays live (its next run pulls it), and B's own push can
 * never silently drop A's lesson it has now seen.
 */
export async function syncSoulForRun(opts: {
  sandbox: SandboxAdapter;
  storage: StorageAdapter;
  userId: string;
}): Promise<void> {
  const { sandbox, storage, userId } = opts;
  const stored = await storage.loadSoul(userId).catch(() => null);
  const local = await extractSoul(sandbox);
  if (local === null) {
    await sandbox.writeFile(SOUL_PATH, stored ?? DEFAULT_SOUL);
    return;
  }
  if (stored === null) return; // nothing to merge in
  const merged = mergeSouls(local, stored);
  if (merged !== local) {
    await sandbox.writeFile(SOUL_PATH, merged);
  }
}

/** Push the workspace's current soul to the central store — the BACKUP
 *  LOOP half of the law. No-op when the workspace has no (non-empty)
 *  soul: a missing soul must never erase the account's global memory. */
export async function pushSoul(opts: {
  sandbox: SandboxAdapter;
  storage: StorageAdapter;
  userId: string;
}): Promise<boolean> {
  const soul = await extractSoul(opts.sandbox);
  if (soul === null) return false;
  await opts.storage.saveSoul(opts.userId, soul);
  return true;
}
