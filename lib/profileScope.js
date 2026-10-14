const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const digest = (file) => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const prepareScope = (primary, scoped) => {
  fs.mkdirSync(scoped, { recursive: true, mode: 0o700 });
  const original = digest(path.join(primary, 'auth.json'));
  for (const name of ['auth.json', 'config.toml']) {
    const source = path.join(primary, name), target = path.join(scoped, name);
    if (fs.existsSync(source)) { fs.copyFileSync(source, target); fs.chmodSync(target, 0o600); }
    else fs.rmSync(target, { force: true });
  }
  return () => {
    const source = path.join(scoped, 'auth.json'), target = path.join(primary, 'auth.json');
    // Preserve account switches and logout while retaining CLI token refreshes.
    if (!original || digest(target) !== original || !fs.existsSync(source) || digest(source) === original) return;
    const before = JSON.parse(fs.readFileSync(target, 'utf8')), after = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (before.tokens?.account_id !== after.tokens?.account_id || before.OPENAI_API_KEY !== after.OPENAI_API_KEY) return;
    const temporary = `${target}.${randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify(after), { mode: 0o600 }); fs.renameSync(temporary, target);
  };
};
const clearScopedAuth = (primary) => {
  const root = path.join(primary, 'isolated-workspaces');
  if (!fs.existsSync(root)) return;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)) fs.rmSync(path.join(root, item.name, 'auth.json'), { force: true });
  }
};
module.exports = { prepareScope, clearScopedAuth };
