# Forgevi 3.1 — the engine image.
#
# One container, two runtimes:
#   - bun  : the engine shell (src/server.ts — the Forgvi wire contract)
#   - python + openhands-sdk : the agent (openhands/worker.py, one process
#     per run — the REAL OpenHands agent: terminal + file editor + task
#     tracker, its own system prompt, its own loop, its own finish).
#
# tmux: REQUIRED by the OpenHands SDK terminal tool (libtmx drives a tmux
#       session for the agent's shell); ripgrep: OpenHands grep tool.
# node/npm: the agent's workspaces run dev servers.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential git curl tmux ripgrep procps nodejs npm ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# bun runtime (the engine shell) — copied from the official image
COPY --from=oven/bun:1.2-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# THE CLINE LANE (2026-09-23): the Cline CLI autonomous agent — the DEFAULT
# in-VM agent for E2B runs AND the agent for the degraded local lane (the
# engine container's own filesystem when every pooled E2B key is dead).
# Platform binary — no Node runtime needed at exec; pinned to the version
# the engine's NDJSON contract was verified against (src/cline.ts).
RUN npm install -g cline@3.0.64

WORKDIR /app

# The OpenHands SDK (pinned — see requirements.txt)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# engine shell deps (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# the app
COPY tsconfig.json ./
COPY src ./src
COPY openhands ./openhands
COPY e2b-template ./e2b-template

# Render injects PORT; the engine also honors ENGINE_PORT
ENV ENGINE_PORT=3010
EXPOSE 3010

CMD ["bun", "src/server.ts"]
