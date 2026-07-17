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

  const fd = fs.openSync(filePath, 'r');

  try {
    let startByte = window.startByte;
    let endByte = window.endByte;
    const startProbe = Buffer.alloc(Math.min(4, Math.max(0, totalBytes - startByte)));
    if (startProbe.length) fs.readSync(fd, startProbe, 0, startProbe.length, startByte);
    while (startByte < endByte && startProbe[startByte - window.startByte] !== undefined &&
           (startProbe[startByte - window.startByte] & 0xc0) === 0x80) {
      startByte += 1;
    }

    const tailStart = Math.max(startByte, endByte - 4);
    const tail = Buffer.alloc(Math.max(0, endByte - tailStart));
    if (tail.length) fs.readSync(fd, tail, 0, tail.length, tailStart);
    if (tail.length) {
      let leadIndex = tail.length - 1;
      while (leadIndex > 0 && (tail[leadIndex] & 0xc0) === 0x80) leadIndex -= 1;
      const lead = tail[leadIndex];
      const expected = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
      if (leadIndex + expected > tail.length) endByte = tailStart + leadIndex;
    }

    const byteLength = Math.max(0, endByte - startByte);
    const buffer = Buffer.alloc(byteLength);
    fs.readSync(fd, buffer, 0, byteLength, startByte);
    return {
      ...window,
      startByte,
      endByte,
      hasMore: startByte > 0,
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
