/**
 * Forgevi 3.0 — the browser preview tool.
 *
 * THE BROWSER-AS-PREVIEW LAW (user directive): the browser tool lets the
 * AGENT see the app it built (HTTP probe + screenshot) and lets the USER
 * watch (every check emits a `preview_frame` event with the URL, status,
 * title and screenshot when available). It is explicitly connected to
 * OpenTelemetry — every check lands as a span carrying the URL, status
 * and screenshot size.
 *
 * Screenshots require the baked E2B template (playwright + chromium
 * inside the sandbox); where they are unavailable the tool says so
 * honestly instead of pretending.
 */

import type { AgentTool, ToolCtx, ToolOutcome } from "./registry.ts";
import { counters, withSpan } from "./monitoring/telemetry.ts";

const MAX_TITLE_LEN = 200;

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN) || null;
}

async function probeUrl(url: string, signal: AbortSignal): Promise<{ status: number; title: string | null; error?: string; htmlHead: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const onOuterAbort = () => controller.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const text = await res.text().catch(() => "");
    return { status: res.status, title: extractTitle(text), htmlHead: text.slice(0, 20_000) };
  } catch (err) {
    return { status: 0, title: null, error: err instanceof Error ? err.message : String(err), htmlHead: "" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onOuterAbort);
  }
}

/** Screenshot via playwright inside the sandbox (baked template) —
 *  returns the saved path in the workspace, or null when unavailable. */
async function screenshotInSandbox(ctx: ToolCtx, url: string): Promise<string | null> {
  const probe = await ctx.sandbox.exec(
    `node -e 'require.resolve("playwright")' 2>/dev/null && echo HAVE_PW || echo NO_PW`,
    { timeoutMs: 20_000, signal: ctx.signal },
  );
  if (!probe.stdout.includes("HAVE_PW")) return null;
  const shotPath = `.f3-previews/shot-${Date.now()}.png`;
  const script = `const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(${JSON.stringify(url)}, { waitUntil: "networkidle", timeout: 25000 });
    await page.screenshot({ path: ${JSON.stringify(shotPath)} });
    process.exit(0);
  } catch (e) { console.error(String(e)); process.exit(1); } finally { await browser.close(); }
})();`;
  const res = await ctx.sandbox.exec(
    `mkdir -p .f3-previews && node -e ${JSON.stringify(script)}`,
    { timeoutMs: 60_000, signal: ctx.signal },
  );
  if (res.exitCode !== 0) return null;
  return shotPath;
}

function looksLikeErrorPage(title: string | null, status: number, htmlHead: string): string[] {
  const notes: string[] = [];
  if (status === 0) return ["the URL did not answer (connection failed)"];
  if (status >= 500) notes.push(`server error (HTTP ${status})`);
  if (title) {
    if (/error/i.test(title)) notes.push(`page title contains "error": "${title}"`);
    if (/exception|crash/i.test(title)) notes.push(`page title suggests a crash: "${title}"`);
  }
  for (const marker of ["Application error", "Unhandled", "SyntaxError", "Internal Server Error", "ERR_EMPTY_RESPONSE"]) {
    if (htmlHead.includes(marker)) notes.push(`page HTML contains "${marker}"`);
  }
  return notes;
}

export const browserPreviewTool: AgentTool = {
  name: "browser_preview",
  description:
    "Open the app you are building in a browser to SEE it. Probes the URL (status, title, error markers) " +
    "and captures a screenshot (saved in the workspace, viewable by the user as a preview frame) when the " +
    "sandbox supports it. Defaults to the dev port you were told to serve on. Use it to verify the app " +
    "actually renders — do not claim it works without checking.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL to open (default: the workspace's dev server)." },
      port: { type: "number", description: "Port on the sandbox serving the app (default: the assigned dev port)." },
    },
  },
  async execute(args, ctx): Promise<ToolOutcome> {
    const explicitUrl = typeof args["url"] === "string" ? args["url"] : null;
    const port = typeof args["port"] === "number" ? args["port"] : ctx.devPort ?? 3000;
    const url = explicitUrl ?? ctx.sandbox.appUrl(port);
    if (!url) return { content: "error: no URL and the sandbox exposes no ports" };
    return withSpan("forgevi.tool.browser_preview", { "forgevi.run_id": ctx.runId, "forgevi.url": url }, async (span) => {
      counters.toolCalls.add(1, { tool: "browser_preview" });
      const probed = await probeUrl(url, ctx.signal);
      span.setAttribute("forgevi.http_status", probed.status);
      if (probed.title) span.setAttribute("forgevi.page_title", probed.title);

      const shotPath = probed.status > 0 && !probed.error ? await screenshotInSandbox(ctx, url) : null;
      if (shotPath) span.setAttribute("forgevi.screenshot", shotPath);

      const notes = looksLikeErrorPage(probed.title, probed.status, probed.htmlHead);
      // the user sees exactly what the agent sees (minus the HTML dump)
      ctx.emit({
        type: "preview_frame",
        url,
        status: probed.status,
        ...(probed.title ? { title: probed.title } : {}),
        ...(shotPath ? { screenshot: shotPath } : {}),
        ...(notes.length ? { notes } : {}),
      });
      const lines = [
        `url: ${url}`,
        `status: ${probed.status}${probed.error ? ` (${probed.error})` : ""}`,
        `title: ${probed.title ?? "(none)"}`,
        shotPath ? `screenshot: ${shotPath} (saved — inspect it with analyze_image)` : "screenshot: unavailable in this sandbox (probe only)",
        ...(notes.length ? ["issues:", ...notes.map((n) => `  - ${n}`)] : ["no error markers detected"]),
      ];
      return { content: lines.join("\n") };
    });
  },
};
