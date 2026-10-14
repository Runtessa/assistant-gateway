const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require('node:readline');
const { createHash } = require('node:crypto');
const { CODEX_BIN, ROOT_DIR, PROFILES_DIR } = require("./config");

const { safeCwd } = require("./workspacePaths");
const { spawnIsolatedCodex } = require('./isolatedSpawn');
const { prepareScope } = require('./profileScope');

const safeUserId = (value) => String(value || "anonymous").replace(/[^a-zA-Z0-9._-]/g, "_");
const resolveCodexHome = (userId) => path.join(PROFILES_DIR, safeUserId(userId));
const resolveScopedHome = (userId, tenantId, chatId) => path.join(resolveCodexHome(userId), 'isolated-workspaces',
  createHash('sha256').update(JSON.stringify([String(tenantId), String(chatId || 'default')])).digest('hex'));

const buildCodexEnv = (userId) => {
  return buildSlimCodexEnv(userId);
};

const buildSlimCodexEnv = (userId) => {
  const codexHome = resolveCodexHome(userId);
  fs.mkdirSync(codexHome, { recursive: true });

  const keepKeys = new Set([
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]);
  const env = {};

  Object.entries(process.env || {}).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    if (keepKeys.has(key)) {
      env[key] = value;
    }
  });
  env.CODEX_HOME = codexHome;
  return env;
};

const spawnCodexWithFallback = ({ args, cwd, userId, tenantId, chatId, stdio }) => {
  let retainRefresh;
  const prepareEnv = () => {
    const env = buildSlimCodexEnv(userId);
    if (tenantId) {
      const primary = env.CODEX_HOME, scoped = resolveScopedHome(userId, tenantId, chatId);
      retainRefresh = prepareScope(primary, scoped);
      env.CODEX_HOME = scoped;
    }
    return env;
  };
  const env = prepareEnv();
  // Metadata/login commands need the user's profile, never the platform checkout.
  const isolatedCwd = !tenantId && args[0] !== 'exec' ? env.CODEX_HOME : cwd;
  const start = (environment) => {
    const child = spawnIsolatedCodex({ command: CODEX_BIN, args, cwd: isolatedCwd, env: environment, stdio });
    if (retainRefresh) child.once('close', () => { try { retainRefresh(); } catch { /* A refresh must never replace invalid primary credentials. */ } });
    return child;
  };
  try {
    return {
      child: start(env),
      usedSlimEnv: false,
    };
  } catch (error) {
    if (error?.code !== "E2BIG") throw error;
    return {
      child: start(prepareEnv()),
      usedSlimEnv: true,
    };
  }
};

const getLastMessage = (line) => {
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  const jsonLine = start >= 0 && end >= start ? line.slice(start, end + 1) : line;
  try {
    const parsed = JSON.parse(jsonLine);
    if (parsed?.type === "item.completed" && parsed?.item?.type === "agent_message") {
      if (typeof parsed?.item?.text === "string") return parsed.item.text;
      if (Array.isArray(parsed?.item?.content)) {
        const chunks = parsed.item.content
          .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
          .filter(Boolean);
        if (chunks.length) return chunks.join("\n");
      }
    }
    if (typeof parsed?.message === "string") return parsed.message;
    if (typeof parsed?.output === "string") return parsed.output;
    if (typeof parsed?.content === "string") return parsed.content;
    if (typeof parsed?.text === "string") return parsed.text;
    if (typeof parsed?.delta === "string") return parsed.delta;
    if (typeof parsed?.item?.text === "string") return parsed.item.text;
    if (Array.isArray(parsed?.item?.content)) {
      const chunks = parsed.item.content
        .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
        .filter(Boolean);
      if (chunks.length) return chunks.join("\n");
    }
    return "";
  } catch {
    return "";
  }
};

const extractLastMessageFromStdout = (stdoutText) => {
  let last = "";
  stdoutText
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => {
      const candidate = getLastMessage(line);
      if (candidate) last = candidate;
    });
  return last;
};

const runCodex = ({ prompt, model, cwd, userId, tenantId, chatId, readOnly = false, onStdout, onStderr, onClose }) => {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', readOnly ? 'read-only' : 'workspace-write',
    '-c', 'approval_policy="never"', '--json'];
  if (model) args.push("-m", String(model));
  args.push("-");

  let child;
  try {
    const spawned = spawnCodexWithFallback({ args, cwd, userId, tenantId, chatId, stdio: ["pipe", "pipe", "pipe"] });
    child = spawned.child;
    if (spawned.usedSlimEnv) {
      onStderr?.("[gateway] spawn fallback: slim env used after E2BIG");
    }
  } catch (error) {
    const message = error?.message || String(error) || "failed to spawn codex";
    onStderr?.(`[gateway] spawn failed: ${message}`);
    onClose?.({ code: 1, signal: "", stdout: "", stderr: message, lastMessage: "" });
    return { killed: true, kill: () => {}, on: () => {}, once: () => {} };
  }

  let stdout = "";
  let stderr = "";
  let lastMessage = "";

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    stdout += `${line}\n`;
    const candidate = getLastMessage(line);
    if (candidate) lastMessage = candidate;
    onStdout?.(line);
  });

  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
    stderr += `${line}\n`;
    onStderr?.(line);
  });

  child.on('error', (error) => {
    stderr += `${error.message}\n`;
    onStderr?.(`[gateway] ${error.message}`);
  });

  child.on("close", (code, signal) => {
    if (!lastMessage && stdout) {
      lastMessage = extractLastMessageFromStdout(stdout);
    }
    onClose?.({ code, signal, stdout, stderr, lastMessage });
  });

  try {
    child.stdin.write(String(prompt || ""));
    child.stdin.end();
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch {
      // no-op
    }
    onClose?.({
      code: 1,
      signal: "",
      stdout,
      stderr: String(error?.message || error || "failed to write prompt to stdin"),
      lastMessage,
    });
  }

  return child;
};

module.exports = {
  ROOT_DIR,
  safeCwd,
  resolveCodexHome,
  resolveScopedHome,
  spawnCodexWithFallback,
  runCodex,
  getLastMessage,
  extractLastMessageFromStdout,
};
