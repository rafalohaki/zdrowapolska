# Backend: Bun + Hono, TS natywnie (bez kroku kompilacji)
FROM oven/bun:1 AS base
WORKDIR /app

# zależności produkcyjne (hono) — lockfile gwarantuje powtarzalność
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server ./server
# parser współdzielony z frontendem (czysty TS, bez zależności DOM)
COPY src/lib ./src/lib

ENV NODE_ENV=production
# Wersja obrazu — /api/health wystawia GIT_SHA/BUILD_AT, deploy weryfikuje po nich
# świeżość (compose przekazuje build-args; bez nich pola są puste w health)
ARG GIT_SHA=unknown
ARG BUILD_AT=unknown
ENV GIT_SHA=${GIT_SHA} \
    BUILD_AT=${BUILD_AT}
RUN mkdir -p /app/data
EXPOSE 2363

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 2363) + '/api/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "server/index.ts"]
