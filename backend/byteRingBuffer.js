const DEFAULT_MAX_BYTES = 512 * 1024;

function trimToUtf8Tail(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const bytes = Buffer.from(text, 'utf8');
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

class ByteRingBuffer {
  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.byteLength = 0;
  }

  push(value) {
    if (typeof value !== 'string' || value.length === 0) return;
    let chunk = trimToUtf8Tail(value, this.maxBytes);
    let chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (!chunkBytes) return;

    this.chunks.push(chunk);
    this.byteLength += chunkBytes;

    while (this.byteLength > this.maxBytes && this.chunks.length > 1) {
      const excess = this.byteLength - this.maxBytes;
      const oldest = this.chunks[0];
      const oldestBytes = Buffer.byteLength(oldest, 'utf8');
      if (oldestBytes <= excess) {
        this.chunks.shift();
        this.byteLength -= oldestBytes;
        continue;
      }
      const retained = trimToUtf8Tail(oldest, oldestBytes - excess);
      this.chunks[0] = retained;
      this.byteLength -= oldestBytes - Buffer.byteLength(retained, 'utf8');
    }

    if (this.byteLength > this.maxBytes && this.chunks.length === 1) {
      chunk = trimToUtf8Tail(this.chunks[0], this.maxBytes);
      chunkBytes = Buffer.byteLength(chunk, 'utf8');
      this.chunks[0] = chunk;
      this.byteLength = chunkBytes;
    }
  }

  getAll() {
    return [...this.chunks];
  }

  clear() {
    this.chunks = [];
    this.byteLength = 0;
  }
}

module.exports = {
  ByteRingBuffer,
  DEFAULT_MAX_BYTES,
  trimToUtf8Tail
};
