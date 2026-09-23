/**
 * The baked E2B sandbox template for Forgevi 3.0 (e2b SDK v2 API).
 *
 * THE IN-VM AGENT LAW (2026-09-23, second generation): the REAL Cline CLI
 * agent runs INSIDE this microVM — headless (`--json` NDJSON +
 * `--auto-approve`), the npm package `cline` (a platform binary via
 * optionalDependencies — no Node runtime needed at exec; node+npm only
 * install it). The engine authenticates it per run lane (`cline auth -p
 * openrouter` with the pooled key + chain model) and relays its stdout
 * NDJSON into the run journal. The OpenHands venv stays baked as the
 * automatic fallback lane (ENGINE_AGENT=openhands forces it).
 *
 * Baked: node + npm (dev servers), the Cline CLI (the agent), python3 +
 * openhands-sdk 1.44.1 (the fallback agent), tmux, ripgrep, chromium
 * (browser previews). Build once (needs E2B_API_KEY):
 *
 *   E2B_API_KEY=e2b_... bun e2b-template/template.ts   # → prints the id
 *
 * Then set E2B_TEMPLATE_ID to that id on the engine (config-push works).
 * The workspace bootstrap (snapshot restore, uploads, scaffold) is done by
 * the ENGINE at boot — silent by law, never in the event stream.
 */

import { Template } from "e2b";

const DOCKERFILE = `
FROM e2bdev/base

# THE AGENT STACK — tmux (the SDK terminal tool's backend), ripgrep (its
# grep), and uv carrying a STANDALONE CPython 3.12 (Debian 12's system
# python is 3.11 — too old for openhands-sdk, whose every version requires
# >=3.12) + the pinned SDK in /opt/venv. EVERYTHING lives under /opt (uv's
# default install dirs sit under /root, which the runtime user cannot
# traverse); the engine invokes /opt/venv/bin/python3 EXPLICITLY — the
# sandbox runtime's PATH is owned by the platform, not the image.
# Pinned to 1.44.1 (1.49.1 regressed against NIM-class gateways — see
# requirements.txt in the repo root for the full note).
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential git curl tmux ripgrep procps ca-certificates \\
  && rm -rf /var/lib/apt/lists/* \\
  && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/opt/uv/bin sh \\
  && env UV_PYTHON_INSTALL_DIR=/opt/uv/python /opt/uv/bin/uv venv /opt/venv --python 3.12 \\
  && env UV_PYTHON_INSTALL_DIR=/opt/uv/python /opt/uv/bin/uv pip install --python /opt/venv/bin/python \\
    "openhands-sdk==1.44.1" "openhands-tools==1.44.1"

# THE CLINE LANE (2026-09-23): the Cline CLI autonomous agent — npm package
# "cline" (the platform binary @cline/cli-linux-x64 resolves via
# optionalDependencies; the version pinned to the one the engine's NDJSON
# contract was verified against). THE RUNTIME-USER LAW: E2B exec commands run
# as the unprivileged sandbox user — the engine keeps cline's config + data
# under /tmp/forgevi-cline (user-writable), never /opt/forgevi (root-owned).
RUN npm install -g cline@3.0.64 \\
  && cline --version

# browser_preview support: Chromium (baked, not installed at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    chromium fonts-liberation \\
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV OPENHANDS_SUPPRESS_BANNER=1

# the agent's home + the persistent workspace root
RUN mkdir -p /opt/forgevi && mkdir -p /workspace && chown user:user /workspace
WORKDIR /workspace
`;

export const forgeviTemplate = Template().fromDockerfile(DOCKERFILE);

if (import.meta.main) {
  const info = await Template.build(forgeviTemplate, "forgevi-3", {
    onBuildLogs: (entry) => {
      const e = entry as { timestamp?: { toISOString?: () => string }; source?: string; message?: string };
      const line = `${e.timestamp?.toISOString?.() ?? ""} [${e.source ?? "build"}] ${e.message ?? JSON.stringify(entry)}`;
      process.stdout.write(line + "\n");
    },
  });
  console.log("[forgevi-3] template built:", JSON.stringify(info, null, 2));
}
