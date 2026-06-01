const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WORKSPACES_DIR } = require('./config');

const sanitizeSegment = (value) =>
  String(value || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';

const isManagedFile = (relativePath) => {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized === 'AGENTS.md') return false;
  if (normalized.startsWith('.idp/')) return false;
  return true;
};

const hashText = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const ensureDir = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

const rmIfExists = async (targetPath) => {
  await fs.promises.rm(targetPath, { recursive: true, force: true });
};

const writeTextFile = async (filePath, content) => {
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, String(content || ''), 'utf8');
};

const buildWorkspaceKey = (input) => {
  const tenantId = sanitizeSegment(input?.tenantId || 'tenant');
  const chatId = sanitizeSegment(input?.chatId || 'default');
  return `${tenantId}__${chatId}`;
};

const resolveWorkspaceDir = ({ userId, tenantId, chatId }) =>
  path.join(WORKSPACES_DIR, sanitizeSegment(userId || 'anonymous'), buildWorkspaceKey({ tenantId, chatId }));

const buildAgentsContent = (session) => {
  const expectationList = [
    session?.task?.expectations?.backend ? '- backend modules are in scope when required by the task' : '',
    session?.task?.expectations?.models ? '- ORM models are in scope when required by the task' : '',
    session?.task?.expectations?.ui ? '- UI files/packages are in scope when required by the task' : '',
    session?.task?.expectations?.acl ? '- ACL files are in scope when backend/access changes require them' : '',
    session?.task?.expectations?.shared ? '- shared project files are in scope when the request targets shared assets' : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `# Tenant Workspace Agent Rules

This workspace is a hydrated tenant instance from the IDE database.
The IDE database remains the source of truth. Edit files in this workspace directly.

## Required Rules
- Respect .idp/manifest.json and .idp/task-state.json.
- Use existing structure unless the task requires a refactor.
- Do not introduce mock/fake/sample/dummy data.
- UI data access must use @app/datacontext, never fetch/axios/XMLHttpRequest.
- Backend modules must use module.exports = async function handler(req, adapters) { ... }.
- Backend DB access must use await adapters.orm('<database>:<key>').
- Keep ACL files aligned when backend routes or access semantics change.

## Current Task Scope
${expectationList || '- no explicit surface requirements detected; inspect the task-state file'}
`;
};

const buildTaskState = (session) => ({
  objective: String(session?.task?.objective || ''),
  expectations: session?.task?.expectations || {},
  recentChangePaths: Array.isArray(session?.task?.recentChangePaths)
    ? session.task.recentChangePaths
    : [],
  latestRunMessage: String(session?.task?.latestRunMessage || ''),
  latestRunStatus: String(session?.task?.latestRunStatus || ''),
  activeFile: session?.workspace?.activeFile || null,
  preview: {
    enabled: Boolean(session?.preview?.enabled),
    exceptions: Array.isArray(session?.preview?.exceptions) ? session.preview.exceptions : [],
  },
});

const createBaseline = (session) => {
  const files = Array.isArray(session?.workspace?.files) ? session.workspace.files : [];
  return files
    .filter((file) => file && typeof file.path === 'string' && isManagedFile(file.path))
    .map((file) => ({
      path: file.path,
      hash: hashText(file.content || ''),
      content: String(file.content || ''),
    }));
};

const writeSessionFiles = async (workspaceDir, session) => {
  const files = Array.isArray(session?.workspace?.files) ? session.workspace.files : [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !isManagedFile(file.path)) continue;
    await writeTextFile(path.join(workspaceDir, file.path), file.content || '');
  }
};

const writeSessionMetadata = async (workspaceDir, session, baseline) => {
  const manifest = {
    version: session?.version || '',
    chatId: session?.chatId || 'default',
    tenant: session?.tenant || null,
    actor: session?.actor || null,
    runtime: session?.runtime || {},
    workspace: {
      stats: session?.workspace?.stats || {},
      activeFile: session?.workspace?.activeFile || null,
      files: Array.isArray(session?.workspace?.files)
        ? session.workspace.files.map((file) => ({
            path: file.path,
            kind: file.kind,
            entityName: file.entityName,
            projectId: file.projectId,
            projectName: file.projectName,
            version: file.version,
            dependencies: Array.isArray(file.dependencies) ? file.dependencies : [],
          }))
        : [],
    },
    acl: session?.acl || {},
  };
  await writeTextFile(path.join(workspaceDir, '.idp', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeTextFile(path.join(workspaceDir, '.idp', 'task-state.json'), `${JSON.stringify(buildTaskState(session), null, 2)}\n`);
  await writeTextFile(
    path.join(workspaceDir, '.idp', 'sync-state.json'),
    `${JSON.stringify({ createdAt: new Date().toISOString(), baseline }, null, 2)}\n`,
  );
  const agentsContent = buildAgentsContent(session);
  await writeTextFile(path.join(workspaceDir, '.idp', 'AGENTS.md'), agentsContent);
  await writeTextFile(path.join(workspaceDir, 'AGENTS.md'), agentsContent);
};

const hydrateWorkspaceFromSession = async ({ userId, session }) => {
  const tenantId = session?.tenant?.id || 'tenant';
  const chatId = session?.chatId || 'default';
  const workspaceDir = resolveWorkspaceDir({ userId, tenantId, chatId });
  await rmIfExists(workspaceDir);
  await ensureDir(workspaceDir);
  const baseline = createBaseline(session);
  await writeSessionFiles(workspaceDir, session);
  await writeSessionMetadata(workspaceDir, session, baseline);
  return { workspaceDir, baseline };
};

const scanFiles = async (rootDir) => {
  const entries = new Map();
  const visit = async (dirPath) => {
    const dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      const absolute = path.join(dirPath, entry.name);
      const relative = path.relative(rootDir, absolute).replace(/\\/g, '/');
      if (!relative || !isManagedFile(relative)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const content = await fs.promises.readFile(absolute, 'utf8');
      entries.set(relative, {
        hash: hashText(content),
        content,
      });
    }
  };
  await visit(rootDir);
  return entries;
};

const startWorkspaceMonitor = ({ workspaceDir, onEvent, intervalMs = 700 }) => {
  let active = true;
  let previousPromise = scanFiles(workspaceDir).catch(() => new Map());
  const timer = setInterval(async () => {
    if (!active) return;
    const previous = await previousPromise;
    const next = await scanFiles(workspaceDir).catch(() => new Map());
    previousPromise = Promise.resolve(next);
    const seen = new Set();
    for (const [filePath, meta] of next.entries()) {
      seen.add(filePath);
      const prev = previous.get(filePath);
      if (!prev) {
        onEvent?.({ path: filePath, action: 'create', content: meta.content });
        continue;
      }
      if (prev.hash !== meta.hash) {
        onEvent?.({ path: filePath, action: 'edit', content: meta.content });
      }
    }
    for (const filePath of previous.keys()) {
      if (!seen.has(filePath)) {
        onEvent?.({ path: filePath, action: 'delete' });
      }
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    active = false;
    clearInterval(timer);
  };
};

const collectWorkspaceDiff = async ({ workspaceDir, baseline }) => {
  const baselineMap = new Map((baseline || []).map((item) => [item.path, item]));
  const currentMap = new Map();
  const result = [];

  const walk = async (dirPath) => {
    const dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      const absolute = path.join(dirPath, entry.name);
      const relative = path.relative(workspaceDir, absolute).replace(/\\/g, '/');
      if (!relative || !isManagedFile(relative)) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const content = await fs.promises.readFile(absolute, 'utf8');
      currentMap.set(relative, content);
      const previous = baselineMap.get(relative);
      if (!previous) {
        result.push({ path: relative, action: 'create', content });
        continue;
      }
      if (previous.hash !== hashText(content)) {
        result.push({ path: relative, action: 'edit', content });
      }
    }
  };

  await walk(workspaceDir);

  for (const [relativePath] of baselineMap.entries()) {
    if (!currentMap.has(relativePath)) {
      result.push({ path: relativePath, action: 'delete' });
    }
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
};

module.exports = {
  WORKSPACES_DIR,
  resolveWorkspaceDir,
  hydrateWorkspaceFromSession,
  startWorkspaceMonitor,
  collectWorkspaceDiff,
};
