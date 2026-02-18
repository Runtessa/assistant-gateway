const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { CODEX_BIN, ROOT_DIR, PROFILES_DIR } = require("./config");

const safeCwd = (cwd) => {
  if (!cwd) return ROOT_DIR;
  const resolved = path.resolve(cwd);
  if (!resolved.startsWith(ROOT_DIR)) {
    throw new Error(`cwd must stay under workspace root: ${ROOT_DIR}`);
  }
  return resolved;
};

const safeUserId = (value) => String(value || "anonymous").replace(/[^a-zA-Z0-9._-]/g, "_");
const resolveCodexHome = (userId) => path.join(PROFILES_DIR, safeUserId(userId));

const buildCodexEnv = (userId) => {
  const codexHome = resolveCodexHome(userId);
  fs.mkdirSync(codexHome, { recursive: true });
  return { ...process.env, CODEX_HOME: codexHome };
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
  const keepPrefixes = ["OPENAI_", "CODEX_"];
  const env = {};

  Object.entries(process.env || {}).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    if (keepKeys.has(key) || keepPrefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  });
  env.CODEX_HOME = codexHome;
  return env;
};

const spawnCodexWithFallback = ({ args, cwd, userId, stdio }) => {
  try {
    return {
      child: spawn(CODEX_BIN, args, { cwd, env: buildCodexEnv(userId), stdio }),
      usedSlimEnv: false,
    };
  } catch (error) {
    if (error?.code !== "E2BIG") throw error;
    return {
      child: spawn(CODEX_BIN, args, { cwd, env: buildSlimCodexEnv(userId), stdio }),
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

const runCodex = ({ prompt, model, cwd, userId, onStdout, onStderr, onClose }) => {
  const args = ["exec", "--skip-git-repo-check", "--full-auto", "--json"];
  if (model) args.push("-m", String(model));
  args.push("-");

  let child;
  try {
    const spawned = spawnCodexWithFallback({ args, cwd, userId, stdio: ["pipe", "pipe", "pipe"] });
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

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const candidate = getLastMessage(line);
        if (candidate) lastMessage = candidate;
        onStdout?.(line);
      });
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => onStderr?.(line));
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
  spawnCodexWithFallback,
  runCodex,
  getLastMessage,
  extractLastMessageFromStdout,
};
