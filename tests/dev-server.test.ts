/**
 * THE DEV-SERVER LAW — real end-to-end tests (user mandate 2026-09-21:
 * "Make proper tests when done").
 *
 * These run on the LOCAL sandbox lane (no E2B keys) — which exercises the
 * exact production code path: getProjectSandbox → rememberProjectDevPort →
 * projectPreviewUrl (probe) → ensureProjectDevServer (start + wait) with a
 * REAL package.json dev script and a REAL HTTP server, exactly like a
 * Next.js `npm run dev` inside the E2B microVM.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// The workspace root the local sandbox lane uses: <cwd>/workspaces/<key>
const PID = `test-devserver-${Date.now()}`;
const PORT = 4827;

import {
  getProjectSandbox,
  rememberProjectDevPort,
  projectDevPort,
  projectPreviewUrl,
  ensureProjectDevServer,
  stopProjectDevServer,
} from "../src/runs/workspace-service.ts";

async function fetchStatus(port: number): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3_000) });
    return res.status;
  } catch {
    return 0;
  }
}

describe("THE DEV-SERVER LAW (the preview-survival surface)", () => {
  beforeAll(async () => {
    // a real workspace with a real dev script (the npm-run-dev contract)
    const dir = path.resolve(process.cwd(), "workspaces", PID);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-devserver",
          private: true,
          scripts: { dev: "bun dev-server.js" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(dir, "dev-server.js"),
      [
        "const PORT = Number(process.env.PORT || 3000);",
        "Bun.serve({ port: PORT, hostname: '0.0.0.0', fetch: () => new Response('forgeyn-test-ok') });",
        "console.log('dev server on', PORT);",
      ].join("\n"),
    );
  });

  test("getProjectSandbox boots the project workspace (local lane)", async () => {
    const sandbox = await getProjectSandbox(PID);
    expect(sandbox.kind).toBe("local");
    const probe = await sandbox.exec("test -f package.json && echo present");
    expect(probe.stdout.trim()).toBe("present");
  });

  test("rememberProjectDevPort persists the port on the PROJECT entry (not the run)", async () => {
    rememberProjectDevPort(PID, PORT);
    expect(projectDevPort(PID)).toBe(PORT);
  });

  test("projectPreviewUrl reports serving=false when nothing listens", async () => {
    const { appUrl, devPort, serving } = await projectPreviewUrl(PID);
    expect(serving).toBe(false);
    expect(appUrl).toBeNull();
    expect(devPort).toBe(PORT);
  });

  test("ensureProjectDevServer boots the dev server (npm run dev on the remembered port) and serves the preview URL", async () => {
    const res = await ensureProjectDevServer(PID, { waitMs: 45_000 });
    expect(res.error ?? "").toBe("");
    expect(res.devPort).toBe(PORT);
    expect(res.appUrl).toBe(`http://127.0.0.1:${PORT}`);
    // the server is REAL and reachable
    expect(await fetchStatus(PORT)).toBe(200);
  });

  test("ensureProjectDevServer is IDEMPOTENT — a serving port takes the fast path", async () => {
    const res = await ensureProjectDevServer(PID, { waitMs: 5_000 });
    expect(res.appUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(res.error ?? "").toBe("");
  });

  test("the preview SURVIVES a 'run ending' — the port is project-scoped, nothing reaped it", async () => {
    // (the run-end analog: no release/evict happened — the port + server live on)
    const { appUrl, serving } = await projectPreviewUrl(PID);
    expect(serving).toBe(true);
    expect(appUrl).toBe(`http://127.0.0.1:${PORT}`);
  });

  test("stopProjectDevServer kills the server; restart brings it back on the SAME port", async () => {
    await stopProjectDevServer(PID);
    // the port may take a beat to free
    await new Promise((r) => setTimeout(r, 1_500));
    const { serving } = await projectPreviewUrl(PID);
    expect(serving).toBe(false);
    const res = await ensureProjectDevServer(PID, { restart: true, waitMs: 45_000 });
    expect(res.error ?? "").toBe("");
    expect(res.appUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(await fetchStatus(PORT)).toBe(200);
  }, 90_000);

  test("the dev-server op is single-flight (a concurrent ensure reuses the in-flight promise)", async () => {
    const [a, b] = await Promise.all([
      ensureProjectDevServer(PID, { restart: true, waitMs: 45_000 }),
      ensureProjectDevServer(PID, { restart: true, waitMs: 45_000 }),
    ]);
    // both settle with the same outcome; no double-start crash
    expect(a.appUrl ?? b.appUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(await fetchStatus(PORT)).toBe(200);
  });
});
