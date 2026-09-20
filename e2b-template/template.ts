/**
 * The baked E2B sandbox template for Forgevi 3.0 (e2b SDK v2 API).
 *
 * Node toolchain + Chromium/Playwright so the browser_preview tool can
 * screenshot what the agent builds. Build once (needs E2B_API_KEY):
 *
 *   bun e2b-template/template.ts          # → prints the built template id
 *
 * Then set E2B_TEMPLATE_ID to that id on the engine. The workspace
 * bootstrap itself (snapshot restore, uploads, scaffold) is done by the
 * ENGINE at boot — silent by law, never in the event stream.
 */

import { Template } from "e2b";

const DOCKERFILE = `
FROM e2b-dev/base:nodec6a80a

# browser_preview support: Chromium (baked, not installed at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    chromium ca-certificates fonts-liberation \\
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# the persistent workspace root (the engine restores/injects here at boot — silently)
RUN mkdir -p /workspace && chown user:user /workspace
WORKDIR /workspace
`;

export const forgeviTemplate = Template().fromDockerfile(DOCKERFILE);

if (import.meta.main) {
  const info = await Template.build(forgeviTemplate, "forgevi-3");
  console.log("[forgevi-3] template built:", JSON.stringify(info, null, 2));
}
