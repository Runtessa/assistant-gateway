const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4040);
const HOST = process.env.HOST || '0.0.0.0';
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const ROOT_DIR = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, "..", ".."));
const HISTORY_FILE = path.resolve(
  process.env.CODEX_GATEWAY_HISTORY_FILE || path.join(__dirname, "..", "data", "history.json"),
);
const PROFILES_DIR = path.resolve(
  process.env.CODEX_GATEWAY_PROFILES_DIR || path.join(__dirname, "..", "data", "profiles"),
);
const WORKSPACES_DIR = path.resolve(
  process.env.CODEX_GATEWAY_WORKSPACES_DIR || path.join(__dirname, "..", "data", "workspaces"),
);
const WORKSPACE_ACCESS_MODE = String(
  process.env.CODEX_GATEWAY_WORKSPACE_ACCESS_MODE ||
    process.env.AGENT_CODEX_GATEWAY_WORKSPACE_ACCESS_MODE ||
    "tenant",
)
  .trim()
  .toLowerCase();

const CODEX_MAX_PROMPT_CHARS = Number(process.env.CODEX_GATEWAY_MAX_PROMPT_CHARS || 120000);
const CODEX_MAX_CONTEXT_CHARS = Number(process.env.CODEX_GATEWAY_MAX_CONTEXT_CHARS || 60000);
const CODEX_MAX_SUMMARY_CHARS = Number(process.env.CODEX_GATEWAY_MAX_SUMMARY_CHARS || 12000);
const CODEX_MAX_HISTORY_ITEMS = Number(process.env.CODEX_GATEWAY_MAX_HISTORY_ITEMS || 120);
const CODEX_RECENT_HISTORY_ITEMS = Number(process.env.CODEX_GATEWAY_RECENT_HISTORY_ITEMS || 12);
const CODEX_HISTORY_ENTRY_CHARS = Number(
  process.env.CODEX_GATEWAY_HISTORY_ENTRY_CHARS || 1800,
);

const LOGIN_SESSION_MAX_AGE_MS = Number(
  process.env.CODEX_GATEWAY_LOGIN_SESSION_MAX_AGE_MS || 24 * 60 * 60 * 1000,
);
const LOGIN_RATE_LIMIT_COOLDOWN_MS = Number(
  process.env.CODEX_GATEWAY_LOGIN_RATE_LIMIT_COOLDOWN_MS || 60 * 1000,
);

const STARTED_AT = new Date();

const resolveGatewayVersion = () => {
  const fromEnv = String(process.env.CODEX_GATEWAY_VERSION || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const version = String(pkg?.version || "").trim();
    if (version) return version;
  } catch {
    // no-op
  }
  return "0.0.0-dev";
};

const resolveAvailableModels = () => {
  const explicit = String(process.env.AGENT_CODEX_MODELS || process.env.CODEX_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const fallback = String(process.env.AGENT_CODEX_MODEL || "").trim();
  const defaults = String(process.env.AGENT_CODEX_MODELS_DEFAULT || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = new Set(explicit);
  if (fallback) unique.add(fallback);
  if (!unique.size) {
    defaults.forEach((model) => unique.add(model));
  }
  return Array.from(unique);
};

module.exports = {
  PORT,
  HOST,
  CODEX_BIN,
  ROOT_DIR,
  HISTORY_FILE,
  PROFILES_DIR,
  WORKSPACES_DIR,
  WORKSPACE_ACCESS_MODE,
  STARTED_AT,
  GATEWAY_VERSION: resolveGatewayVersion(),
  CODEX_MAX_PROMPT_CHARS,
  CODEX_MAX_CONTEXT_CHARS,
  CODEX_MAX_SUMMARY_CHARS,
  CODEX_MAX_HISTORY_ITEMS,
  CODEX_RECENT_HISTORY_ITEMS,
  CODEX_HISTORY_ENTRY_CHARS,
  LOGIN_SESSION_MAX_AGE_MS,
  LOGIN_RATE_LIMIT_COOLDOWN_MS,
  resolveAvailableModels,
};
