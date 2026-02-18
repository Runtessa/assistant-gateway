const { json } = require("../http");
const {
  PORT,
  ROOT_DIR,
  GATEWAY_VERSION,
  STARTED_AT,
  resolveAvailableModels,
} = require("../config");
const { runCodexAppServerModelList, runCodexCommand } = require("../codexCommands");
const { resolveCodexHome } = require("../codexRunner");

const handleMetaRoutes = async ({ req, res, pathname, requestUrl }) => {
  if (req.method === "GET" && pathname === "/health") {
    json(res, 200, { ok: true, service: "codex-gateway", port: PORT, root: ROOT_DIR });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/version") {
    json(res, 200, {
      ok: true,
      service: "codex-gateway",
      version: GATEWAY_VERSION,
      startedAt: STARTED_AT.toISOString(),
      uptimeMs: Date.now() - STARTED_AT.getTime(),
    });
    return true;
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
    json(res, 200, { ok: true, data: models.map((id) => ({ id })) });
    return true;
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
    json(res, 200, {
      ok: commandOk,
      code: result.code,
      loggedIn,
      status: statusText,
      codexHome: resolveCodexHome(userId),
    });
    return true;
  }

  return false;
};

module.exports = { handleMetaRoutes };
