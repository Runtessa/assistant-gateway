const { createInterface } = require('node:readline');
const { spawnCodexWithFallback } = require('./codexRunner');

const createAppServerClient = ({
  userId,
  tenantId,
  chatId,
  cwd,
  onNotification,
  onFailure,
  onStderr,
  spawn = spawnCodexWithFallback,
  requestTimeoutMs = 20000,
}) => {
  const { child } = spawn({
    args: ['app-server'],
    cwd,
    userId,
    tenantId,
    chatId,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const send = (message) => {
    if (closed) throw Error('Codex session is closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    if (!closed) onFailure?.(error);
  };
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      // Never approve an interactive request implicitly.
      send({
        id: message.id,
        error: {
          code: -32601,
          message: 'This request requires interactive user input in Runtessa.',
        },
      });
      fail(
        Error(
          'Codex needs user input. Reply with the missing information in the assistant chat.',
        ),
      );
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error)
        entry.reject(Error(message.error.message || 'Codex request failed'));
      else entry.resolve(message.result);
    } else if (message.method) onNotification?.(message);
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on(
    'line',
    (line) => onStderr?.(line),
  );
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code) => fail(Error(`Codex session exited (${code})`)));
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Codex ${method} timed out`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  const close = () => {
    if (closed) return;
    closed = true;
    fail(Error('Codex session closed'));
    child.stdin.end();
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  };
  return { request, notify: send, close, child };
};

module.exports = { createAppServerClient };
