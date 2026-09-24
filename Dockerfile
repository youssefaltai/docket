FROM oven/bun:1.4-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production PORT=7100 DATABASE_PATH=/app/data/docket.db
EXPOSE 7100
CMD ["bun", "src/server/index.ts"]
