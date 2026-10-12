const { json, parseBody } = require('../http');
const { safeCwd, runCodex, ROOT_DIR } = require('../codexRunner');
const { runNativeCodex } = require('../nativeCodexRunner');
const { buildAttachmentInput } = require('../nativeAttachments');
const { acquireWorkspaceLock } = require('../workspaceLocks');
const { buildPrompt, addExecutionResultToSession, queueSaveHistory } = require('../chatHistory');
const { WORKSPACE_ACCESS_MODE } = require('../config');
const {
  hydrateWorkspaceFromSession,
  captureWorkspaceBaseline,
  startWorkspaceMonitor,
  collectWorkspaceDiff,
  resolveWorkspaceDir,
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
  let releaseScopeLock = () => {};
  let attachmentInput = [];
  try {
    attachmentInput = buildAttachmentInput(payload.attachments);
    if (attachmentInput.length && workspaceScope !== 'tenant') throw Error('Attachments require tenant workspace mode');
    if (workspaceScope === 'repo' && payload && typeof payload === 'object') {
      const existingPrompt = String(payload.systemPrompt || '').trim();
      payload.systemPrompt = `${existingPrompt}

REPOSITORY ACCESS MODE:
- You are working with direct filesystem access to the IDE repository, not only a tenant-hydrated virtual workspace.
- Inspect and modify the real repository files under the current working directory as needed.
- Choose the correct surface autonomously across backend, frontend, models, shared code, config, and docs.
- Do not limit yourself to tenant virtual roots when the task clearly targets IDE/product code.`.trim();
    }
    if (workspaceScope === 'tenant') {
      promptData = {userId:String(payload.userId || 'anonymous'),chatId:String(payload.agentSession.chatId || payload.chatId || 'default'),
        prompt:String(payload.prompt || '').trim()};
      if (!promptData.prompt) throw Error('prompt is required');
      releaseScopeLock = acquireWorkspaceLock(resolveWorkspaceDir({userId:promptData.userId,
        tenantId:payload.agentSession.tenant.id,chatId:promptData.chatId}));
    } else promptData = buildPrompt(payload);
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
    releaseScopeLock();
    json(res, 400, { error: error.message });
    return true;
  }

  const finish = async ({ code, signal, stdout = '', stderr = '', lastMessage = '' }) => {
    if (workspaceScope === 'repo') addExecutionResultToSession({
      sessionKey: promptData.sessionKey,
      prompt: promptData.prompt,
      message: lastMessage,
    });
    if (workspaceScope === 'repo') void queueSaveHistory();
    const changedFiles = workspaceScope
      ? await collectWorkspaceDiff({ workspaceDir: cwd, baseline }).catch(() => [])
      : [];
    releaseScopeLock();
    return { code, signal, stdout, stderr, lastMessage, changedFiles };
  };

  const execute = (options) => hasAgentSession && workspaceScope === 'tenant'
    ? runNativeCodex({...options,chatId:promptData.chatId,tenantId:payload.agentSession.tenant.id,
      prompt:promptData.prompt,systemPrompt:payload.systemPrompt || '',
      activeFile:payload.agentSession.workspace?.activeFile,messages:payload.messages,attachmentInput})
    : runCodex(options);

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
    const sendEvent = (event, data) => {
      if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (workspaceScope) {
      stopMonitor = startWorkspaceMonitor({
        workspaceDir: cwd,
        onEvent: (event) => {
          sendEvent('workspace-file', event);
        },
      });
    }

    const child = execute({
      prompt: promptData.fullPrompt,
      model: payload.model,
      cwd,
      userId: promptData.userId,
      readOnly: payload.agentSession?.task?.expectations?.mode === 'read-only',
      onDelta: (delta) => sendEvent('assistant-delta',{delta}),
      onStdout: (line) => sendEvent('stdout',{line}),
      onStderr: (line) => sendEvent('stderr',{line}),
      onClose: async ({ code, signal, lastMessage, stderr }) => {
        stopMonitor();
        const result = await finish({ code, signal, stderr, lastMessage });
        if (res.destroyed || res.writableEnded) return;
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
      if (res.writableEnded) return;
      stopMonitor();
      if (!child.killed) child.kill('SIGTERM');
    };
    req.on('aborted', stopChildIfStreamingClientGone);
    res.on('close', stopChildIfStreamingClientGone);
    return true;
  }

  execute({
    prompt: promptData.fullPrompt,
    model: payload.model,
    cwd,
    userId: promptData.userId,
    readOnly: payload.agentSession?.task?.expectations?.mode === 'read-only',
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
