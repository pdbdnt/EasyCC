const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseWslBrowseRoot,
  resolveDefaultWslBrowseRoot
} = require('../backend/folderBrowseRoots');

test('parseWslBrowseRoot converts the discovered distro and home to a UNC path', () => {
  assert.equal(
    parseWslBrowseRoot('Ubuntu\n/home/rose/apps\n'),
    '\\\\wsl$\\Ubuntu\\home\\rose\\apps'
  );
});

test('resolveDefaultWslBrowseRoot discovers the current Windows user instead of using a fixed username', () => {
  const result = resolveDefaultWslBrowseRoot({
    environment: {},
    platform: 'win32',
    runWslDiscovery: () => 'Ubuntu\n/home/someone-else/apps\n'
  });

  assert.equal(result, '\\\\wsl$\\Ubuntu\\home\\someone-else\\apps');
});

test('resolveDefaultWslBrowseRoot honors an explicit configured root', () => {
  let discoveryCalled = false;
  const result = resolveDefaultWslBrowseRoot({
    environment: { WSL_FOLDERS_BROWSE_ROOT: '/configured/projects' },
    platform: 'win32',
    runWslDiscovery: () => {
      discoveryCalled = true;
      return '';
    }
  });

  assert.equal(result, '/configured/projects');
  assert.equal(discoveryCalled, false);
});

test('resolveDefaultWslBrowseRoot omits WSL when discovery fails', () => {
  const result = resolveDefaultWslBrowseRoot({
    environment: {},
    platform: 'win32',
    runWslDiscovery: () => {
      throw new Error('WSL unavailable');
    }
  });

  assert.equal(result, '');
});

test('resolveDefaultWslBrowseRoot uses the current home on non-Windows hosts', () => {
  assert.equal(resolveDefaultWslBrowseRoot({
    environment: {},
    platform: 'linux',
    homeDirectory: '/home/rose',
    pathExists: candidate => candidate === '/home/rose/apps'
  }), '/home/rose/apps');

  assert.equal(resolveDefaultWslBrowseRoot({
    environment: {},
    platform: 'linux',
    homeDirectory: '/home/rose',
    pathExists: () => false
  }), '/home/rose');
});
