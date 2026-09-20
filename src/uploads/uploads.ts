/**
 * Forgevi 3.0 — uploads.
 *
 * THE UPLOADS LAW (user directive): attached files land in the workspace's
 * `uploads/` directory at sandbox boot (silent), and the USER PROMPT is
 * enhanced with their manifest — never the system prompt. The system
 * prompt stays pinned byte-for-byte (the prompt-caching law); everything
 * dynamic rides the final user message.
 */

import { safeRelPath, type BootFile } from "../e2b-backblaze/sandbox.ts";

export interface RawUpload {
  path?: unknown;
  name?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  contentType?: unknown;
}

export interface UploadManifestEntry {
  path: string;
  contentType: string;
  bytes: number;
}

const MAX_TOTAL_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SINGLE_UPLOAD_BYTES = 20 * 1024 * 1024;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Normalize incoming uploads (text content or base64) into boot files +
 * a manifest for the prompt enhancement. Invalid paths, oversized files
 * and over-quota totals are rejected honestly — the run never starts on
 * a lie.
 */
export function normalizeUploads(raw: unknown): { files: BootFile[]; manifest: UploadManifestEntry[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { files: [], manifest: [] };
  const files: BootFile[] = [];
  const manifest: UploadManifestEntry[] = [];
  let total = 0;
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== "object") continue;
    const upload = item as RawUpload;
    const rawPath = typeof upload.path === "string" && upload.path.trim() ? upload.path : typeof upload.name === "string" ? upload.name : "";
    const clean = safeRelPath(rawPath);
    if (!clean) throw new Error(`upload rejected: unsafe path "${rawPath}"`);
    let content: string | Buffer;
    if (typeof upload.contentBase64 === "string" && upload.contentBase64) {
      content = Buffer.from(upload.contentBase64, "base64"); // binary-safe
    } else if (typeof upload.content === "string") {
      content = upload.content;
    } else {
      throw new Error(`upload rejected: "${clean}" has neither content nor contentBase64`);
    }
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
    if (bytes > MAX_SINGLE_UPLOAD_BYTES) throw new Error(`upload rejected: "${clean}" exceeds 20 MB`);
    total += bytes;
    if (total > MAX_TOTAL_UPLOAD_BYTES) throw new Error(`uploads rejected: total exceeds 25 MB`);
    files.push({ path: clean, content });
    manifest.push({
      path: clean,
      contentType: typeof upload.contentType === "string" ? upload.contentType : guessType(clean),
      bytes,
    });
  }
  return { files, manifest };
}

function guessType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    csv: "text/csv",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    pdf: "application/pdf",
    zip: "application/zip",
  };
  return types[ext] ?? "application/octet-stream";
}

/**
 * THE PROMPT ENHANCEMENT — appended to the user's objective (never the
 * system prompt). The agent learns the uploads exist and where they live;
 * the transport (boot injection) stays silent.
 */
export function uploadsPromptBlock(manifest: UploadManifestEntry[]): string {
  if (manifest.length === 0) return "";
  const lines = manifest.map((m) => `- uploads/${m.path} (${m.contentType}, ${humanBytes(m.bytes)})`);
  return (
    `\n\n[Attached files — already in your workspace]\n` +
    `The user attached ${manifest.length} file${manifest.length === 1 ? "" : "s"}. They are in the uploads/ directory:\n` +
    lines.join("\n")
  );
}
