# App image: one image, two roles (ACRV_ROLE=web | worker).
#   docker build -t acrv-app .
FROM node:22-slim

# git: the worker checks out PRs. docker CLI: the worker starts sandbox containers on the host daemon.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund \
 && npm run build --workspace=@acrv/dashboard \
 && npm cache clean --force

ENV NODE_ENV=production \
    ACRV_DASHBOARD_DIR=/app/packages/dashboard/dist \
    PORT=3001
EXPOSE 3001
USER node
CMD ["node_modules/.bin/tsx", "packages/server/src/index.ts"]
