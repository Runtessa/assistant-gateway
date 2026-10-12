const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtessa-native-'));
process.env.CODEX_GATEWAY_PROFILES_DIR = path.join(directory, 'profiles');
const { runNativeCodex } = require('../lib/nativeCodexRunner');
const {
  threadStatePath,
  readThreadState,
} = require('../lib/nativeThreadStore');
const fixture = path.join(directory, 'app-server.cjs');
const log = path.join(directory, 'rpc.jsonl');
fs.writeFileSync(
  fixture,
  `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({input:process.stdin});
let thread; let pending;
const send = message => process.stdout.write(JSON.stringify(message)+'\\n');
const notify = (method,params) => send({method,params});
rl.on('line', line => {
 const request = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
 if (!request.id) return;
 if (request.method === 'initialize') send({id:request.id,result:{}});
 if (request.method === 'thread/start' || request.method === 'thread/resume') {
  thread=request.params.threadId || 'thread-'+require('node:crypto').randomUUID();
  send({id:request.id,result:{thread:{id:thread}}});
 }
 if (request.method === 'turn/start') {
  const turn='turn-'+require('node:crypto').randomUUID();
  send({id:request.id,result:{turn:{id:turn}}});
  notify('turn/started',{threadId:thread,turn:{id:turn}});
  notify('item/agentMessage/delta',{threadId:thread,turnId:turn,itemId:'reply',delta:'Native '});
  pending={id:turn};
  if (request.params.input[0].text.includes('WAIT')) return;
  notify('item/agentMessage/delta',{threadId:thread,turnId:turn,itemId:'reply',delta:'reply'});
  notify('item/completed',{threadId:thread,turnId:turn,item:{id:'reply',type:'agentMessage',text:'Native reply'}});
  notify('turn/completed',{threadId:thread,turn:{id:turn,status:'completed'}});
 }
 if (request.method === 'turn/interrupt') {
  send({id:request.id,result:{}});
  notify('turn/completed',{threadId:thread,turn:{id:pending.id,status:'interrupted'}});
 }
});
`,
);
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const input = (overrides = {}) => ({
  userId: 'user-a',
  chatId: 'chat-a',
  tenantId: 'tenant-a',
  cwd: directory,
  prompt: 'Inspect the workspace',
  model: 'catalog-default',
  readOnly: true,
  systemPrompt: 'Respect tenant scope',
  activeFile: { path: 'ui/view.jsx' },
  spawn: (options) => ({
    child: spawn(process.execPath, [fixture], { stdio: options.stdio }),
  }),
  ...overrides,
});
const execute = (options) =>
  new Promise((resolve) => runNativeCodex({ ...options, onClose: resolve }));
const messages = () =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('new processes resume the same persisted native thread; current file/model/sandbox are supplied each turn', async () => {
  const deltas = [];
  const first = await execute(input({ onDelta: (text) => deltas.push(text) }));
  assert.equal(first.code, 0);
  assert.equal(first.lastMessage, 'Native reply');
  assert.equal(deltas.join(''), 'Native reply');
  const second = await execute(
    input({ activeFile: { path: 'modules/new.js' }, readOnly: false }),
  );
  assert.equal(second.threadId, first.threadId);
  const calls = messages();
  const resume = calls.find((item) => item.method === 'thread/resume');
  assert.equal(resume.params.threadId, first.threadId);
  const turns = calls.filter((item) => item.method === 'turn/start');
  assert.equal(turns[0].params.sandboxPolicy.type, 'readOnly');
  assert.equal(turns[1].params.sandboxPolicy.type, 'workspaceWrite');
  assert.match(turns[1].params.input[0].text, /Active file: modules\/new.js/);
  assert.equal(turns[1].params.model, 'catalog-default');
  assert.equal(
    (await readThreadState(threadStatePath(input()))).threadId,
    first.threadId,
  );
});

test('thread identity cannot cross users, tenants or chats', async () => {
  const origin = (await readThreadState(threadStatePath(input()))).threadId;
  for (const overrides of [
    { userId: 'user-b' },
    { tenantId: 'tenant-b' },
    { chatId: 'chat-b' },
  ]) {
    const result = await execute(input(overrides));
    assert.equal(result.code, 0);
    assert.notEqual(result.threadId, origin);
  }
});

test('attachments reach the native app-server turn alongside current workspace context', async () => {
  const attachmentInput = [{ type: 'text', text: 'Reference note: exact contents' }, { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }];
  const result = await execute(input({ attachmentInput }));
  assert.equal(result.code, 0);
  const turn = messages().filter(item => item.method === 'turn/start').at(-1);
  assert.deepEqual(turn.params.input.slice(1), attachmentInput);
  assert.match(turn.params.input[0].text, /task-state/);
});

test('Stop interrupts the native turn and releases the workspace for the next request', async () => {
  let handle;
  const stopped = await new Promise((resolve) => {
    handle = runNativeCodex(
      input({
        prompt: 'WAIT',
        onDelta: () => {
          handle.kill();
        },
        onClose: resolve,
      }),
    );
  });
  assert.equal(stopped.code, 1);
  assert.equal(stopped.signal, 'SIGTERM');
  assert.match(stopped.stderr, /stopped/);
  assert.ok(messages().some((item) => item.method === 'turn/interrupt'));
  assert.equal((await execute(input())).code, 0);
});

test('same workspace rejects concurrent turns without breaking the running session', async () => {
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  let handle;
  const first = new Promise((resolve) => {
    handle = runNativeCodex(
      input({ prompt: 'WAIT', onDelta: ready, onClose: resolve }),
    );
  });
  await started;
  assert.match((await execute(input())).stderr, /already has a running/);
  handle.kill();
  await first;
  assert.equal((await execute(input())).code, 0);
});

test('execution deadline reports timeout distinctly from a user Stop', async () => {
  const original = process.env.AGENT_CODEX_TIMEOUT_MS;
  process.env.AGENT_CODEX_TIMEOUT_MS = '100';
  try {
    const result = await execute(input({ prompt: 'WAIT' }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out/);
  } finally {
    if (original === undefined) delete process.env.AGENT_CODEX_TIMEOUT_MS;
    else process.env.AGENT_CODEX_TIMEOUT_MS = original;
  }
});
