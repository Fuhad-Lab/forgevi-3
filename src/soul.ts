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
