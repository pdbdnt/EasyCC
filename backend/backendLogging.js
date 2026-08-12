const pino = require('pino');

function createBackendLogging(logFile = process.env.EASYCC_BACKEND_LOG_FILE) {
  if (!logFile) {
    return {
      fastifyOptions: { logger: true },
      destination: null,
      close: async () => {}
    };
  }

  const destination = pino.destination({ dest: logFile, sync: true, mkdir: true });
  let closePromise = null;

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      if (destination.destroyed) {
        resolve();
        return;
      }

      try {
        destination.flushSync();
      } catch (error) {
        reject(error);
        return;
      }

      destination.once('close', resolve);
      destination.once('error', reject);
      try {
        destination.end();
      } catch (error) {
        reject(error);
      }
    });
    return closePromise;
  };

  return {
    fastifyOptions: {
      logger: {
        level: 'info',
        stream: destination
      }
    },
    destination,
    close
  };
}

module.exports = { createBackendLogging };
