const http = require("node:http");
const { PORT, ROOT_DIR, HISTORY_FILE } = require("./lib/config");
const { handleRequest } = require("./lib/router");
const { loadHistoryFromDisk, chatSessions } = require("./lib/chatHistory");
const { stopAllLoginChildren, sweepExpiredLoginSessions } = require("./lib/loginFlow");

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    const message = error?.message || String(error) || "Unexpected error";
    const body = JSON.stringify({ error: message });
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
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

const shutdown = () => {
  stopAllLoginChildren();
  server.close(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((error) => {
  console.error("[codex-gateway] failed to start:", error.message || error);
  process.exit(1);
});
