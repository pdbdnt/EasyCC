const fs = require('fs');
const path = require('path');
const util = require('util');

function configurePackagedLogging({ app, processRef = process, consoleRef = console }) {
  if (!app.isPackaged) {
    return null;
  }

  const logsDirectory = app.getPath('logs');
  fs.mkdirSync(logsDirectory, { recursive: true });

  const mainLogFile = path.join(logsDirectory, 'easycc.log');
  const backendLogFile = path.join(logsDirectory, 'easycc-backend.log');

  const appendLog = (level, values) => {
    const message = util.formatWithOptions({ colors: false }, ...values);
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;

    try {
      fs.appendFileSync(mainLogFile, line, 'utf8');
    } catch {
      // A logging failure must never prevent the desktop app from starting.
    }
  };

  consoleRef.log = (...values) => appendLog('INFO', values);
  consoleRef.info = (...values) => appendLog('INFO', values);
  consoleRef.warn = (...values) => appendLog('WARN', values);
  consoleRef.error = (...values) => appendLog('ERROR', values);
  consoleRef.debug = (...values) => appendLog('DEBUG', values);

  // Fastify/Pino normally writes to fd 1. Packaged Windows GUI applications do
  // not have a console, so give the backend a real file destination instead.
  processRef.env.EASYCC_BACKEND_LOG_FILE = backendLogFile;

  const captureStdioError = streamName => error => {
    appendLog('ERROR', [
      `${streamName} write failed:`,
      error && error.stack ? error.stack : error
    ]);
  };

  if (processRef.stdout && typeof processRef.stdout.on === 'function') {
    processRef.stdout.on('error', captureStdioError('stdout'));
  }
  if (processRef.stderr && typeof processRef.stderr.on === 'function') {
    processRef.stderr.on('error', captureStdioError('stderr'));
  }

  appendLog('INFO', ['Packaged logging initialized']);

  return { logsDirectory, mainLogFile, backendLogFile };
}

module.exports = { configurePackagedLogging };
