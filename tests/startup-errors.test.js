const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyStartupError } = require('../electron/startupErrors');

test('startup errors distinguish port, permissions, and generic failures', () => {
  const port = classifyStartupError(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }), { port: 5010 });
  assert.match(port.title, /Port/);
  assert.match(port.message, /5010/);

  const cause = Object.assign(new Error('denied'), { code: 'EPERM', path: 'C:\\Program Files\\EasyCC' });
  const permissions = classifyStartupError(new Error('bootstrap failed', { cause }));
  assert.match(permissions.title, /Not Writable/);
  assert.match(permissions.message, /Program Files/);

  const generic = classifyStartupError(new Error('unknown'), {
    logPaths: { mainLogFile: 'C:\\logs\\easycc.log' }
  });
  assert.match(generic.title, /Failed/);
  assert.match(generic.message, /easycc\.log/);
});
