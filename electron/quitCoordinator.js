function createQuitCoordinator({ app, stopBackend, onStopped = () => {}, logger = console }) {
  let shutdownPromise = null;
  let finalExitAllowed = false;

  const requestQuit = (exitCode = 0) => {
    app.isQuitting = true;
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      let finalExitCode = exitCode;
      logger.log('[Electron] Shutting down gracefully...');
      try {
        await stopBackend();
      } catch (error) {
        finalExitCode = 1;
        logger.error('[Electron] Backend shutdown failed:', error);
      }
      onStopped();
      finalExitAllowed = true;
      app.exit(finalExitCode);
    })();

    return shutdownPromise;
  };

  const handleBeforeQuit = event => {
    if (finalExitAllowed) return;
    event.preventDefault();
    void requestQuit(0);
  };

  return {
    requestQuit,
    handleBeforeQuit,
    isFinalExitAllowed: () => finalExitAllowed
  };
}

module.exports = { createQuitCoordinator };
