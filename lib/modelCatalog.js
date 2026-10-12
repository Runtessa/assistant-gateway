const { ROOT_DIR, spawnCodexWithFallback } = require('./codexRunner');

// Keep stdin open until all responses arrive: EOF terminates app-server.
const readModelCatalog = (
  userId,
  spawn = spawnCodexWithFallback,
  timeoutMs = 15000,
) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn({
        args: ['app-server'],
        cwd: ROOT_DIR,
        userId,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).child;
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = '';
    let settled = false;
    let requestId = 1;
    const rows = [];
    const cursors = new Set();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(rows);
    };
    const timer = setTimeout(
      () => finish(new Error('Codex model discovery timed out')),
      timeoutMs,
    );
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const list = (cursor) => {
      requestId += 1;
      send({
        id: requestId,
        method: 'model/list',
        params: {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        },
      });
    };
    const processLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (settled || message.id !== requestId) return;
      if (message.error) {
        finish(
          new Error(
            String(message.error.message || 'Codex model discovery failed'),
          ),
        );
        return;
      }
      if (requestId === 1) {
        send({ method: 'initialized' });
        list();
        return;
      }
      if (!Array.isArray(message.result?.data)) {
        finish(new Error('Codex returned an invalid model catalog'));
        return;
      }
      rows.push(...message.result.data);
      const cursor = message.result.nextCursor;
      if (!cursor) {
        finish();
        return;
      }
      if (cursors.has(cursor)) {
        finish(new Error('Codex repeated a model catalog cursor'));
        return;
      }
      cursors.add(cursor);
      list(cursor);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        processLine(line);
      }
    });
    child.stderr.resume();
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('close', () => {
      if (buffer.trim()) processLine(buffer);
      if (!settled)
        finish(new Error('Codex exited before returning its model catalog'));
    });
    send({
      id: requestId,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'runtessa-assistant',
          title: 'Runtessa',
          version: '1.0.0',
        },
      },
    });
  });

module.exports = { readModelCatalog };
