FROM node:20.19.0-bookworm-slim AS build

WORKDIR /app
ENV npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.19.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LENS_ADAPTER=playwright \
    GOOGLE_LENS_LIVE_ENABLED=false \
    GOOGLE_LENS_LIVE_AUTHORIZED=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && chown -R node:node /ms-playwright /app
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
