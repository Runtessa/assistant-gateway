const { createAppServerClient } = require('./appServerClient');
const {
  threadStatePath,
  readThreadState,
  saveThreadState,
} = require('./nativeThreadStore');

const activeWorkspaces = new Set();
const runNativeCodex = (input) => {
  let client;
  let threadId;
  let turnId;
  let finished = false;
  let cancelled = false;
  let timedOut = false;
  const stopError = () => Error(timedOut ? 'Codex request timed out' : 'Codex request stopped');
  let timer;
  let ownsLock = false;
  let lastMessage = '';
  let stderr = '';
  const deltas = new Map();
  const stateFile = threadStatePath(input);
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    client?.close();
    if (ownsLock) activeWorkspaces.delete(stateFile);
    input.onClose?.({
      code: error ? 1 : 0,
      signal: cancelled ? 'SIGTERM' : '',
      stderr: error?.message || stderr,
      lastMessage,
      threadId,
      turnId,
    });
  };
  const handle = {
    get killed() {
      return cancelled || finished;
    },
    kill: () => {
      if (finished || cancelled) return;
      cancelled = true;
      if (threadId && turnId) {
        void client
          .request('turn/interrupt', { threadId, turnId })
          .catch(() => {});
        clearTimeout(timer);
        timer = setTimeout(() => finish(stopError()), 3000);
      } else finish(stopError());
    },
  };
  const onNotification = ({ method, params }) => {
    if (finished || params?.threadId !== threadId) return;
    if (method === 'turn/started') turnId = params.turn.id;
    if (method === 'item/agentMessage/delta') {
      deltas.set(
        params.itemId,
        (deltas.get(params.itemId) || '') + params.delta,
      );
      input.onDelta?.(params.delta);
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (item.type === 'agentMessage' && method === 'item/completed') {
        lastMessage = item.text || deltas.get(item.id) || '';
      } else if (item.type === 'commandExecution') {
        input.onStdout?.(
          JSON.stringify({
            type: method === 'item/started' ? 'item.started' : 'item.completed',
            item: {
              type: 'command_execution',
              command: item.command,
              status: item.status,
              exit_code: item.exitCode,
            },
          }),
        );
      } else if (item.type === 'fileChange') {
        input.onStdout?.(
          `[codex] ${method === 'item/started' ? 'Editing' : 'Edited'} workspace files`,
        );
      }
    }
    if (method === 'turn/completed') {
      turnId = params.turn.id;
      const turn = params.turn;
      finish(
        turn.status === 'completed' && !cancelled
          ? null
          : Error(
              turn.error?.message ||
                (cancelled
                  ? stopError().message
                  : `Codex turn ${turn.status}`),
            ),
      );
    }
    if (method === 'error' && params.willRetry !== true)
      finish(Error(params.error?.message || 'Codex failed'));
  };
  void (async () => {
    try {
      if (activeWorkspaces.has(stateFile))
        throw Error(
          'This assistant chat already has a running turn. Stop it or wait for completion.',
        );
      activeWorkspaces.add(stateFile);
      ownsLock = true;
      client = createAppServerClient({
        ...input,
        onNotification,
        onFailure: finish,
        onStderr: (line) => {
          stderr += `${line}\n`;
          input.onStderr?.(line);
        },
      });
      timer = setTimeout(
        () => {
          timedOut = true;
          handle.kill();
        },
        Number(process.env.AGENT_CODEX_TIMEOUT_MS) || 1800000,
      );
      await client.request('initialize', {
        clientInfo: {
          name: 'runtessa-assistant',
          title: 'Runtessa',
          version: '1.0.0',
        },
      });
      client.notify({ method: 'initialized' });
      const previous = await readThreadState(stateFile);
      const config = {
        cwd: input.cwd,
        model: input.model || null,
        approvalPolicy: 'never',
        sandbox: input.readOnly ? 'read-only' : 'workspace-write',
        developerInstructions: input.systemPrompt,
      };
      const started = await client.request(
        previous?.threadId ? 'thread/resume' : 'thread/start',
        {
          ...config,
          ...(previous?.threadId ? { threadId: previous.threadId } : {}),
        },
      );
      if (finished) return;
      threadId = started.thread.id;
      await saveThreadState(stateFile, {
        threadId,
        updatedAt: new Date().toISOString(),
      });
      input.onStdout?.(
        `[codex] ${previous?.threadId ? 'Resumed' : 'Started'} workspace conversation`,
      );
      const context = `Current IDE state is in .idp/task-state.json and .idp/manifest.json.\n${
        input.activeFile?.path ? `Active file: ${input.activeFile.path}\n` : ''
      }Files may have changed in the IDE since the previous turn. Re-read relevant files before making changes.`;
      const earlier =
        !previous?.threadId && Array.isArray(input.messages)
          ? input.messages
              .slice(0, -1)
              .map((item) => `[${item.role}] ${item.content}`)
              .join('\n\n')
          : '';
      const startedTurn = await client.request('turn/start', {
        threadId,
        cwd: input.cwd,
        model: input.model || null,
        approvalPolicy: 'never',
        sandboxPolicy: input.readOnly
          ? { type: 'readOnly' }
          : {
              type: 'workspaceWrite',
              writableRoots: [input.cwd],
              networkAccess: false,
            },
        input: [
          {
            type: 'text',
            text: `${context}\n\n${earlier ? `Earlier conversation:\n${earlier}\n\n` : ''}${input.prompt}`,
          },
          ...(input.attachmentInput || []),
        ],
      });
      turnId = startedTurn.turn.id;
      if (cancelled && !finished) handle.kill();
    } catch (error) {
      finish(error);
    }
  })();
  return handle;
};

module.exports = { runNativeCodex };
