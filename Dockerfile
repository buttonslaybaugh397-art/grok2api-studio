# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY src ./src
COPY .env.example ./.env.example

# Build as same-origin SPA; runtime proxy target is injected via env.
ENV VITE_API_BASE_URL=
ENV VITE_DEV_PROXY_TARGET=http://127.0.0.1:8000
RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4175 \
    STUDIO_PROXY_TARGET=http://host.docker.internal:8000

COPY --from=builder /app/dist ./dist
COPY package.json ./package.json
COPY server.mjs ./server.mjs

EXPOSE 4175

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4175/__proxy/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
