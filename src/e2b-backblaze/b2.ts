/**
 * Forgevi — the Backblaze B2 self-healing bootstrap (THE B2 LAW).
 *
 * Ported from the platform's own e2b_backblaze/storage.py laws:
 *
 *   - S3 endpoint/region AUTO-DISCOVERY via b2_authorize (native v2 API)
 *   - SELF-HEALING BOOTSTRAP: given the master B2_KEY_ID /
 *     B2_APPLICATION_KEY, it mints a dedicated S3-credential key
 *     (capabilities scoped to the one bucket) cached at
 *     ~/.agent-platform/b2-s3-key.json, and AUTO-CREATES the private
 *     bucket if none exists
 *   - direct S3 credentials (B2_S3_KEY_ID / B2_S3_APPLICATION_KEY) skip
 *     the bootstrap entirely when provided
 *
 * All state is cached in-process after the first successful bootstrap;
 * failures are honest (thrown, never swallowed into a silent local
 * fallback — the DATA-SAFETY LAW depends on knowing persistence failed).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config, type B2Config } from "../config.ts";

export interface ResolvedB2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  /** s3.<region>.backblazeb2.com */
  endpointHost: string;
  source: "direct-s3-creds" | "bootstrap-minted" | "bootstrap-cache";
}

/** Where the minted S3 key is cached (the law's path). */
const S3_KEY_CACHE_FILE = path.join(os.homedir(), ".agent-platform", "b2-s3-key.json");

/** The regions Backblaze operates S3 endpoints in (discovery probe order). */
const KNOWN_REGIONS = [
  "eu-central-003",
  "us-west-004",
  "us-west-002",
  "us-west-001",
  "eu-central-002",
  "us-east-003",
  "us-east-004",
  "us-east-005",
  "ap-southeast-002",
  "ap-northeast-001",
];

interface B2Auth {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  /** e.g. https://s3.us-west-004.backblazeb2.com (the ACCOUNT default region). */
  s3ApiUrl?: string;
}

async function b2Authorize(keyId: string, appKey: string): Promise<B2Auth> {
  const res = await fetch("https://api.backblaze.com/b2api/v2/b2_authorize_account", {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString("base64")}` },
  });
  if (!res.ok) {
    throw new Error(`b2_authorize failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    accountId: String(body["accountId"] ?? ""),
    authorizationToken: String(body["authorizationToken"] ?? ""),
    apiUrl: String(body["apiUrl"] ?? "https://api.backblaze.com"),
    ...(typeof body["s3ApiUrl"] === "string" ? { s3ApiUrl: body["s3ApiUrl"] } : {}),
  };
}

async function b2ListBuckets(auth: B2Auth): Promise<Array<{ bucketName: string; bucketId: string }>> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: "POST",
    headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: auth.accountId }),
  });
  if (!res.ok) {
    throw new Error(`b2_list_buckets failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const body = (await res.json()) as { buckets?: Array<{ bucketName?: string; bucketId?: string }> };
  return (body.buckets ?? [])
    .filter((b) => typeof b.bucketName === "string")
    .map((b) => ({ bucketName: b.bucketName!, bucketId: String(b.bucketId ?? "") }));
}

async function b2CreatePrivateBucket(auth: B2Auth, name: string): Promise<void> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_create_bucket`, {
    method: "POST",
    headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketName: name,
      bucketType: "allPrivate",
      // no object lock, no default encryption — the reaper must be able to
      // overwrite workspace snapshots (the user's bucket-form law)
      fileLockEnabled: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`b2_create_bucket failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

async function b2CreateS3Key(
  auth: B2Auth,
  bucketName: string,
): Promise<{ keyId: string; appKey: string }> {
  // The 2026 ApplicationKeyCapability enum (verified against the live
  // authorize response): listFiles (S3 ListObjects), readFiles (GetObject),
  // writeFiles (PutObject), deleteFiles (DeleteObject), listAllBucketNames +
  // listBuckets (S3 ListBuckets) — scoped for the workspace snapshot pipeline.
  const capabilities = [
    "listAllBucketNames",
    "listBuckets",
    "listFiles",
    "readBucketEncryption",
    "readFiles",
    "readFileRetentions",
    "readFileLegalHolds",
    "writeFiles",
    "deleteFiles",
    "bypassGovernance",
  ];
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_create_key`, {
    method: "POST",
    headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: auth.accountId,
      capabilities,
      keyName: `forgevi-s3-${bucketName.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`,
      bucketId: null, // S3-compatible keys operate account-wide; capabilities scope the app
    }),
  });
  if (!res.ok) {
    throw new Error(`b2_create_key failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const body = (await res.json()) as { applicationKeyId?: string; applicationKey?: string };
  if (!body.applicationKeyId || !body.applicationKey) {
    throw new Error("b2_create_key returned no key material");
  }
  return { keyId: body.applicationKeyId, appKey: body.applicationKey };
}

/** THE KEY-SWEEP LAW (live-observed 2026-09-23: 118 minted keys had
 *  accumulated on the account — Render's ephemeral disk wipes the key
 *  cache on every deploy, so every boot re-minted, and B2's key quota
 *  would eventually refuse the mint and break snapshotting entirely).
 *  After a mint, delete every OTHER key minted by this engine's naming
 *  conventions (forgevi-s3-*, legacy agent-platform-s3*, probe debris).
 *  Best-effort and bounded — a sweep failure NEVER blocks the bootstrap. */
const SWEEPABLE_KEY_NAME = /^(forgevi-s3-|agent-platform-s3($|-diag)|soul-probe-)/;
const SWEEP_MAX_SCAN = 500;
const SWEEP_MAX_DELETE = 200;

async function b2SweepStaleKeys(auth: B2Auth, keepKeyId: string): Promise<void> {
  try {
    let startAfter: string | null = null;
    let scanned = 0;
    let deleted = 0;
    while (scanned < SWEEP_MAX_SCAN && deleted < SWEEP_MAX_DELETE) {
      const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_keys`, {
        method: "POST",
        headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: auth.accountId,
          maxKeyCount: 100,
          ...(startAfter ? { startApplicationKeyId: startAfter } : {}),
        }),
      }).catch(() => null);
      if (!res || !res.ok) return; // best-effort
      const body = (await res.json().catch(() => null)) as {
        keys?: Array<{ applicationKeyId?: string; keyName?: string }>;
      } | null;
      const batch = body?.keys ?? [];
      if (batch.length === 0) return;
      scanned += batch.length;
      for (const k of batch) {
        if (deleted >= SWEEP_MAX_DELETE) return;
        if (!k.applicationKeyId || k.applicationKeyId === keepKeyId) continue;
        if (!k.keyName || !SWEEPABLE_KEY_NAME.test(k.keyName)) continue;
        const del = await fetch(`${auth.apiUrl}/b2api/v2/b2_delete_key`, {
          method: "POST",
          headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
          body: JSON.stringify({ applicationKeyId: k.applicationKeyId }),
        }).catch(() => null);
        if (del && del.ok) deleted += 1;
      }
      if (batch.length < 100) return;
      startAfter = batch[batch.length - 1]?.applicationKeyId ?? null;
      if (!startAfter) return;
    }
  } catch {
    /* best-effort — never block the bootstrap */
  }
}

/** Region discovery: S3 ListObjectsV2 probe per known region (the one that
 *  admits the bucket wins). Bounded, sequential, cached after success. */
async function discoverRegion(creds: { accessKeyId: string; secretAccessKey: string }, bucket: string): Promise<string> {
  for (const region of KNOWN_REGIONS) {
    const host = `s3.${region}.backblazeb2.com`;
    try {
      const res = await fetch(`https://${host}/${encodeURIComponent(bucket)}?list-type=2&max-keys=1`, {
        headers: await awsSignedHead(creds, host, bucket),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 200) return region;
      // 403 = wrong region for the key; 404 = bucket not in this region
    } catch {
      /* region unreachable — next */
    }
  }
  throw new Error(`B2 region discovery failed for bucket "${bucket}" across ${KNOWN_REGIONS.length} known regions`);
}

/** Minimal SigV4 signer for the discovery probe (GET, service s3). */
async function awsSignedHead(
  creds: { accessKeyId: string; secretAccessKey: string },
  host: string,
  bucket: string,
): Promise<Record<string, string>> {
  const { AwsClient } = await import("aws4fetch");
  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    // Backblaze SigV4 accepts the region matching the endpoint host
    region: host.split(".")[1] ?? "us-west-004",
  });
  const signed = await client.sign(`https://${host}/${encodeURIComponent(bucket)}?list-type=2&max-keys=1`, {
    method: "GET",
  });
  const headers: Record<string, string> = {};
  signed.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

interface S3KeyCache {
  accountId: string;
  bucket: string;
  keyId: string;
  appKey: string;
  region?: string;
}

async function readKeyCache(): Promise<S3KeyCache | null> {
  try {
    const raw = JSON.parse(await readFile(S3_KEY_CACHE_FILE, "utf8")) as S3KeyCache;
    if (raw && typeof raw.keyId === "string" && typeof raw.appKey === "string") return raw;
  } catch {
    /* no cache — bootstrap from scratch */
  }
  return null;
}

async function writeKeyCache(cache: S3KeyCache): Promise<void> {
  try {
    await mkdir(path.dirname(S3_KEY_CACHE_FILE), { recursive: true });
    await writeFile(S3_KEY_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    /* cache write is best-effort — the minted key still works this boot */
  }
}

// ── the bootstrap singleton ─────────────────────────────────────────────

let resolvedPromise: Promise<ResolvedB2Credentials> | null = null;

/** Reset the cached bootstrap (the config-push surface calls this when
 *  B2 credentials change). */
export function resetB2Bootstrap(): void {
  resolvedPromise = null;
}

/** Resolve B2 S3 credentials — the self-healing bootstrap. */
export function resolveB2Credentials(): Promise<ResolvedB2Credentials> {
  if (!resolvedPromise) {
    resolvedPromise = (async (): Promise<ResolvedB2Credentials> => {
      const b2: B2Config | undefined = config.b2;
      if (!b2) {
        throw new Error("B2 is not configured — set B2_KEY_ID / B2_APPLICATION_KEY (master) or B2_S3_KEY_ID / B2_S3_APPLICATION_KEY");
      }
      const bucket = b2.bucket || "Forgeyn";

      // 1. direct S3 credentials — skip the bootstrap
      if (b2.s3KeyId && b2.s3AppKey) {
        const creds = { accessKeyId: b2.s3KeyId, secretAccessKey: b2.s3AppKey };
        const region = b2.region ?? (await discoverRegion(creds, bucket));
        return {
          ...creds,
          bucket,
          region,
          endpointHost: `s3.${region}.backblazeb2.com`,
          source: "direct-s3-creds",
        };
      }

      // 2. the cached minted key (if it still authorizes)
      const auth = await b2Authorize(b2.masterKeyId, b2.masterAppKey);
      const cached = await readKeyCache();
      if (cached && cached.accountId === auth.accountId && cached.bucket === bucket) {
        try {
          const verify = await b2Authorize(cached.keyId, cached.appKey);
          if (verify.accountId === auth.accountId) {
            const creds = { accessKeyId: cached.keyId, secretAccessKey: cached.appKey };
            const region = b2.region ?? cached.region ?? (await discoverRegion(creds, bucket));
            return {
              ...creds,
              bucket,
              region,
              endpointHost: `s3.${region}.backblazeb2.com`,
              source: "bootstrap-cache",
            };
          }
        } catch {
          /* cached key revoked — mint a fresh one below */
        }
      }

      // 3. mint a dedicated S3 key with the master
      const buckets = await b2ListBuckets(auth);
      if (!buckets.some((b) => b.bucketName === bucket)) {
        await b2CreatePrivateBucket(auth, bucket);
      }
      const minted = await b2CreateS3Key(auth, bucket);
      // THE KEY-SWEEP LAW — fire-and-forget: never add bootstrap latency,
      // never fail the bootstrap because the sweep hiccuped.
      void b2SweepStaleKeys(auth, minted.keyId).catch(() => undefined);
      const region = b2.region ?? (await discoverRegion({ accessKeyId: minted.keyId, secretAccessKey: minted.appKey }, bucket));
      await writeKeyCache({
        accountId: auth.accountId,
        bucket,
        keyId: minted.keyId,
        appKey: minted.appKey,
        region,
      });
      return {
        accessKeyId: minted.keyId,
        secretAccessKey: minted.appKey,
        bucket,
        region,
        endpointHost: `s3.${region}.backblazeb2.com`,
        source: "bootstrap-minted",
      };
    })().catch((err) => {
      resolvedPromise = null; // failed bootstrap — retry allowed on next call
      throw err;
    });
  }
  return resolvedPromise;
}

/** Bootstrap status for /health (never throws, never logs key material). */
export async function b2BootstrapStatus(): Promise<{
  configured: boolean;
  bucket: string | null;
  region: string | null;
  source: string | null;
  error: string | null;
}> {
  if (!config.b2) {
    return { configured: false, bucket: null, region: null, source: null, error: null };
  }
  try {
    const resolved = await resolveB2Credentials();
    return {
      configured: true,
      bucket: resolved.bucket,
      region: resolved.region,
      source: resolved.source,
      error: null,
    };
  } catch (err) {
    return {
      configured: false,
      bucket: config.b2.bucket,
      region: config.b2.region ?? null,
      source: null,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    };
  }
}
