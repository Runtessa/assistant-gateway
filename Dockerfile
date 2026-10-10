# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:22-alpine

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_PROGRESS=false
ENV NPM_CONFIG_PREFER_OFFLINE=true
ENV NPM_CONFIG_FETCH_RETRIES=10
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=30000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000
ENV NPM_CONFIG_FETCH_TIMEOUT=1800000

ARG CODEX_CLI_VERSION=0.162.1
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION} --no-audit --no-fund

WORKDIR /app

COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /app/
COPY licenses /app/licenses


COPY .docker-build/codex-gateway/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY .docker-build/codex-gateway/dist ./dist

ENV PORT=4040
ENV WORKSPACE_ROOT=/workspace
ENV CODEX_GATEWAY_HISTORY_FILE=/data/history.json
ENV CODEX_GATEWAY_PROFILES_DIR=/data/profiles
ENV CODEX_GATEWAY_WORKSPACES_DIR=/data/workspaces

RUN mkdir -p /data /data/workspaces /workspace

EXPOSE 4040

CMD ["node", "dist/index.js"]
