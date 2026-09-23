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
