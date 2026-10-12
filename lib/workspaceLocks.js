const locks = new Set();
const acquireWorkspaceLock = (key) => {
  if (locks.has(key))
    throw Error('This workspace already has a running assistant request.');
  locks.add(key);
  return () => locks.delete(key);
};
module.exports = { acquireWorkspaceLock };
