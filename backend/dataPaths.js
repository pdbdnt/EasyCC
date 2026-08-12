const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');

function getDataDir(env = process.env) {
  const configured = typeof env.EASYCC_DATA_DIR === 'string'
    ? env.EASYCC_DATA_DIR.trim()
    : '';
  return configured ? path.resolve(configured) : DEFAULT_DATA_DIR;
}

function getDataPath(...segments) {
  const root = getDataDir();
  for (const segment of segments) {
    if (typeof segment !== 'string' || path.isAbsolute(segment)) {
      throw new TypeError('EasyCC data path segments must be relative strings');
    }
  }

  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`EasyCC data path escapes the configured data directory: ${segments.join(path.sep)}`);
  }
  return resolved;
}

module.exports = {
  DEFAULT_DATA_DIR,
  getDataDir,
  getDataPath
};
