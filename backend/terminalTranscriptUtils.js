const fs = require('fs');

const DEFAULT_TRANSCRIPT_PAGE_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 1024 * 1024;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getTranscriptWindow({
  totalBytes = 0,
  liveReplayBytes = 0,
  beforeBytes = null,
  limitBytes = DEFAULT_TRANSCRIPT_PAGE_BYTES
} = {}) {
  const safeTotalBytes = Math.max(0, Number.isFinite(totalBytes) ? totalBytes : 0);
  const safeLiveReplayBytes = clampNumber(
    Number.isFinite(liveReplayBytes) ? liveReplayBytes : 0,
    0,
    safeTotalBytes
  );
  const olderBytesAvailable = Math.max(0, safeTotalBytes - safeLiveReplayBytes);
  const safeLimitBytes = clampNumber(
    Number.isFinite(limitBytes) ? limitBytes : DEFAULT_TRANSCRIPT_PAGE_BYTES,
    1,
    MAX_TRANSCRIPT_PAGE_BYTES
  );

  const requestedBefore = beforeBytes === null || beforeBytes === undefined
    ? olderBytesAvailable
    : clampNumber(beforeBytes, 0, olderBytesAvailable);

  const endByte = requestedBefore;
  const startByte = Math.max(0, endByte - safeLimitBytes);

  return {
    startByte,
    endByte,
    hasMore: startByte > 0,
    totalBytes: safeTotalBytes,
    olderBytesAvailable,
    liveReplayBytes: safeLiveReplayBytes,
    limitBytes: safeLimitBytes
  };
}

function readTranscriptWindow(filePath, options = {}) {
  const totalBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const window = getTranscriptWindow({
    totalBytes,
    liveReplayBytes: options.liveReplayBytes,
    beforeBytes: options.beforeBytes,
    limitBytes: options.limitBytes
  });

  if (window.endByte <= window.startByte) {
    return {
      ...window,
      data: ''
    };
  }

  const byteLength = window.endByte - window.startByte;
  const fd = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(byteLength);
    fs.readSync(fd, buffer, 0, byteLength, window.startByte);
    return {
      ...window,
      data: buffer.toString('utf8')
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  DEFAULT_TRANSCRIPT_PAGE_BYTES,
  MAX_TRANSCRIPT_PAGE_BYTES,
  getTranscriptWindow,
  readTranscriptWindow
};
