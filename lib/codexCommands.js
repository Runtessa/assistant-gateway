const { ROOT_DIR, spawnCodexWithFallback } = require("./codexRunner");

const runCodexCommand = async ({ args, cwd, userId, stdinText, timeoutMs = 0 }) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCodexWithFallback({ args, cwd, userId, stdio: ["pipe", "pipe", "pipe"] }).child;
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
          const message = parsed.error?.message || stderrText.trim() || "model/list request failed";
          rejectOnce(new Error(String(message)));
          return;
        }
        const data = Array.isArray(parsed?.result?.data) ? parsed.result.data : [];
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

    child.stdin.write(`${JSON.stringify({
      id: "1",
      method: "initialize",
      params: { clientInfo: { name: "idp-codex-gateway", version: "1.0.0" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ id: "2", method: "model/list", params: {} })}\n`);
    child.stdin.end();
  });

module.exports = {
  runCodexCommand,
  runCodexAppServerModelList,
};
