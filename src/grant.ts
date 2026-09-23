/**
 * Forgevi Engine — workspace grants (fg1.).
 *
 * Copied from the Forgvi 2.0 engine verbatim: the Arcforge backend mints
 * `fg1.<base64url(payload)>.<base64url(hmac-sha256)>` AFTER verifying the
 * user owns the project, so the engine can trust the embedded
 * {projectId, sandboxId, userId} without ever seeing a user credential.
 * One grant = one project's workspace. A run can never touch another
 * user's workspace because it can never be handed a grant for it.
 *
 * In 3.0 the grant authenticates + binds the run to the project's
 * persisted workspace (Backblaze B2 / engine-local). Execution happens in
 * the run's E2B sandbox — no Daytona, no manifest, no browser delegation.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const GRANT_PREFIX = "fg1";

/** Constant-time HMAC comparison. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface GrantClaims {
  projectId: string;
  sandboxId: string;
  /** "manifest" (3.0 — the engine's persisted workspace) or "sandbox" (2.0-era). */
  workspace: "manifest" | "sandbox" | null;
  userId: string;
  expiresAt: number;
}

/**
 * Verify a grant and return its claims, or null (bad format / bad signature
 * / expired). Never throws — callers treat null as "not bound" and reject
 * the run honestly (HTTP 400), never a silent fallback.
 */
export function verifyWorkspaceGrant(
  token: string | undefined | null,
  { secret, now = Date.now(), clockSkewMs = 60_000 }: { secret: string | undefined; now?: number; clockSkewMs?: number },
): GrantClaims | null {
  try {
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== GRANT_PREFIX) return null;
    const [body, mac] = [parts[1]!, parts[2]!];
    const expected = createHmac("sha256", secret).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload: Record<string, unknown> = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (payload["v"] !== 1) return null;
    if (typeof payload["projectId"] !== "string" || !payload["projectId"]) return null;
    if (typeof payload["exp"] !== "number" || payload["exp"] + clockSkewMs < now) return null;
    // The 3.0 manifest grant: workspace:"manifest", sandboxId may be EMPTY
    // (no Daytona sandbox exists for manifest projects) — the projectId IS
    // the workspace scope. 2.0-era sandbox grants keep their sandboxId.
    const workspace = payload["workspace"] === "manifest" || payload["workspace"] === "sandbox"
      ? (payload["workspace"] as "manifest" | "sandbox")
      : null;
    const sandboxId = typeof payload["sandboxId"] === "string" ? payload["sandboxId"] : "";
    if (workspace !== "manifest" && !sandboxId) return null;
    return {
      projectId: payload["projectId"],
      sandboxId,
      workspace,
      userId: typeof payload["userId"] === "string" ? payload["userId"] : "unknown",
      expiresAt: payload["exp"],
    };
  } catch {
    return null;
  }
}

/** Mint a grant — mirrors the backend's minting logic; probes and local
 *  development only. Production grants are minted by the Arcforge backend.
 *  3.0 grants are MANIFEST grants: workspace:"manifest" with an empty
 *  sandboxId (no Daytona sandbox exists for manifest projects). */
export function mintWorkspaceGrant(
  { projectId, sandboxId, userId, workspace }: { projectId: string; sandboxId: string; userId: string; workspace?: "manifest" | "sandbox" },
  { secret, ttlMs = 20 * 60_000, now = Date.now() }: { secret: string; ttlMs?: number; now?: number },
): string {
  const payload = {
    v: 1,
    projectId: String(projectId),
    sandboxId: String(sandboxId),
    userId: String(userId ?? "unknown"),
    workspace: workspace ?? "manifest",
    iat: now,
    exp: now + ttlMs,
    jti: crypto.randomUUID(),
  };
  const b64url = (buf: Buffer) => buf.toString("base64url");
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${GRANT_PREFIX}.${body}.${mac}`;
}
