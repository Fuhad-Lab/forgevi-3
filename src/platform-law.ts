/**
 * Forgevi — THE SYSTEM-PROMPT LAW (user mandate 2026-09-24).
 *
 * The platform's standing instructions ride the AGENT'S SYSTEM PROMPT:
 * when the agent finishes making edits, IT spins up the development
 * server — never a hardcoded engine-side start (the old post-run
 * ensureProjectDevServer auto-start is retired with this law). The agent
 * is told, through its own system prompt, that a run which ends without
 * a reachable dev server on the assigned port is an unfinished run.
 *
 * Rendered per agent lane, one canonical text:
 *  • CLINE — a workspace rules file (.clinerules/forgevi-platform.md):
 *    Cline's native mechanism for standing instructions, injected into
 *    its system prompt's "# Rules" section. Empirically verified against
 *    cline@3.0.64 (mock-LLM harness): the built-in Cline prompt, the
 *    tool docs and the full tool surface are preserved; the rules land
 *    verbatim under "# Rules / ## forgevi-platform".
 *  • OPENHANDS — the system-prompt addendum in the worker's job spec:
 *    the worker renders the SDK default agent's static system message,
 *    appends this text, and installs the combination via
 *    Agent.model_copy(update={"system_prompt": ...}) — verified against
 *    openhands-sdk 1.44.1 (the default prompt is preserved, not replaced).
 *
 * The dev-server port is the RUN's assigned port — dynamic facts stay
 * dynamic, carried per-run, never hardcoded into any template.
 */

/** The plain-text platform law (the OpenHands system-prompt addendum). */
export function platformLawText(devPort: number | null): string {
  const port = devPort && devPort > 0 ? String(devPort) : null;
  const finishLines = port
    ? [
        `1. If dependencies are not installed yet, install them first (npm install / bun install).`,
        `2. Start the dev server DETACHED so it outlives your terminal session AND the run itself: setsid nohup npm run dev -- -p ${port} -H 0.0.0.0 > /tmp/dev-server.log 2>&1 & (adapt the runner to the project — npm run dev / bun run dev / the framework's own dev command; NEVER bind to localhost only; NEVER drop the setsid — a plain nohup child dies with the command's process group, and the preview dies with it).`,
        `3. Verify it answers: curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port} must print an HTTP status (not 000). If it fails, read /tmp/dev-server.log, fix the cause, and start it again (with setsid).`,
        `4. A run that ends without a reachable dev server on port ${port} is an UNFINISHED run — the user's preview will be dead.`,
      ]
    : [
        `1. If dependencies are not installed yet, install them first (npm install / bun install).`,
        `2. Start the dev server DETACHED so it outlives your terminal session AND the run itself: setsid nohup npm run dev -- -p PORT -H 0.0.0.0 > /tmp/dev-server.log 2>&1 & (adapt the runner to the project; NEVER bind to localhost only; NEVER drop the setsid — a plain nohup child dies with the command's process group, and the preview dies with it).`,
        `3. Verify it answers: curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:PORT must print an HTTP status (not 000). If it fails, read /tmp/dev-server.log, fix the cause, and start it again (with setsid).`,
        `4. A run that ends without a reachable dev server is an UNFINISHED run — the user's preview will be dead.`,
      ];
  return [
    "[Forgevi platform laws — non-negotiable]",
    "You are building inside a Forgevi sandbox. The user previews your work LIVE through a dev server on an assigned port — the preview panel in their studio.",
    "",
    "THE FINISH LAW: when you finish making edits, spin up the development server BEFORE you finish.",
    ...finishLines,
    "",
    "While you work: keep the dev server running and re-verify it answers after significant changes.",
    "",
    "THE NARRATION LAW: the user watches a LIVE stream of your work — your messages and your tool calls appear in it, interleaved, in real time. Narrate like a senior engineer pairing with them: before each significant step (creating a file, installing dependencies, running a command, fixing an error), write ONE short plain-text sentence saying what you are about to do and why; after a surprising result, say what you found. Do not dump headers, plans or code in the narration — one or two sentences, then act. A silent wall of tool calls is a bad run: the stream shows the user what you are DOING but never what you are THINKING.",
    "",
    "THE NEXT.JS LAW: this platform builds Next.js apps (App Router + TypeScript + Tailwind CSS). If the workspace does not yet contain a Next.js app, create one first (package.json, next.config, tsconfig, src/app/). NEVER deliver the app as a standalone .html document — plain HTML files are only acceptable as assets inside public/ or as templates the Next.js app renders.",
  ].join("\n");
}

/** The markdown rules file (the Cline .clinerules/forgevi-platform.md). */
export function platformRulesMarkdown(devPort: number | null): string {
  const law = platformLawText(devPort);
  // The bracketed header line becomes the markdown H1; the numbered steps
  // and paragraphs flow unchanged beneath it.
  const body = law.replace(/^\[Forgevi platform laws — non-negotiable\]\n/, "");
  return (
    `# Forgevi platform laws (non-negotiable)\n` +
    body.trim() +
    `\n\n<!-- Maintained by the Forgevi platform — the agent's standing instructions, injected into the system prompt. Do not delete. -->\n`
  );
}
