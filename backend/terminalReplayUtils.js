const DEFAULT_TERMINAL_REPLAY_MAX_BYTES = 512 * 1024;
const { trimToUtf8Tail } = require('./byteRingBuffer');

function tailByBytes(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false };
  }

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { text: '', truncated: text.length > 0 };
  }

  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text, truncated: false };
  }

  return { text: trimToUtf8Tail(text, maxBytes), truncated: true };
}

function prepareTerminalReplayPayload(chunks, maxBytes = DEFAULT_TERMINAL_REPLAY_MAX_BYTES) {
  const joined = Array.isArray(chunks) ? chunks.join('') : '';
  const { text, truncated } = tailByBytes(joined, maxBytes);
  const replayBytes = Buffer.byteLength(text, 'utf8');
  if (!truncated) {
    return { data: text, truncated: false, replayBytes };
  }

  const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
  const notice = `\r\n\x1b[33m[replay truncated to last ${maxMb}MB]\x1b[0m\r\n`;
  return { data: notice + text, truncated: true, replayBytes };
}

module.exports = {
  DEFAULT_TERMINAL_REPLAY_MAX_BYTES,
  prepareTerminalReplayPayload
};
