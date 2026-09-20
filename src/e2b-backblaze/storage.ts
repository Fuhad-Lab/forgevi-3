/**
 * Forgevi — workspace persistence.
 *
 * Backblaze B2 (S3-compatible, SigV4 via aws4fetch — zero heavyweight SDK)
 * through the SELF-HEALING BOOTSTRAP (b2.ts): master key → minted S3 key →
 * auto-created bucket → auto-discovered region. Engine-local disk remains
 * the development fallback. Local-disk sandboxes skip snapshotting
 * entirely — their workspace directory IS the persistence.
 *
 * Snapshots are written at run end (finish / abort / error) AND by the
 * 5-minute idle reaper before any sandbox is destroyed — the DATA-SAFETY
 * LAW: a failed B2 upload keeps the sandbox alive (the caller must never
 * destroy work it could not save).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { resolveB2Credentials } from "./b2.ts";

export interface StorageAdapter {
  readonly kind: "b2" | "local-disk";
  saveSnapshot(key: string, tar: Buffer): Promise<void>;
  loadSnapshot(key: string): Promise<Buffer | null>;
}

function snapshotKey(key: string): string {
  return `workspaces/${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.tar.gz`;
}

// ── Backblaze B2 (S3-compatible, self-healing bootstrap) ───────────────

export function createB2Storage(): StorageAdapter {
  const clientPromise = (async () => {
    const { AwsClient } = await import("aws4fetch");
    const resolved = await resolveB2Credentials();
    return {
      client: new AwsClient({
        accessKeyId: resolved.accessKeyId,
        secretAccessKey: resolved.secretAccessKey,
        service: "s3",
        region: resolved.region,
      }),
      base: `https://${resolved.endpointHost}/${resolved.bucket}`,
    };
  })();
  return {
    kind: "b2",
    async saveSnapshot(key: string, tar: Buffer): Promise<void> {
      const { client, base } = await clientPromise;
      const res = await client.fetch(`${base}/${snapshotKey(key)}`, {
        method: "PUT",
        body: new Uint8Array(tar),
        headers: { "Content-Type": "application/gzip" },
      });
      if (!res.ok) {
        throw new Error(`b2 put failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      }
    },
    async loadSnapshot(key: string): Promise<Buffer | null> {
      const { client, base } = await clientPromise;
      const res = await client.fetch(`${base}/${snapshotKey(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`b2 get failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// ── engine-local disk (development fallback) ──────────────────────────

export function createLocalDiskStorage(): StorageAdapter {
  const dir = path.resolve(process.cwd(), "workspaces", "_snapshots");
  return {
    kind: "local-disk",
    async saveSnapshot(key: string, tar: Buffer): Promise<void> {
      const target = path.join(dir, snapshotKey(key));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar);
    },
    async loadSnapshot(key: string): Promise<Buffer | null> {
      try {
        return await readFile(path.join(dir, snapshotKey(key)));
      } catch {
        return null;
      }
    },
  };
}

export function createStorage(): StorageAdapter {
  return config.b2 ? createB2Storage() : createLocalDiskStorage();
}

/** Clean a stale local snapshot (probe helper). */
export async function deleteLocalSnapshot(key: string): Promise<void> {
  await rm(path.resolve(process.cwd(), "workspaces", "_snapshots", snapshotKey(key)), { force: true });
}
