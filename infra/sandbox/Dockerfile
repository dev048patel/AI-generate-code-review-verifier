# Sandbox image for executing untrusted PR code (generated tests, Stryker,
# a repo's own test suite). Used by DockerExecutor (ACRV_SANDBOX=docker).
#
#   docker build -t acrv-sandbox:latest infra/sandbox
#
# DockerExecutor runs every command in a fresh container from this image with
# --network none, --read-only, --cap-drop ALL, no-new-privileges, pids/memory/
# CPU limits and a non-root user; add ACRV_DOCKER_RUNTIME=runsc (gVisor) in
# production so a container escape also has to get through a user-space kernel.
FROM node:22-slim

# git: some repos' test setups shell out to it. No compilers, no curl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/acrv
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && mkdir -p /opt/acrv/work \
 && chmod 0777 /opt/acrv/work

# Workspaces are bind-mounted here; living under /opt/acrv means Node's
# upward module resolution finds the tooling in /opt/acrv/node_modules.
WORKDIR /opt/acrv/work
USER node
