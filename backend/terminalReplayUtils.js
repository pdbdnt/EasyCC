const DEFAULT_TERMINAL_REPLAY_MAX_BYTES = 12 * 1024 * 1024;

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

  let low = 0;
  let high = text.length;
  let best = text.length;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(mid);
    const candidateBytes = Buffer.byteLength(candidate, 'utf8');
    if (candidateBytes <= maxBytes) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return { text: text.slice(best), truncated: true };
}

function prepareTerminalReplayPayload(chunks, maxBytes = DEFAULT_TERMINAL_REPLAY_MAX_BYTES) {
  const joined = Array.isArray(chunks) ? chunks.join('') : '';
  const { text, truncated } = tailByBytes(joined, maxBytes);
  if (!truncated) {
    return { data: text, truncated: false };
  }

  const maxMb = (maxBytes / (1024 * 1024)).toFixed(1);
  const notice = `\r\n\x1b[33m[replay truncated to last ${maxMb}MB]\x1b[0m\r\n`;
  return { data: notice + text, truncated: true };
}

module.exports = {
  DEFAULT_TERMINAL_REPLAY_MAX_BYTES,
  prepareTerminalReplayPayload
};
