function findCodedError(error) {
  let current = error;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.code) return current;
    current = current.cause;
  }
  return error || {};
}

function classifyStartupError(error, { port = 5010, logPaths = null } = {}) {
  const coded = findCodedError(error);
  if (coded.code === 'EADDRINUSE') {
    return {
      title: 'Port Already in Use',
      message: `EasyCC could not start because port ${port} is already in use. Close the other application using this port, then try again.`
    };
  }

  if (coded.code === 'EACCES' || coded.code === 'EPERM') {
    const deniedPath = coded.path ? `\n\nPath: ${coded.path}` : '';
    return {
      title: 'EasyCC Data Folder Is Not Writable',
      message: `EasyCC could not create or update its data folder. Check the folder permissions or remove the EASYCC_DATA_DIR override, then try again.${deniedPath}`
    };
  }

  const logFile = logPaths && (logPaths.mainLogFile || logPaths.backendLogFile);
  const details = logFile ? `\n\nDetails were written to:\n${logFile}` : '';
  return {
    title: 'Failed to Start EasyCC',
    message: `EasyCC could not start its backend server.${details}`
  };
}

module.exports = { findCodedError, classifyStartupError };
