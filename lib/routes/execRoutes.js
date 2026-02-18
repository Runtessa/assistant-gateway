const { json, parseBody } = require("../http");
const { safeCwd, runCodex } = require("../codexRunner");
const { buildPrompt, addExecutionResultToSession, queueSaveHistory } = require("../chatHistory");

const handleExecRoutes = async ({ req, res, pathname }) => {
  if (!(req.method === "POST" && pathname === "/v1/exec")) return false;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (error) {
    json(res, 400, { error: error.message });
    return true;
  }

  let promptData;
  let cwd;
  try {
    promptData = buildPrompt(payload);
    cwd = safeCwd(payload.cwd);
  } catch (error) {
    json(res, 400, { error: error.message });
    return true;
  }

  const finish = ({ code, signal, stdout = "", stderr = "", lastMessage = "" }) => {
    addExecutionResultToSession({
      sessionKey: promptData.sessionKey,
      prompt: promptData.prompt,
      message: lastMessage,
    });
    void queueSaveHistory();
    return { code, signal, stdout, stderr, lastMessage };
  };

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
        const result = finish({ code, signal, stderr, lastMessage });
        res.write(
          `event: done\ndata: ${JSON.stringify({
            code: result.code,
            signal: result.signal || "",
            ok: result.code === 0,
            message: result.lastMessage || "",
            error:
              result.code === 0
                ? ""
                : result.stderr.trim() ||
                  (result.signal ? `terminated by ${result.signal}` : "process failed"),
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
    return true;
  }

  runCodex({
    prompt: promptData.fullPrompt,
    model: payload.model,
    cwd,
    userId: promptData.userId,
    onClose: ({ code, stdout, stderr, lastMessage }) => {
      const result = finish({ code, stdout, stderr, lastMessage });
      json(res, result.code === 0 ? 200 : 500, {
        ok: result.code === 0,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        message: result.lastMessage || "",
      });
    },
  });

  return true;
};

module.exports = { handleExecRoutes };
