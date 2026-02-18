const { ROOT_DIR, spawnCodexWithFallback } = require("./codexRunner");
const { LOGIN_RATE_LIMIT_COOLDOWN_MS, LOGIN_SESSION_MAX_AGE_MS } = require("./config");
const { createId, isRateLimitText, nowIso, parseAuthUrl, parseUserCode, stripAnsi } = require("./utils");

const loginSessions = new Map();

const markSessionRateLimited = (session, line) => {
  session.errorCode = "rate_limited";
  session.errorMessage = String(line || "").trim() || "429 Too Many Requests";
  session.rateLimitedUntil = new Date(Date.now() + LOGIN_RATE_LIMIT_COOLDOWN_MS).toISOString();
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

module.exports = {
  loginSessions,
  serializeLoginSession,
  appendLoginLog,
  sweepExpiredLoginSessions,
  createLoginSession,
  startDeviceAuthLogin,
  getLatestUserLoginSession,
  stopAllLoginChildren,
};
