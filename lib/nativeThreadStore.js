const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolveCodexHome } = require('./codexRunner');

const threadStatePath = ({ userId, chatId, tenantId, cwd }) => {
  const key = createHash('sha256')
    .update(
      JSON.stringify([String(userId), chatId, tenantId, path.resolve(cwd)]),
    )
    .digest('hex');
  return path.join(resolveCodexHome(userId), 'runtessa-threads', `${key}.json`);
};
const readThreadState = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const saveThreadState = async (file, state) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, file);
};

module.exports = { threadStatePath, readThreadState, saveThreadState };
