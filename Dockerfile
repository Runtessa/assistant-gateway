# syntax=docker/dockerfile:1.7
FROM node:22-alpine

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_PROGRESS=false
ENV NPM_CONFIG_PREFER_OFFLINE=true
ENV NPM_CONFIG_FETCH_RETRIES=10
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=30000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=300000
ENV NPM_CONFIG_FETCH_TIMEOUT=1800000

RUN --mount=type=cache,target=/root/.npm,id=npm-codex-global,sharing=locked \
    npm install -g @openai/codex@latest --no-audit --no-fund

WORKDIR /app

COPY .docker-build/codex-gateway/package.json ./package.json
RUN --mount=type=cache,target=/root/.npm,id=npm-codex-gateway,sharing=locked \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund \
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
