const { json } = require("./http");
const { handleMetaRoutes } = require("./routes/metaRoutes");
const { handleLoginRoutes } = require("./routes/loginRoutes");
const { handleExecRoutes } = require("./routes/execRoutes");
const { handleWorkspaceRoutes } = require("./routes/workspaceRoutes");

const handleRequest = async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (await handleMetaRoutes({ req, res, pathname, requestUrl })) return;
  if (await handleLoginRoutes({ req, res, pathname, requestUrl })) return;
  if (await handleWorkspaceRoutes({ req, res, pathname, requestUrl })) return;
  if (await handleExecRoutes({ req, res, pathname, requestUrl })) return;

  json(res, 404, { error: "Not found" });
};

module.exports = { handleRequest };
