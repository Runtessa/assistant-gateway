const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runtimeFiles = () => {
  const bundled = path.join(__dirname, 'runtime-budget');
  const directory = fs.existsSync(path.join(bundled, 'process-budget.js')) ? bundled
    : path.resolve(__dirname, '../../packages/shared/dist/runtime');
  return { ...require(path.join(directory, 'process-budget.js')), launcher: path.join(directory, 'budget-launcher.js') };
};
const executable = (name, env) => {
  if (name.includes('/')) return fs.realpathSync(name);
  for (const directory of String(env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    const filename = path.join(directory, name);
    if (fs.existsSync(filename)) return fs.realpathSync(filename);
  }
  throw new Error('Codex executable not found');
};

module.exports.spawnIsolatedCodex = ({ command, args, cwd, env, stdio }) => {
  const { createProcessBudget, launcher } = runtimeFiles();
  const binary = executable(command, env);
  const profile = fs.realpathSync(env.CODEX_HOME);
  const workspace = fs.realpathSync(cwd);
  const roots = new Set(['/usr', '/bin', '/lib', '/lib64', '/etc/ssl/certs', '/etc/ssl/cert.pem',
    '/etc/pki/ca-trust/extracted', '/etc/pki/tls/certs', '/etc/resolv.conf', '/etc/hosts', process.execPath, binary]);
  const packageRoot = path.resolve(path.dirname(binary), '..');
  try {
    if (JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).name === '@openai/codex') roots.add(packageRoot);
  } catch { /* A standalone executable needs only its own file mount. */ }
  for (const key of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (env[key]) roots.add(env[key]);
  const sandbox = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv', '--proc', '/proc',
    '--size', String(128 * 1024 * 1024), '--tmpfs', '/tmp', '--dev', '/dev'];
  for (const root of roots) if (fs.existsSync(root)) sandbox.push('--ro-bind', fs.realpathSync(root), root);
  sandbox.push('--bind', profile, profile);
  if (workspace !== profile) sandbox.push('--bind', workspace, workspace);
  sandbox.push('--chdir', workspace);
  for (const [key, value] of Object.entries({ ...env, HOME: profile })) sandbox.push('--setenv', key, value);
  sandbox.push(binary, ...args);
  const budget = createProcessBudget(768, 128);
  let child;
  try {
    child = spawn(process.execPath, [launcher, budget.group, budget.binary, ...sandbox], {
      cwd, env, stdio: [...stdio, 'ignore', 'ignore'],
    });
  } catch (error) { budget.kill(); void budget.close(); throw error; }
  child.once('close', () => { void budget.close().catch(() => {}); });
  return child;
};
