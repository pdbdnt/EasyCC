const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

const PROFILE_NAME = 'easycc-windows';
const PROFILE_MARKER = '# EASYCC_OWNED_CODEX_WINDOWS_PROFILE schema=1';

function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function findNativeNode() {
  const candidates = [
    process.env.EASYCC_CODEX_WINDOWS_NODE,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function findCodexJs() {
  const candidates = [
    process.env.EASYCC_CODEX_WINDOWS_JS,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function findNativeCodexExe(codexJsPath = findCodexJs()) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const codexPackageRoot = codexJsPath ? path.resolve(path.dirname(codexJsPath), '..') : null;
  const candidates = [
    process.env.EASYCC_CODEX_WINDOWS_EXE,
    codexPackageRoot && path.join(
      codexPackageRoot,
      'node_modules',
      '@openai',
      `codex-win32-${arch}`,
      'vendor',
      target,
      'bin',
      'codex.exe'
    ),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function getCapability() {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'Codex (W) is only available on Windows.' };
  }
  const nodePath = findNativeNode();
  const codexJsPath = findCodexJs();
  const codexExePath = findNativeCodexExe(codexJsPath);
  if (!codexExePath && (!nodePath || !codexJsPath)) {
    return { available: false, reason: 'Windows-native Codex npm installation was not found.', nodePath, codexJsPath };
  }
  try {
    const executablePath = codexExePath || nodePath;
    const versionArgs = codexExePath ? ['--version'] : [codexJsPath, '--version'];
    const version = execFileSync(executablePath, versionArgs, {
      encoding: 'utf8', timeout: 10000, windowsHide: true
    }).trim();
    return {
      available: true,
      nodePath,
      codexJsPath,
      codexExePath,
      executablePath,
      launchMode: codexExePath ? 'native-exe' : 'node-fallback',
      version,
      codexHome: getCodexHome()
    };
  } catch (error) {
    return { available: false, reason: `Windows-native Codex could not start: ${error.message}`, nodePath, codexJsPath };
  }
}

function quoteTomlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureProfile() {
  const codexHome = getCodexHome();
  fs.mkdirSync(codexHome, { recursive: true });
  const profilePath = path.join(codexHome, `${PROFILE_NAME}.config.toml`);
  const helperPath = path.join(__dirname, 'codex-hooks', 'session-start.ps1');
  if (!fs.existsSync(helperPath)) throw new Error(`EasyCC Codex hook helper is missing: ${helperPath}`);
  if (fs.existsSync(profilePath)) {
    const existing = fs.readFileSync(profilePath, 'utf8');
    if (!existing.includes(PROFILE_MARKER)) {
      throw new Error(`Refusing to overwrite non-EasyCC Codex profile: ${profilePath}`);
    }
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `${powershell} -NoProfile -ExecutionPolicy Bypass -File \"${helperPath}\"`;
  const contents = `${PROFILE_MARKER}\n[tui]\nstatus_line = [\"model-with-reasoning\", \"current-dir\", \"context-used\", \"thread-title\"]\n\n[[hooks.SessionStart]]\nmatcher = \"startup|resume\"\n[[hooks.SessionStart.hooks]]\ntype = \"command\"\ncommand = \"true\"\ncommand_windows = ${quoteTomlLiteral(command)}\ntimeout = 5\n`;
  const tempPath = `${profilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, contents, 'utf8');
  fs.renameSync(tempPath, profilePath);
  return profilePath;
}

function spawn(workingDir, { resumeTarget = null, easyccSessionId = '', env = {} } = {}) {
  const capability = getCapability();
  if (!capability.available) throw new Error(capability.reason);
  ensureProfile();
  const args = [
    '--profile', PROFILE_NAME,
    '--strict-config',
    '--dangerously-bypass-hook-trust',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C', workingDir
  ];
  if (resumeTarget) args.push('resume', resumeTarget);
  const executable = capability.codexExePath || capability.nodePath;
  if (!capability.codexExePath) args.unshift(capability.codexJsPath);
  const codexPackageRoot = capability.codexJsPath
    ? path.resolve(path.dirname(capability.codexJsPath), '..')
    : '';
  return pty.spawn(executable, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: workingDir,
    // Native Codex stalls after its initial clear-screen sequence when the
    // Windows system ConPTY is hosted by Electron's GUI process. WinPTY keeps
    // codex.exe as the PTY root and reliably delivers its subsequent redraws.
    useConpty: false,
    env: {
      ...process.env,
      ...env,
      EASYCC_SESSION_ID: easyccSessionId,
      ...(capability.codexExePath ? {
        CODEX_MANAGED_BY_NPM: '1',
        CODEX_MANAGED_PACKAGE_ROOT: codexPackageRoot
      } : {})
    }
  });
}

module.exports = { PROFILE_NAME, getCodexHome, getCapability, ensureProfile, findNativeCodexExe, spawn };
