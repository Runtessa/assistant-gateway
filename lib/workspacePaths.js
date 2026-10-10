const fs = require("node:fs");
const path = require("node:path");
const { ROOT_DIR } = require("./config");

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

// Resolve the nearest existing ancestor too: a not-yet-created path can contain an escaping symlink.
const resolveExistingAncestor = (candidate) => {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(resolveExistingAncestor(parent), path.basename(candidate));
  }
};

const safeCwd = (cwd) => {
  if (!cwd) return ROOT_DIR;
  const resolved = path.resolve(cwd);
  if (!isWithin(ROOT_DIR, resolved) ||
      !isWithin(resolveExistingAncestor(ROOT_DIR), resolveExistingAncestor(resolved))) {
    throw new Error(`cwd must stay under workspace root: ${ROOT_DIR}`);
  }
  return resolved;
};

module.exports = { safeCwd };
