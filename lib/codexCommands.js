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

const { readModelCatalog: runCodexAppServerModelList } = require('./modelCatalog');

module.exports = {
  runCodexCommand,
  runCodexAppServerModelList,
};
