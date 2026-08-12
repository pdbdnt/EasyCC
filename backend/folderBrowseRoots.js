const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WSL_ROOT_DISCOVERY_SCRIPT = [
  'printf "%s\\n" "$WSL_DISTRO_NAME"',
  'if [ -d "$HOME/apps" ]; then printf "%s/apps\\n" "$HOME"; else printf "%s\\n" "$HOME"; fi'
].join('; ');

function parseWslBrowseRoot(output) {
  const lines = String(output || '')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  const [distroName, linuxPath] = lines;

  if (!distroName || !linuxPath) return '';
  if (/[\\/]/.test(distroName) || !linuxPath.startsWith('/') || linuxPath.includes('\\')) return '';

  const pathSegments = linuxPath.split('/').filter(Boolean);
  if (pathSegments.some(segment => segment === '.' || segment === '..')) return '';

  return `\\\\wsl$\\${distroName}${linuxPath.replace(/\//g, '\\')}`;
}

function runDefaultWslDiscovery() {
  return execFileSync('wsl.exe', ['sh', '-lc', WSL_ROOT_DISCOVERY_SCRIPT], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 64 * 1024
  });
}

function resolveDefaultWslBrowseRoot({
  environment = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
  pathExists = fs.existsSync,
  runWslDiscovery = runDefaultWslDiscovery
} = {}) {
  const configuredRoot = typeof environment.WSL_FOLDERS_BROWSE_ROOT === 'string'
    ? environment.WSL_FOLDERS_BROWSE_ROOT.trim()
    : '';
  if (configuredRoot) return configuredRoot;

  if (platform === 'win32') {
    try {
      return parseWslBrowseRoot(runWslDiscovery());
    } catch {
      // If WSL is unavailable, omit that browse source instead of exposing a broken root.
      return '';
    }
  }

  const appsDirectory = path.posix.join(homeDirectory, 'apps');
  return pathExists(appsDirectory) ? appsDirectory : homeDirectory;
}

module.exports = {
  parseWslBrowseRoot,
  resolveDefaultWslBrowseRoot
};
