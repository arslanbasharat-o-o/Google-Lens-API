# syntax=docker/dockerfile:1.7

FROM node:20.19.0-bookworm-slim AS deps

WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.19.0-bookworm-slim AS prod-deps

WORKDIR /app
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && chown -R node:node /app /ms-playwright

FROM node:20.19.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LENS_ADAPTER=scrapling \
    QUEUE_BACKEND=redis \
    REDIS_URL=redis://redis:6379 \
    IMAGE_STORAGE_BACKEND=file \
    IMAGE_STORAGE_DIR=/var/lib/lens/images \
    GOOGLE_LENS_LIVE_ENABLED=false \
    GOOGLE_LENS_LIVE_AUTHORIZED=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_update_notifier=false

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=prod-deps --chown=node:node /ms-playwright /ms-playwright
RUN mkdir -p /var/lib/lens/images && chown -R node:node /var/lib/lens

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
