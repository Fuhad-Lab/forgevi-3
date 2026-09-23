/**
 * Forgevi 3.0 — the sandbox boot template.
 *
 * THE BAKED TEMPLATE LAW (user directive): the workspace arrives at VM
 * boot — restored snapshot, uploaded files, and a minimal project scaffold
 * when the workspace is empty. No syncing during the run. Silent in the
 * logs: nothing about this appears in the event stream; failures abort
 * the run honestly before the agent ever starts.
 *
 * `e2b-template/template.ts` defines the custom E2B sandbox image (node
 * toolchain + playwright/chromium for the browser preview tool) to build
 * with `e2b template build` and reference via E2B_TEMPLATE_ID.
 */

import type { BootFile, SandboxAdapter } from "./sandbox.ts";
import type { StorageAdapter } from "./storage.ts";
import { pushSoul } from "../soul.ts";

/** The starter scaffold a brand-new workspace gets (zero tokens burned). */
export const SCAFFOLD_FILES: BootFile[] = [
  {
    path: "README.md",
    content:
      "# Workspace\n\nThis is your project workspace. Build here.\n\n" +
      "- The current directory is the project root.\n" +
      "- `uploads/` holds files the user attached to the request.\n" +
      "- Serve web apps on the port you were told in the task context.\n",
  },
  {
    path: ".gitignore",
    content: "node_modules/\n.next/\ndist/\n.cache/\n.env\n",
  },
];

/**
 * Boot a sandbox workspace — silent by law.
 *
 * Order of precedence inside the sandbox:
 *   1. restore the project's persisted snapshot (if any)
 *   2. inject the user's uploaded files into uploads/
 *   3. seed the starter scaffold only when the workspace is still empty
 */
export async function bootWorkspace(opts: {
  sandbox: SandboxAdapter;
  storage: StorageAdapter;
  workspaceKey: string | null;
  uploads: BootFile[];
  /** THE ONE-SANDBOX LAW: a project-shared sandbox skips the snapshot
   *  restore — getProjectSandbox already restored a fresh one, and a
   *  LIVE sandbox must never be snapshotted over (user edits between
   *  runs would be clobbered back to the last snapshot). */
  skipRestore?: boolean;
}): Promise<void> {
  const { sandbox, storage, workspaceKey, uploads, skipRestore } = opts;

  // 1. persisted snapshot (never for ephemeral unbound runs)
  if (workspaceKey && !skipRestore) {
    const tar = await storage.loadSnapshot(workspaceKey).catch((err) => {
      throw new Error(`workspace snapshot could not be read: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (tar && tar.length > 0) {
      await sandbox.restoreSnapshot(tar);
    }
  }

  // 2. uploads → uploads/ (the agent learns about them through the USER
  //    prompt, never the system prompt — the prompt-enhancement law)
  if (uploads.length > 0) {
    await sandbox.exec("mkdir -p uploads", { timeoutMs: 15_000 });
    for (const file of uploads) {
      await sandbox.writeFile(`uploads/${file.path}`, file.content);
    }
  }

  // 3. scaffold only when still empty — soul.md is platform state (THE
  //    SOUL LAW), never "meaningful project content": a fresh project
  //    whose only file is the injected soul still gets its scaffold.
  const existing = await sandbox.listDir("", { maxEntries: 10 });
  const meaningful = existing.filter((e) => !e.path.startsWith("uploads/") && e.path !== ".git" && e.path !== "soul.md");
  if (meaningful.length === 0) {
    for (const file of SCAFFOLD_FILES) {
      await sandbox.writeFile(file.path, file.content);
    }
  }
}

/**
 * Persist a workspace snapshot at run end — silent by law. Local-disk
 * sandboxes with local-disk storage skip the tar: the directory already
 * IS the persistence.
 *
 * THE SOUL LAW (backup loop, run-end half): before the tar is taken (the
 * root soul.md is excluded from it by law), the account-global soul is
 * extracted from the workspace and pushed to the central store under the
 * grant's userId — overwriting the account's global profile state. A run
 * always knows its user (the fg1 grant); a missing/empty soul is a no-op
 * (never erases the account's memory).
 */
export async function persistWorkspace(opts: {
  sandbox: SandboxAdapter;
  storage: StorageAdapter;
  workspaceKey: string | null;
  userId?: string | null;
}): Promise<void> {
  const { sandbox, storage, workspaceKey, userId } = opts;
  if (userId) {
    await pushSoul({ sandbox, storage, userId });
  }
  if (!workspaceKey) return; // ephemeral unbound run — nothing persists
  if (sandbox.kind === "local" && storage.kind === "local-disk") return;
  const tar = await sandbox.createSnapshot();
  if (tar.length === 0) return;
  await storage.saveSnapshot(workspaceKey, tar);
}
