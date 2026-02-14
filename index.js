const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4040);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const ROOT_DIR = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, ".."));
const HISTORY_FILE = path.resolve(
  process.env.CODEX_GATEWAY_HISTORY_FILE || path.join(__dirname, "data", "history.json"),
);
const PROFILES_DIR = path.resolve(
  process.env.CODEX_GATEWAY_PROFILES_DIR || path.join(__dirname, "data", "profiles"),
);
const STARTED_AT = new Date();
const resolveGatewayVersion = () => {
  const fromEnv = String(process.env.CODEX_GATEWAY_VERSION || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const pkgPath = path.join(__dirname, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const version = String(pkg?.version || "").trim();
    if (version) return version;
  } catch {
    // no-op
  }
  return "0.0.0-dev";
};
const GATEWAY_VERSION = resolveGatewayVersion();
const chatSessions = new Map();
let historySaveQueue = Promise.resolve();
const loginSessions = new Map();

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

const resolveAvailableModels = () => {
  const explicit = String(
    process.env.AGENT_CODEX_MODELS || process.env.CODEX_MODELS || "",
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const fallback = String(process.env.AGENT_CODEX_MODEL || "").trim();
  const defaults = String(
    process.env.AGENT_CODEX_MODELS_DEFAULT ||
      "gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex,codex-mini-latest",
  )
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

const nowIso = () => new Date().toISOString();

const createId = (prefix) => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
};

const stripAnsi = (value) =>
  String(value || "")
    // Strip OSC and CSI sequences.
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    // Remove remaining C0 controls except tab/newline/carriage return.
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");

const parseUserCode = (line) => {
  const clean = stripAnsi(line).toUpperCase();
  const match = clean.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/);
  return match ? match[0] : "";
};

const parseAuthUrl = (line) => {
  const clean = stripAnsi(line);
  const match = clean.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return "";
  return match[0].replace(/[.,;:!?]+$/, "");
};

const serializeLoginSession = (session) => ({
  sessionId: session.sessionId,
  userId: session.userId,
  mode: session.mode,
  status: session.status,
  authUrl: session.authUrl,
  userCode: session.userCode,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
  completedAt: session.completedAt || null,
  exitCode: session.exitCode,
  logs: session.logs.slice(-120),
  callbackData: session.callbackData || null,
  callbackUrl: session.callbackUrl || "",
  errorCode: session.errorCode || "",
  errorMessage: session.errorMessage || "",
  rateLimitedUntil: session.rateLimitedUntil || null,
});

const appendLoginLog = (session, line, source = "stdout") => {
  const text = stripAnsi(line).trim();
  if (!text) return;
  session.logs.push(`[${source}] ${text}`);
  if (session.logs.length > 200) {
    session.logs.splice(0, session.logs.length - 200);
  }
  if (!session.authUrl && source !== "meta" && source !== "callback") {
    const url = parseAuthUrl(text);
    if (url) session.authUrl = url;
  }
  if (!session.userCode && source !== "meta" && source !== "callback") {
    const code = parseUserCode(text);
    if (code) session.userCode = code;
  }
  if (source !== "meta" && source !== "callback" && isRateLimitText(text)) {
    markSessionRateLimited(session, text);
  }
  session.updatedAt = nowIso();
};

const sweepExpiredLoginSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of loginSessions.entries()) {
    if (session.child && !session.child.killed) continue;
    const updated = Date.parse(session.updatedAt || session.startedAt || nowIso());
    if (Number.isNaN(updated)) continue;
    if (now - updated > LOGIN_SESSION_MAX_AGE_MS) {
      loginSessions.delete(sessionId);
    }
  }
};

const createLoginSession = ({ userId, mode, callbackUrl }) => {
  sweepExpiredLoginSessions();
  const startedAt = nowIso();
  const session = {
    sessionId: createId("login"),
    userId: String(userId || "anonymous"),
    mode: mode || "device-auth",
    status: "starting",
    authUrl: "",
    userCode: "",
    startedAt,
    updatedAt: startedAt,
    completedAt: "",
    exitCode: null,
    logs: [],
    callbackData: null,
    callbackUrl: String(callbackUrl || ""),
    errorCode: "",
    errorMessage: "",
    rateLimitedUntil: "",
    child: null,
  };
  loginSessions.set(session.sessionId, session);
  return session;
};

const isRateLimitText = (value) =>
  /\b429\b/i.test(String(value || "")) || /too many requests/i.test(String(value || ""));

const markSessionRateLimited = (session, line) => {
  session.errorCode = "rate_limited";
  session.errorMessage = String(line || "").trim() || "429 Too Many Requests";
  session.rateLimitedUntil = new Date(Date.now() + LOGIN_RATE_LIMIT_COOLDOWN_MS).toISOString();
};

const getLatestUserLoginSession = (userId) => {
  const target = String(userId || "anonymous");
  let winner = null;
  let winnerTs = 0;
  for (const session of loginSessions.values()) {
    if (session.userId !== target) continue;
    const ts = Date.parse(session.updatedAt || session.startedAt || nowIso());
    if (Number.isNaN(ts)) continue;
    if (ts > winnerTs) {
      winner = session;
      winnerTs = ts;
    }
  }
  return winner;
};

const streamChildLines = (child, onStdoutLine, onStderrLine) => {
  let outBuffer = "";
  let errBuffer = "";
  child.stdout.on("data", (chunk) => {
    outBuffer += chunk.toString("utf8");
    let idx = outBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = outBuffer.slice(0, idx);
      outBuffer = outBuffer.slice(idx + 1);
      onStdoutLine?.(line);
      idx = outBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    errBuffer += chunk.toString("utf8");
    let idx = errBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = errBuffer.slice(0, idx);
      errBuffer = errBuffer.slice(idx + 1);
      onStderrLine?.(line);
      idx = errBuffer.indexOf("\n");
    }
  });
  child.on("close", () => {
    const pendingOut = outBuffer.trim();
    if (pendingOut) onStdoutLine?.(pendingOut);
    const pendingErr = errBuffer.trim();
    if (pendingErr) onStderrLine?.(pendingErr);
  });
};

const startDeviceAuthLogin = (session) => {
  let child;
  try {
    child = spawnCodexWithFallback({
      args: ["login", "--device-auth"],
      cwd: ROOT_DIR,
      userId: session.userId,
      stdio: ["ignore", "pipe", "pipe"],
    }).child;
  } catch (error) {
    const message = error?.message || String(error) || "failed to spawn codex login";
    appendLoginLog(session, message, "stderr");
    session.errorCode = "spawn_error";
    session.errorMessage = message;
    session.status = "failed";
    session.exitCode = 1;
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    session.child = null;
    return;
  }
  session.child = child;
  session.status = "running";
  session.updatedAt = nowIso();
  appendLoginLog(session, "Device auth flow started");

  streamChildLines(
    child,
    (line) => appendLoginLog(session, line, "stdout"),
    (line) => appendLoginLog(session, line, "stderr"),
  );

  child.on("error", (error) => {
    appendLoginLog(session, error.message || String(error), "stderr");
    if (isRateLimitText(error.message || String(error))) {
      markSessionRateLimited(session, error.message || String(error));
    } else {
      session.errorCode = "spawn_error";
      session.errorMessage = error.message || String(error);
    }
    session.status = "failed";
    session.exitCode = 1;
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    session.child = null;
  });
  child.on("close", (code) => {
    session.exitCode = typeof code === "number" ? code : 1;
    session.status = session.exitCode === 0 ? "completed" : "failed";
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    session.child = null;
    const latestLog = session.logs[session.logs.length - 1] || "";
    if (isRateLimitText(latestLog) && !session.rateLimitedUntil) {
      markSessionRateLimited(session, latestLog);
    }
    if (!session.errorCode && session.status !== "completed") {
      session.errorCode = "login_failed";
      session.errorMessage = latestLog || `Device auth failed (code ${session.exitCode})`;
    }
    appendLoginLog(
      session,
      session.status === "completed"
        ? "Device auth completed"
        : `Device auth failed (code ${session.exitCode})`,
    );
  });
  return child;
};

const stopAllLoginChildren = () => {
  for (const session of loginSessions.values()) {
    const child = session.child;
    if (!child || child.killed) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      // no-op
    }
  }
};

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

const parseBody = async (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const normalizeHistoryEntries = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: String(item.role || "assistant"),
      text: String(item.text || "").slice(0, CODEX_HISTORY_ENTRY_CHARS),
    }))
    .filter(
      (item) =>
        item.text.trim().length > 0 && ["user", "assistant", "system"].includes(item.role),
    );
};

const normalizeSummary = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(-CODEX_MAX_SUMMARY_CHARS);
};

const createEmptySession = () => ({
  summary: "",
  history: [],
  updatedAt: nowIso(),
});

const normalizeSession = (value) => {
  if (Array.isArray(value)) {
    return {
      summary: "",
      history: normalizeHistoryEntries(value).slice(-CODEX_MAX_HISTORY_ITEMS),
      updatedAt: nowIso(),
    };
  }
  if (!value || typeof value !== "object") return createEmptySession();
  return {
    summary: normalizeSummary(value.summary),
    history: normalizeHistoryEntries(value.history).slice(-CODEX_MAX_HISTORY_ITEMS),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : nowIso(),
  };
};

const summarizeEntries = (entries) =>
  entries
    .map((entry) => {
      const role = entry.role === "assistant" ? "Assistant" : "User";
      const compact = String(entry.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      return compact ? `${role}: ${compact}` : "";
    })
    .filter(Boolean)
    .join("\n");

const appendSummary = (existing, chunk) => {
  const parts = [String(existing || "").trim(), String(chunk || "").trim()].filter(Boolean);
  if (!parts.length) return "";
  return parts.join("\n").slice(-CODEX_MAX_SUMMARY_CHARS);
};

const compactSession = (session) => {
  if (!session || !Array.isArray(session.history)) return createEmptySession();
  let history = normalizeHistoryEntries(session.history);
  let summary = normalizeSummary(session.summary);

  while (history.length > CODEX_MAX_HISTORY_ITEMS) {
    const moved = history.splice(0, Math.max(1, history.length - CODEX_MAX_HISTORY_ITEMS));
    summary = appendSummary(summary, summarizeEntries(moved));
  }

  while (history.length > CODEX_RECENT_HISTORY_ITEMS) {
    const overflow = history.length - CODEX_RECENT_HISTORY_ITEMS;
    if (overflow <= 0) break;
    const moved = history.splice(0, overflow);
    summary = appendSummary(summary, summarizeEntries(moved));
  }

  session.summary = summary;
  session.history = history;
  session.updatedAt = nowIso();
  return session;
};

const getSession = (sessionKey) => {
  const existing = chatSessions.get(sessionKey);
  if (existing) return compactSession(existing);
  const created = createEmptySession();
  chatSessions.set(sessionKey, created);
  return created;
};

const trimContext = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= CODEX_MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, CODEX_MAX_CONTEXT_CHARS)}\n…(context truncated by gateway)`;
};

const composePrompt = ({ systemPrompt, contextText, summary, history, prompt }) => {
  const sections = [];
  const sys = String(systemPrompt || "").trim();
  const ctx = String(contextText || "").trim();
  const sum = String(summary || "").trim();
  const hist = Array.isArray(history)
    ? history
        .map((entry) => `[${entry.role}] ${entry.text}`)
        .join("\n")
        .trim()
    : "";
  const latest = String(prompt || "").trim();
  if (sys) {
    sections.push("SYSTEM INSTRUCTIONS:");
    sections.push(sys);
  }
  if (ctx) {
    sections.push("WORKSPACE CONTEXT:");
    sections.push(ctx);
  }
  if (sum) {
    sections.push("COMPACTED CHAT SUMMARY:");
    sections.push(sum);
  }
  if (hist) {
    sections.push("RECENT CHAT HISTORY:");
    sections.push(hist);
  }
  sections.push("LATEST USER MESSAGE:");
  sections.push(latest || "(empty)");
  return sections.join("\n\n").trim();
};

const loadHistoryFromDisk = async () => {
  try {
    const raw = await fs.promises.readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    Object.entries(parsed).forEach(([key, value]) => {
      const normalized = normalizeSession(value);
      if (normalized.history.length || normalized.summary) {
        chatSessions.set(key, normalized);
      }
    });
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.error("[codex-gateway] failed to load history:", error.message || error);
    }
  }
};

const queueSaveHistory = () => {
  const serializable = Object.fromEntries(
    Array.from(chatSessions.entries()).map(([key, value]) => [
      key,
      {
        summary: normalizeSummary(value.summary),
        history: normalizeHistoryEntries(value.history),
        updatedAt: value.updatedAt || nowIso(),
      },
    ]),
  );
  const snapshot = JSON.stringify(serializable);
  historySaveQueue = historySaveQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
      await fs.promises.writeFile(HISTORY_FILE, snapshot, "utf8");
    })
    .catch((error) => {
      console.error("[codex-gateway] failed to save history:", error.message || error);
    });
  return historySaveQueue;
};

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
  return {
    ...process.env,
    CODEX_HOME: codexHome,
  };
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
      child: spawn(CODEX_BIN, args, {
        cwd,
        env: buildCodexEnv(userId),
        stdio,
      }),
      usedSlimEnv: false,
    };
  } catch (error) {
    if (error?.code !== "E2BIG") throw error;
    return {
      child: spawn(CODEX_BIN, args, {
        cwd,
        env: buildSlimCodexEnv(userId),
        stdio,
      }),
      usedSlimEnv: true,
    };
  }
};

const buildPrompt = (payload) => {
  const userId = String(payload.userId || "anonymous");
  const chatId = String(payload.chatId || "default");
  const sessionKey = `${userId}::${chatId}`;
  const prompt = String(payload.prompt || "").trim();
  const fullPromptInput = String(payload.fullPrompt || "").trim();
  const systemPrompt = String(payload.systemPrompt || "").trim();
  const contextTextRaw = String(payload.contextText || "");
  const contextText = trimContext(contextTextRaw);
  if (!prompt && !fullPromptInput) throw new Error("prompt or fullPrompt is required");

  if (fullPromptInput) {
    return {
      userId,
      chatId,
      sessionKey,
      prompt: prompt || "(fullPrompt)",
      fullPrompt: fullPromptInput,
    };
  }

  const session = getSession(sessionKey);
  const working = compactSession({
    summary: session.summary,
    history: [...session.history],
    updatedAt: session.updatedAt,
  });

  let summary = working.summary;
  let history = [...working.history];
  let fullPrompt = composePrompt({
    systemPrompt,
    contextText,
    summary,
    history,
    prompt,
  });

  while (fullPrompt.length > CODEX_MAX_PROMPT_CHARS && history.length > 2) {
    const chunk = history.splice(0, Math.max(1, Math.ceil(history.length / 4)));
    summary = appendSummary(summary, summarizeEntries(chunk));
    fullPrompt = composePrompt({
      systemPrompt,
      contextText,
      summary,
      history,
      prompt,
    });
  }

  if (fullPrompt.length > CODEX_MAX_PROMPT_CHARS) {
    fullPrompt = `${fullPrompt.slice(0, CODEX_MAX_PROMPT_CHARS)}\n…(prompt truncated by gateway)`;
  }

  return {
    userId,
    chatId,
    sessionKey,
    prompt,
    fullPrompt,
    session,
  };
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
    const spawned = spawnCodexWithFallback({
      args,
      cwd,
      userId,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = spawned.child;
    if (spawned.usedSlimEnv) {
      onStderr?.("[gateway] spawn fallback: slim env used after E2BIG");
    }
  } catch (error) {
    const message = error?.message || String(error) || "failed to spawn codex";
    onStderr?.(`[gateway] spawn failed: ${message}`);
    onClose?.({ code: 1, signal: "", stdout: "", stderr: message, lastMessage: "" });
    return {
      killed: true,
      kill: () => {},
      on: () => {},
      once: () => {},
    };
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

const runCodexCommand = async ({
  args,
  cwd,
  userId,
  stdinText,
  timeoutMs = 0,
}) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCodexWithFallback({
        args,
        cwd,
        userId,
        stdio: ["pipe", "pipe", "pipe"],
      }).child;
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        ok: !timedOut && code === 0,
        code: timedOut ? 124 : typeof code === "number" ? code : 1,
        timedOut,
        stdout,
        stderr,
      });
    });

    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
  });

const runCodexAppServerModelList = async (userId) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCodexWithFallback({
        args: ["app-server"],
        cwd: ROOT_DIR,
        userId,
        stdio: ["pipe", "pipe", "pipe"],
      }).child;
    } catch (error) {
      reject(error);
      return;
    }

    let stdoutBuffer = "";
    let stderrText = "";
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      reject(new Error("codex app-server model/list timed out"));
    }, 15000);

    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      fn(value);
    };

    const resolveOnce = finish(resolve);
    const rejectOnce = finish(reject);

    child.stderr.on("data", (chunk) => {
      stderrText += chunk.toString("utf8");
    });

    const processLine = (line) => {
      const text = String(line || "").trim();
      if (!text) return;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (parsed && parsed.id === "2") {
        if (parsed.error) {
          const message =
            parsed.error?.message ||
            stderrText.trim() ||
            "model/list request failed";
          rejectOnce(new Error(String(message)));
          return;
        }
        const data = Array.isArray(parsed?.result?.data)
          ? parsed.result.data
          : [];
        resolveOnce(data);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let idx = stdoutBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        processLine(line);
        idx = stdoutBuffer.indexOf("\n");
      }
    });

    child.on("error", (error) => rejectOnce(error));
    child.on("close", (code) => {
      const pending = stdoutBuffer.trim();
      if (pending) processLine(pending);
      if (settled) return;
      const message = stderrText.trim() || `codex app-server exited with code ${code}`;
      rejectOnce(new Error(message));
    });

    const initReq = {
      id: "1",
      method: "initialize",
      params: {
        clientInfo: {
          name: "idp-codex-gateway",
          version: "1.0.0",
        },
      },
    };
    const initialized = { method: "initialized" };
    const modelListReq = { id: "2", method: "model/list", params: {} };
    child.stdin.write(`${JSON.stringify(initReq)}\n`);
    child.stdin.write(`${JSON.stringify(initialized)}\n`);
    child.stdin.write(`${JSON.stringify(modelListReq)}\n`);
    child.stdin.end();
  });

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true, service: "codex-gateway", port: PORT, root: ROOT_DIR });
  }

  if (req.method === "GET" && pathname === "/api/version") {
    return json(res, 200, {
      ok: true,
      service: "codex-gateway",
      version: GATEWAY_VERSION,
      startedAt: STARTED_AT.toISOString(),
      uptimeMs: Date.now() - STARTED_AT.getTime(),
    });
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const userId = requestUrl.searchParams.get("userId") || "anonymous";
    let rows = [];
    try {
      rows = await runCodexAppServerModelList(userId);
    } catch {
      rows = [];
    }
    const models =
      Array.isArray(rows) && rows.length
        ? rows
            .map((item) => String(item?.id || item?.model || "").trim())
            .filter(Boolean)
        : resolveAvailableModels();
    return json(res, 200, {
      ok: true,
      data: models.map((id) => ({ id })),
    });
  }

  if (req.method === "GET" && pathname === "/v1/login/status") {
    const userId = requestUrl.searchParams.get("userId") || "anonymous";
    const result = await runCodexCommand({
      args: ["login", "status"],
      cwd: ROOT_DIR,
      userId,
      timeoutMs: 15000,
    });
    const statusText = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = /logged in/i.test(statusText) && !/not logged in/i.test(statusText);
    const commandOk = result.ok || /not logged in/i.test(statusText);
    return json(res, 200, {
      ok: commandOk,
      code: result.code,
      loggedIn,
      status: statusText,
      codexHome: resolveCodexHome(userId),
    });
  }

  if (req.method === "POST" && pathname === "/v1/login/start") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }

    const userId = String(payload.userId || "anonymous");
    const mode = payload.mode === "device-auth" ? "device-auth" : "device-auth";
    const callbackUrl =
      typeof payload.callbackUrl === "string" ? payload.callbackUrl.trim() : "";

    const latest = getLatestUserLoginSession(userId);
    if (latest) {
      const isActive =
        (latest.status === "starting" || latest.status === "running") &&
        latest.child &&
        !latest.child.killed;
      if (isActive) {
        if (callbackUrl && !latest.callbackUrl) {
          latest.callbackUrl = callbackUrl;
          appendLoginLog(latest, `Callback URL set: ${callbackUrl}`, "meta");
        }
        return json(res, 200, {
          ok: true,
          reused: true,
          ...serializeLoginSession(latest),
        });
      }

      if (latest.rateLimitedUntil) {
        const untilMs = Date.parse(latest.rateLimitedUntil);
        if (!Number.isNaN(untilMs) && untilMs > Date.now()) {
          return json(res, 429, {
            ok: false,
            error: "device code request failed with status 429 Too Many Requests",
            retryAfterMs: untilMs - Date.now(),
            reused: true,
            ...serializeLoginSession(latest),
          });
        }
      }
    }

    const session = createLoginSession({ userId, mode, callbackUrl });
    if (callbackUrl) {
      appendLoginLog(session, `Callback URL set: ${callbackUrl}`, "meta");
    }
    startDeviceAuthLogin(session);
    return json(res, 202, {
      ok: true,
      ...serializeLoginSession(session),
    });
  }

  if (req.method === "GET" && pathname.startsWith("/v1/login/session/")) {
    const sessionId = decodeURIComponent(pathname.slice("/v1/login/session/".length)).trim();
    if (!sessionId) {
      return json(res, 400, { error: "sessionId is required" });
    }
    const session = loginSessions.get(sessionId);
    if (!session) {
      return json(res, 404, { error: "Login session not found" });
    }
    return json(res, 200, {
      ok: true,
      ...serializeLoginSession(session),
    });
  }

  if (req.method === "POST" && pathname === "/v1/login/callback") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) {
      return json(res, 400, { error: "sessionId is required" });
    }
    const session = loginSessions.get(sessionId);
    if (!session) {
      return json(res, 404, { error: "Login session not found" });
    }
    session.callbackData = payload.callbackData ?? payload;
    session.updatedAt = nowIso();
    appendLoginLog(session, "Callback payload received", "callback");
    return json(res, 200, {
      ok: true,
      ...serializeLoginSession(session),
    });
  }

  if (req.method === "POST" && pathname === "/v1/login") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const userId = String(payload.userId || "anonymous");
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    // In hosted/remote containers localhost callback is not usable from end-user browser.
    // Default to device-auth unless API key login is explicitly provided.
    const deviceAuth = apiKey ? false : payload.deviceAuth !== false;

    const args = apiKey
      ? ["login", "--with-api-key"]
      : ["login", "--device-auth"];
    const result = await runCodexCommand({
      args,
      cwd: ROOT_DIR,
      userId,
      stdinText: apiKey ? `${apiKey}\n` : "",
      timeoutMs: deviceAuth ? 5 * 60 * 1000 : 120000,
    });
    const statusText = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = /logged in/i.test(statusText) && !/not logged in/i.test(statusText);
    return json(res, result.ok || loggedIn ? 200 : 500, {
      ok: result.ok || loggedIn,
      code: result.code,
      timedOut: result.timedOut,
      mode: apiKey ? "api-key" : deviceAuth ? "device-auth" : "interactive",
      loggedIn,
      status: statusText,
      codexHome: resolveCodexHome(userId),
    });
  }

  if (req.method === "POST" && pathname === "/v1/logout") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const userId = String(payload.userId || "anonymous");
    const result = await runCodexCommand({
      args: ["logout"],
      cwd: ROOT_DIR,
      userId,
      timeoutMs: 30000,
    });
    const statusText = `${result.stdout}\n${result.stderr}`.trim();
    return json(res, result.ok ? 200 : 500, {
      ok: result.ok,
      code: result.code,
      status: statusText,
      codexHome: resolveCodexHome(userId),
    });
  }

  if (req.method === "POST" && pathname === "/v1/exec") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }

    let promptData;
    let cwd;
    try {
      promptData = buildPrompt(payload);
      cwd = safeCwd(payload.cwd);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }

    const stream = payload.stream !== false;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: status\ndata: ${JSON.stringify({ state: "started" })}\n\n`);

      const child = runCodex({
        prompt: promptData.fullPrompt,
        model: payload.model,
        cwd,
        userId: promptData.userId,
        onStdout: (line) => res.write(`event: stdout\ndata: ${JSON.stringify({ line })}\n\n`),
        onStderr: (line) => res.write(`event: stderr\ndata: ${JSON.stringify({ line })}\n\n`),
        onClose: ({ code, signal, lastMessage, stderr }) => {
          const session = getSession(promptData.sessionKey);
          session.history.push({
            role: "user",
            text: String(promptData.prompt || "").slice(0, CODEX_HISTORY_ENTRY_CHARS),
          });
          if (lastMessage) {
            session.history.push({
              role: "assistant",
              text: String(lastMessage).slice(0, CODEX_HISTORY_ENTRY_CHARS),
            });
          }
          compactSession(session);
          chatSessions.set(promptData.sessionKey, session);
          void queueSaveHistory();

          res.write(
            `event: done\ndata: ${JSON.stringify({
              code,
              signal: signal || "",
              ok: code === 0,
              message: lastMessage || "",
              error:
                code === 0
                  ? ""
                  : stderr.trim() || (signal ? `terminated by ${signal}` : "process failed"),
            })}\n\n`,
          );
          res.end();
        },
      });

      const stopChildIfStreamingClientGone = () => {
        if (res.writableEnded || res.destroyed) return;
        if (!child.killed) child.kill("SIGTERM");
      };
      req.on("aborted", stopChildIfStreamingClientGone);
      res.on("close", stopChildIfStreamingClientGone);

      return;
    }

    runCodex({
      prompt: promptData.fullPrompt,
      model: payload.model,
      cwd,
      userId: promptData.userId,
      onClose: ({ code, stdout, stderr, lastMessage }) => {
        const session = getSession(promptData.sessionKey);
        session.history.push({
          role: "user",
          text: String(promptData.prompt || "").slice(0, CODEX_HISTORY_ENTRY_CHARS),
        });
        if (lastMessage) {
          session.history.push({
            role: "assistant",
            text: String(lastMessage).slice(0, CODEX_HISTORY_ENTRY_CHARS),
          });
        }
        compactSession(session);
        chatSessions.set(promptData.sessionKey, session);
        void queueSaveHistory();

        json(res, code === 0 ? 200 : 500, {
          ok: code === 0,
          code,
          stdout,
          stderr,
          message: lastMessage || "",
        });
      },
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

const start = async () => {
  await loadHistoryFromDisk();
  setInterval(() => {
    sweepExpiredLoginSessions();
  }, 5 * 60 * 1000).unref?.();
  console.log(
    `[codex-gateway] loaded ${chatSessions.size} persisted chat context(s) from ${HISTORY_FILE}`,
  );
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[codex-gateway] listening on http://127.0.0.1:${PORT}`);
    console.log(`[codex-gateway] workspace root: ${ROOT_DIR}`);
  });
};

process.on("SIGTERM", () => {
  stopAllLoginChildren();
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  stopAllLoginChildren();
  server.close(() => process.exit(0));
});

start().catch((error) => {
  console.error("[codex-gateway] failed to start:", error.message || error);
  process.exit(1);
});
