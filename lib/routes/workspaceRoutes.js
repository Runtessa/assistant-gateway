const { json, parseBody } = require('../http');
const {
  activateWorkspaceSession,
  commitWorkspaceSession,
  resetWorkspaceSession,
} = require('../workspaceManager');

const parseWorkspaceRequest = async (req) => {
  const payload = await parseBody(req);
  const userId = String(payload?.userId || '').trim() || 'anonymous';
  const tenantId = String(payload?.tenantId || payload?.agentSession?.tenant?.id || '').trim();
  const chatId = String(payload?.chatId || '').trim() || 'default';
  if (!tenantId) {
    throw new Error('tenantId is required');
  }
  return { payload, userId, tenantId, chatId };
};

const handleWorkspaceRoutes = async ({ req, res, pathname }) => {
  if (req.method !== 'POST') return false;

  if (pathname === '/v1/workspace/activate') {
    try {
      const { payload, userId } = await parseWorkspaceRequest(req);
      if (!payload?.agentSession?.tenant?.id) {
        json(res, 400, { error: 'agentSession with tenant metadata is required' });
        return true;
      }
      const activated = await activateWorkspaceSession({
        userId,
        session: payload.agentSession,
      });
      json(res, 200, {
        ok: true,
        workspace: {
          scope: 'tenant',
          workspaceDir: activated.workspaceDir,
          activatedAt: activated.syncState?.activatedAt || new Date().toISOString(),
          lastPreparedAt: activated.syncState?.lastPreparedAt || '',
          fileCount: activated.baseline.length,
          baselineCount: activated.baseline.length,
          reused: Boolean(activated.reused),
        },
      });
      return true;
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }
  }

  if (pathname === '/v1/workspace/commit') {
    try {
      const { userId, tenantId, chatId } = await parseWorkspaceRequest(req);
      const committed = await commitWorkspaceSession({ userId, tenantId, chatId });
      json(res, 200, {
        ok: true,
        workspace: {
          scope: 'tenant',
          ...committed,
        },
      });
      return true;
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }
  }

  if (pathname === '/v1/workspace/reset') {
    try {
      const { userId, tenantId, chatId } = await parseWorkspaceRequest(req);
      const reset = await resetWorkspaceSession({ userId, tenantId, chatId });
      json(res, 200, {
        ok: true,
        workspace: {
          scope: 'tenant',
          ...reset,
        },
      });
      return true;
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }
  }

  return false;
};

module.exports = { handleWorkspaceRoutes };
