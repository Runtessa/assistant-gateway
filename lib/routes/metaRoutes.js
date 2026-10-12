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
    let error = '';
    try {
      rows = await runCodexAppServerModelList(userId);
    } catch (failure) {
      error = failure.message || 'Codex model discovery failed';
    }
    const models =
      Array.isArray(rows) && rows.length
        ? rows
            .filter((item) => !item.hidden)
            .map((item) => ({ id: String(item?.model || item?.id || '').trim(),
              displayName: String(item?.displayName || item?.model || item?.id || ''),
              isDefault: item?.isDefault === true }))
            .filter((item) => item.id)
        : resolveAvailableModels().map((id) => ({ id, displayName: id, isDefault: false }));
    if (!models.length) {
      json(res, 503, { ok: false, error: error || 'No Codex models are available', data: [] });
      return true;
    }
    const configured = String(process.env.AGENT_CODEX_MODEL || '').trim();
    const defaultModel = configured || models.find((item) => item.isDefault)?.id || models[0].id;
    json(res, 200, { ok: true, data: models, defaultModel });
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
