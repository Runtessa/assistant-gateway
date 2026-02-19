FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@latest

WORKDIR /app

COPY package.json ./package.json
RUN npm install --omit=dev

COPY index.js ./index.js
COPY lib ./lib

ENV PORT=4040
ENV WORKSPACE_ROOT=/workspace
ENV CODEX_GATEWAY_HISTORY_FILE=/data/history.json
ENV CODEX_GATEWAY_PROFILES_DIR=/data/profiles

RUN mkdir -p /data /workspace

EXPOSE 4040

CMD ["node", "index.js"]
