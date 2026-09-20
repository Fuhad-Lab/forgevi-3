/**
 * Forgevi 3.0 — workspace persistence.
 *
 * Backblaze B2 (S3-compatible, SigV4 via aws4fetch — zero heavyweight SDK)
 * when B2_* env vars are set; engine-local disk as the development
 * fallback. Local-disk sandboxes skip snapshotting entirely — their
 * workspace directory IS the persistence.
 *
 * Snapshots are written at run end (finish / abort / error) and restored
 * at sandbox boot — both SILENT (never in the event stream). There is no
 * mid-run syncing by law.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";

export interface StorageAdapter {
  readonly kind: "b2" | "local-disk";
  saveSnapshot(key: string, tar: Buffer): Promise<void>;
  loadSnapshot(key: string): Promise<Buffer | null>;
}

function snapshotKey(key: string): string {
  return `workspaces/${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.tar.gz`;
}

// ── Backblaze B2 (S3-compatible) ──────────────────────────────────────

export function createB2Storage(): StorageAdapter {
  const b2 = config.b2!;
  const base = `https://s3.${b2.region}.backblazeb2.com/${b2.bucket}`;
  // aws4fetch is imported dynamically so the engine boots fine without it
  // in local mode; with B2 configured it is a hard dependency.
  const clientPromise = (async () => {
    const { AwsClient } = await import("aws4fetch");
    return new AwsClient({
      accessKeyId: b2.keyId,
      secretAccessKey: b2.appKey,
      service: "s3",
      region: b2.region,
    });
  })();
  return {
    kind: "b2",
    async saveSnapshot(key: string, tar: Buffer): Promise<void> {
      const client = await clientPromise;
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
      const client = await clientPromise;
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
