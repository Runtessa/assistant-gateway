const { json, parseBody } = require("../http");
const { ROOT_DIR } = require("../config");
const { runCodexCommand } = require("../codexCommands");
const { resolveCodexHome } = require("../codexRunner");
const { clearScopedAuth } = require('../profileScope');
const {
  loginSessions,
  serializeLoginSession,
  appendLoginLog,
  createLoginSession,
  startDeviceAuthLogin,
  getLatestUserLoginSession,
} = require("../loginFlow");

const handleLoginRoutes = async ({ req, res, pathname }) => {
  if (req.method === "POST" && pathname === "/v1/login/start") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }

    const userId = req.gatewayIdentity.sub;
    const callbackUrl = typeof payload.callbackUrl === "string" ? payload.callbackUrl.trim() : "";

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
        json(res, 200, { ok: true, reused: true, ...serializeLoginSession(latest) });
        return true;
      }

      if (latest.rateLimitedUntil) {
        const untilMs = Date.parse(latest.rateLimitedUntil);
        if (!Number.isNaN(untilMs) && untilMs > Date.now()) {
          json(res, 429, {
            ok: false,
            error: "device code request failed with status 429 Too Many Requests",
            retryAfterMs: untilMs - Date.now(),
            reused: true,
            ...serializeLoginSession(latest),
          });
          return true;
        }
      }
    }

    const session = createLoginSession({ userId, mode: "device-auth", callbackUrl });
    if (callbackUrl) appendLoginLog(session, `Callback URL set: ${callbackUrl}`, "meta");
    startDeviceAuthLogin(session);
    json(res, 202, { ok: true, ...serializeLoginSession(session) });
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/v1/login/session/")) {
    const sessionId = decodeURIComponent(pathname.slice("/v1/login/session/".length)).trim();
    if (!sessionId) {
      json(res, 400, { error: "sessionId is required" });
      return true;
    }
    const session = loginSessions.get(sessionId);
    if (!session || session.userId !== req.gatewayIdentity.sub) {
      json(res, 404, { error: "Login session not found" });
      return true;
    }
    json(res, 200, { ok: true, ...serializeLoginSession(session) });
    return true;
  }

  if (req.method === "POST" && pathname === "/v1/login/callback") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }

    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) {
      json(res, 400, { error: "sessionId is required" });
      return true;
    }
    const session = loginSessions.get(sessionId);
    if (!session || session.userId !== req.gatewayIdentity.sub) {
      json(res, 404, { error: "Login session not found" });
      return true;
    }
    session.callbackData = payload.callbackData ?? payload;
    session.updatedAt = new Date().toISOString();
    appendLoginLog(session, "Callback payload received", "callback");
    json(res, 200, { ok: true, ...serializeLoginSession(session) });
    return true;
  }

  if (req.method === "POST" && pathname === "/v1/login") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }

    const userId = req.gatewayIdentity.sub;
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    const deviceAuth = apiKey ? false : payload.deviceAuth !== false;

    const result = await runCodexCommand({
      args: apiKey ? ["login", "--with-api-key"] : ["login", "--device-auth"],
      cwd: ROOT_DIR,
      userId,
      stdinText: apiKey ? `${apiKey}\n` : "",
      timeoutMs: deviceAuth ? 5 * 60 * 1000 : 120000,
    });

    const statusText = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = /logged in/i.test(statusText) && !/not logged in/i.test(statusText);
    json(res, result.ok || loggedIn ? 200 : 500, {
      ok: result.ok || loggedIn,
      code: result.code,
      timedOut: result.timedOut,
      mode: apiKey ? "api-key" : deviceAuth ? "device-auth" : "interactive",
      loggedIn,
      status: statusText,
      codexHome: resolveCodexHome(userId),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/v1/logout") {
    let payload;
    try {
      payload = await parseBody(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }
    const userId = req.gatewayIdentity.sub;
    clearScopedAuth(resolveCodexHome(userId));
    const result = await runCodexCommand({
      args: ["logout"],
      cwd: ROOT_DIR,
      userId,
      timeoutMs: 30000,
    });
    const statusText = `${result.stdout}\n${result.stderr}`.trim();
    json(res, result.ok ? 200 : 500, {
      ok: result.ok,
      code: result.code,
      status: statusText,
      codexHome: resolveCodexHome(userId),
    });
    return true;
  }

  return false;
};

module.exports = { handleLoginRoutes };
