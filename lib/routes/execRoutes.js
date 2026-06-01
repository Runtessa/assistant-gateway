const { json, parseBody } = require('../http');
const { safeCwd, runCodex, ROOT_DIR } = require('../codexRunner');
const { buildPrompt, addExecutionResultToSession, queueSaveHistory } = require('../chatHistory');
const { WORKSPACE_ACCESS_MODE } = require('../config');
const {
  hydrateWorkspaceFromSession,
  captureWorkspaceBaseline,
  startWorkspaceMonitor,
  collectWorkspaceDiff,
} = require('../workspaceManager');

const handleExecRoutes = async ({ req, res, pathname }) => {
  if (!(req.method === 'POST' && pathname === '/v1/exec')) return false;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (error) {
    json(res, 400, { error: error.message });
    return true;
  }

  let promptData;
  let cwd;
  let baseline = [];
  const hasAgentSession = Boolean(payload?.agentSession && payload.agentSession?.tenant?.id);
  const accessMode = WORKSPACE_ACCESS_MODE === 'repo' ? 'repo' : 'tenant';
  const workspaceScope = hasAgentSession ? accessMode : 'repo';
  try {
    if (workspaceScope === 'repo' && payload && typeof payload === 'object') {
      const existingPrompt = String(payload.systemPrompt || '').trim();
      payload.systemPrompt = `${existingPrompt}

REPOSITORY ACCESS MODE:
- You are working with direct filesystem access to the IDE repository, not only a tenant-hydrated virtual workspace.
- Inspect and modify the real repository files under the current working directory as needed.
- Choose the correct surface autonomously across backend, frontend, models, shared code, config, and docs.
- Do not limit yourself to tenant virtual roots when the task clearly targets IDE/product code.`.trim();
    }
    promptData = buildPrompt(payload);
    if (workspaceScope === 'tenant') {
      const hydrated = await hydrateWorkspaceFromSession({
        userId: promptData.userId,
        session: payload.agentSession,
      });
      cwd = hydrated.workspaceDir;
      baseline = hydrated.baseline;
    } else {
      cwd = safeCwd(payload.cwd || ROOT_DIR);
      baseline = await captureWorkspaceBaseline(cwd);
    }
  } catch (error) {
    json(res, 400, { error: error.message });
    return true;
  }

  const finish = async ({ code, signal, stdout = '', stderr = '', lastMessage = '' }) => {
    addExecutionResultToSession({
      sessionKey: promptData.sessionKey,
      prompt: promptData.prompt,
      message: lastMessage,
    });
    void queueSaveHistory();
    const changedFiles = workspaceScope
      ? await collectWorkspaceDiff({ workspaceDir: cwd, baseline }).catch(() => [])
      : [];
    return { code, signal, stdout, stderr, lastMessage, changedFiles };
  };

  const stream = payload.stream !== false;
  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(
      `event: status\ndata: ${JSON.stringify({ state: 'started', workspaceMode: workspaceScope !== 'repo', workspaceScope })}\n\n`,
    );

    let stopMonitor = () => {};
    if (workspaceScope) {
      stopMonitor = startWorkspaceMonitor({
        workspaceDir: cwd,
        onEvent: (event) => {
          res.write(`event: workspace-file\ndata: ${JSON.stringify(event)}\n\n`);
        },
      });
    }

    const child = runCodex({
      prompt: promptData.fullPrompt,
      model: payload.model,
      cwd,
      userId: promptData.userId,
      onStdout: (line) => res.write(`event: stdout\ndata: ${JSON.stringify({ line })}\n\n`),
      onStderr: (line) => res.write(`event: stderr\ndata: ${JSON.stringify({ line })}\n\n`),
      onClose: async ({ code, signal, lastMessage, stderr }) => {
        stopMonitor();
        const result = await finish({ code, signal, stderr, lastMessage });
        res.write(
          `event: done\ndata: ${JSON.stringify({
            code: result.code,
            signal: result.signal || '',
            ok: result.code === 0,
            workspaceScope,
            message: result.lastMessage || '',
            changedFiles: result.changedFiles,
            error:
              result.code === 0
                ? ''
                : result.stderr.trim() ||
                  (result.signal ? `terminated by ${result.signal}` : 'process failed'),
          })}\n\n`,
        );
        res.end();
      },
    });

    const stopChildIfStreamingClientGone = () => {
      if (res.writableEnded || res.destroyed) return;
      stopMonitor();
      if (!child.killed) child.kill('SIGTERM');
    };
    req.on('aborted', stopChildIfStreamingClientGone);
    res.on('close', stopChildIfStreamingClientGone);
    return true;
  }

  runCodex({
    prompt: promptData.fullPrompt,
    model: payload.model,
    cwd,
    userId: promptData.userId,
    onClose: async ({ code, stdout, stderr, lastMessage }) => {
      const result = await finish({ code, stdout, stderr, lastMessage });
      json(res, result.code === 0 ? 200 : 500, {
        ok: result.code === 0,
        code: result.code,
        workspaceScope,
        stdout: result.stdout,
        stderr: result.stderr,
        message: result.lastMessage || '',
        changedFiles: result.changedFiles,
      });
    },
  });

  return true;
};

module.exports = { handleExecRoutes };
