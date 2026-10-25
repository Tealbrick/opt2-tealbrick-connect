# Connect app image (SDK-API §15, C53 BSA-06: the template pattern). Base pinned by digest: node:24.22.1-bookworm-slim.
# Bump the tag and the digest together; CI pins the built image by digest in the release record.

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json tealbrick.manifest.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm run build && pnpm prune --prod --config.ignore-scripts=true

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tealbrick.manifest.json ./
COPY migrations ./migrations
COPY policies ./policies
# Standard manifest location in every opt2 image (tb-exec default --manifest path).
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json
# Data volume mount point (manifest runtime.volumes "data"); TB_DATA_DIR=/data, TB_BACKUP_DIR=/data/backup (C28).
RUN mkdir -p /data/backup && chown -R node:node /data
USER node
EXPOSE 8314
CMD ["node", "dist/main.js"]
