/**
 * Forgevi — THE TEMPLATE-SYNC LAW.
 *
 * The forgevi sandbox template is PRIVATE and lives in the E2B account
 * that built it — the other pooled keys' accounts get 403 "no access" on
 * every spawn (the TEMPLATE-ACCESS LAW blocks them, wasting 3/4 of the
 * pool's spawn capacity). The cure: build the SAME template (same alias
 * "forgevi-3") into EVERY pooled key's account, then spawn by ALIAS —
 * each key resolves "forgevi-3" against its OWN account.
 *
 * This surface is relay-key guarded (the edge relay presents the key after
 * verifying the caller is the master). Builds run in the background
 * (minutes each); GET polls readiness and flips the engine onto the alias
 * once every key's account has the template ready.
 */

import { config, writeRuntimeConfigFile, reloadEngineConfig } from "../config.ts";
import { reloadE2BBroker } from "../e2b-backblaze/sandbox.ts";
import { forgeviTemplate, TEMPLATE_CPUS, TEMPLATE_MEMORY_MB } from "../../e2b-template/template.ts";

/** THE ALIAS every pooled account's template carries. */
export const TEMPLATE_ALIAS = "forgevi-3";

interface SyncState {
  startedAt: number;
  perKey: Array<{ keyLabel: string; buildID?: string; status: string; error?: string }>;
  flipped: boolean;
}

let syncState: SyncState | null = null;

/** Kick off background template builds for every pooled key. */
export async function startTemplateSync(): Promise<{
  ok: boolean;
  keys: number;
  alias: string;
  perKey: Array<{ keyLabel: string; buildID?: string; status: string; error?: string }>;
  note: string;
}> {
  if (config.e2bKeys.length === 0) {
    return { ok: false, keys: 0, alias: TEMPLATE_ALIAS, perKey: [], note: "E2B pool has 0 keys — nothing to sync" };
  }
  const { Template } = (await import("e2b")) as {
    Template: {
      buildInBackground: (
        t: unknown,
        name: string,
        opts?: Record<string, unknown>,
      ) => Promise<{ buildID?: string }>;
    };
  };
  const perKey: SyncState["perKey"] = [];
  for (const key of config.e2bKeys) {
    const keyLabel = key.slice(0, 8) + "…";
    try {
      // fresh builder per key (the builder carries no key state; the build
      // options carry the apiKey)
      const info = await Template.buildInBackground(forgeviTemplate, TEMPLATE_ALIAS, {
        apiKey: key,
        cpuCount: TEMPLATE_CPUS,
        memoryMB: TEMPLATE_MEMORY_MB,
      });
      perKey.push({ keyLabel, buildID: info?.buildID, status: "build-started" });
    } catch (err) {
      perKey.push({
        keyLabel,
        status: "build-failed",
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
  syncState = { startedAt: Date.now(), perKey, flipped: false };
  return {
    ok: perKey.some((k) => k.status === "build-started"),
    keys: perKey.length,
    alias: TEMPLATE_ALIAS,
    perKey,
    note: "builds run in the background (minutes each) — poll GET /admin/template-sync; when every key's account reports the template ready, the engine flips E2B_TEMPLATE_ID onto the alias",
  };
}

/** Poll each key's account for the template; flip onto the alias when all
 *  keys are ready. Read-only otherwise. */
export async function templateSyncStatus(): Promise<{
  ok: boolean;
  alias: string;
  allReady: boolean;
  flipped: boolean;
  templateId: string | null;
  perKey: Array<{ keyLabel: string; hasTemplate: boolean; ready: boolean; buildStatus?: string; error?: string }>;
  note: string;
}> {
  if (config.e2bKeys.length === 0) {
    return { ok: false, alias: TEMPLATE_ALIAS, allReady: false, flipped: false, templateId: null, perKey: [], note: "E2B pool has 0 keys" };
  }
  const perKey: Array<{ keyLabel: string; hasTemplate: boolean; ready: boolean; buildStatus?: string; error?: string }> = [];
  for (const key of config.e2bKeys) {
    const keyLabel = key.slice(0, 8) + "…";
    try {
      const res = await fetch("https://api.e2b.dev/templates", {
        headers: { "X-API-KEY": key },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        perKey.push({ keyLabel, hasTemplate: false, ready: false, error: `list ${res.status}` });
        continue;
      }
      const templates = (await res.json()) as Array<Record<string, unknown>>;
      const match = templates.find((t) => {
        const aliases = Array.isArray(t["aliases"]) ? t["aliases"] : [];
        return aliases.includes(TEMPLATE_ALIAS) || String(t["name"] ?? "").endsWith("/" + TEMPLATE_ALIAS);
      });
      if (!match) {
        perKey.push({ keyLabel, hasTemplate: false, ready: false });
        continue;
      }
      perKey.push({
        keyLabel,
        hasTemplate: true,
        ready: match["buildStatus"] === "ready",
        buildStatus: String(match["buildStatus"] ?? "unknown"),
      });
    } catch (err) {
      perKey.push({
        keyLabel,
        hasTemplate: false,
        ready: false,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
  const allReady = perKey.length > 0 && perKey.every((k) => k.ready);
  const flipped = config.e2bTemplate === TEMPLATE_ALIAS;
  if (allReady && !flipped) {
    // THE FLIP: every account has the template — spawn by alias from now
    // on. Persisted to the runtime config + live config mutation (env
    // vars still win at boot — the flip respects the priority law).
    writeRuntimeConfigFile({ E2B_TEMPLATE_ID: TEMPLATE_ALIAS });
    reloadEngineConfig();
    reloadE2BBroker();
  }
  return {
    ok: true,
    alias: TEMPLATE_ALIAS,
    allReady,
    flipped: config.e2bTemplate === TEMPLATE_ALIAS,
    templateId: config.e2bTemplate ?? null,
    perKey,
    note: allReady
      ? flipped
        ? "every pooled account has the template — the engine spawns by alias"
        : "all accounts ready — the engine flipped onto the alias just now"
      : "builds still in progress (or some accounts lack the template) — poll again",
  };
}
