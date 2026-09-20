FROM oven/bun:1.2-slim
WORKDIR /app

# Node.js + build tools for the local-disk sandboxes (the agent's workspace
# runs `npm install` / `node` / `npx` — the slim image ships none of them).
# curl + git are the everyday workspace tools; procps gives `ps` its honest
# output. The E2B baked template carries its own toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates nodejs npm procps \
  && rm -rf /var/lib/apt/lists/*

# deps first (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# app
COPY tsconfig.json ./
COPY src ./src
COPY e2b-template ./e2b-template

# Render injects PORT; the engine also honors ENGINE_PORT
ENV ENGINE_PORT=3010
EXPOSE 3010

CMD ["bun", "src/server.ts"]
