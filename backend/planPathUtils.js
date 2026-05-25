const path = require('path');
const os = require('os');

function getWslDistro(options = {}) {
  return options.wslDistro ||
    options.env?.EASYCC_WSL_DISTRO ||
    options.env?.WSL_DISTRO_NAME ||
    process.env.EASYCC_WSL_DISTRO ||
    process.env.WSL_DISTRO_NAME ||
    'Ubuntu';
}

function getHomeUser(homeDir) {
  if (!homeDir || typeof homeDir !== 'string') return '';
  return homeDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

function getCodexPlansDir(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();

  if (platform === 'win32') {
    const user = options.wslUser || getHomeUser(homeDir) || 'denni';
    return `\\\\wsl$\\${getWslDistro(options)}\\home\\${user}\\.codex\\plans`;
  }

  return path.join(homeDir, '.codex', 'plans');
}

function getDefaultExtraPlansDirs(options = {}) {
  const dirs = [getCodexPlansDir(options)];
  const homeDir = options.homeDir || os.homedir();
  const localCodexDir = path.join(homeDir, '.codex', 'plans');
  if (!dirs.includes(localCodexDir)) {
    dirs.push(localCodexDir);
  }
  return dirs;
}

function normalizeWslCodexPlanPath(planPath, options = {}) {
  if (typeof planPath !== 'string') {
    return '';
  }

  const platform = options.platform || process.platform;
  const trimmed = planPath.trim().replace(/[),.;:]+$/g, '');
  if (!trimmed) {
    return '';
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const homeDir = options.homeDir || os.homedir();

  let relativePath = '';
  if (normalized.startsWith('~/.codex/plans/')) {
    relativePath = normalized.slice('~/'.length);
  } else {
    const homeMatch = normalized.match(/^\/home\/([^/]+)\/\.codex\/plans\/(.+\.md)$/i);
    if (homeMatch) {
      relativePath = `.codex/plans/${homeMatch[2]}`;
    }
  }

  if (!relativePath) {
    return trimmed;
  }

  if (platform === 'win32') {
    const user = options.wslUser ||
      normalized.match(/^\/home\/([^/]+)\//i)?.[1] ||
      getHomeUser(homeDir) ||
      'denni';
    return `\\\\wsl$\\${getWslDistro(options)}\\home\\${user}\\${relativePath.replace(/\//g, '\\')}`;
  }

  if (normalized.startsWith('/home/')) {
    return normalized;
  }

  return path.join(homeDir, relativePath);
}

function resolvePlanRefForHost(planRef, options = {}) {
  const normalizedCodexPath = normalizeWslCodexPlanPath(planRef, options);
  if (normalizedCodexPath) {
    return normalizedCodexPath;
  }
  return planRef;
}

function normalizePathKey(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getPlanSource(planPath, options = {}) {
  const key = normalizePathKey(planPath);
  const codexDir = normalizePathKey(getCodexPlansDir(options));
  const localCodexDir = normalizePathKey(path.join(options.homeDir || os.homedir(), '.codex', 'plans'));
  const claudeDir = normalizePathKey(path.join(options.homeDir || os.homedir(), '.claude', 'plans'));

  if (key.startsWith(`${codexDir}/`) || key.startsWith(`${localCodexDir}/`) || key.includes('/.codex/plans/')) {
    return 'codex';
  }
  if (key.startsWith(`${claudeDir}/`) || key.includes('/.claude/plans/')) {
    return 'claude';
  }
  return 'project';
}

module.exports = {
  getCodexPlansDir,
  getDefaultExtraPlansDirs,
  getPlanSource,
  normalizePathKey,
  normalizeWslCodexPlanPath,
  resolvePlanRefForHost
};
