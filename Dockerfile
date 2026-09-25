FROM oven/bun:1.4-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY public ./public
COPY src ./src

RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV NODE_ENV=production PORT=7100 DATABASE_PATH=/app/data/docket.db
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:7100/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "src/server/index.ts"]
