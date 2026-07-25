ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run test:gateway && npm run build

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    ADMIN_WEB_DIST_DIR=/app/dist

WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server/config.mjs /app/server/config.mjs
COPY --from=build --chown=node:node /app/server/static-handler.mjs /app/server/static-handler.mjs
COPY --from=build --chown=node:node /app/server/proxy-handler.mjs /app/server/proxy-handler.mjs
COPY --from=build --chown=node:node /app/server/server.mjs /app/server/server.mjs
COPY --from=build --chown=node:node /app/server/index.mjs /app/server/index.mjs

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server/index.mjs"]
