FROM oven/bun:1.2-slim
WORKDIR /app

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
