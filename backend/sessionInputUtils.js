/**
 * Returns true when terminal input represents a submitted prompt/command.
 * Draft typing (no newline) is intentionally excluded.
 * @param {string} text
 * @returns {boolean}
 */
function hasSubmittedInput(text) {
  if (!text || typeof text !== 'string') return false;
  return text.includes('\r') || text.includes('\n');
}

/**
 * Strip ANSI escape sequences from output.
 * @param {string} data
 * @returns {string}
 */
function stripAnsi(data) {
  if (!data || typeof data !== 'string') return '';
  return data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Heuristic for local terminal echo while user is drafting input.
 * @param {string} data
 * @returns {boolean}
 */
function isLikelyLocalEchoOutput(data) {
  const cleaned = stripAnsi(data).replace(/\r/g, '');
  if (!cleaned) return true;
  if (cleaned.includes('\n')) return false;
  if (cleaned.length > 120) return false;
  return /^[\x20-\x7E\t]*$/.test(cleaned);
}

/**
 * Decide if output should refresh lastActivity.
 * @param {object} params
 * @param {string} params.data
 * @param {boolean} params.isComposingPrompt
 * @param {number} params.lastSubmittedInputAtMs
 * @param {number} params.nowMs
 * @returns {boolean}
 */
function shouldCountOutputAsActivity({
  data,
  isComposingPrompt = false,
  lastSubmittedInputAtMs = 0,
  nowMs = Date.now()
}) {
  // Don't count trivial output (spinner chars, cursor blinks) as activity.
  // This allows the idle timer to fire when the terminal is just animating.
  const stripped = stripAnsi(data).trim();
  if (stripped.length < 3) {
    return false;
  }

  // "Baked for Xs" is Claude Code's idle redraw — not real activity.
  if (/Baked for \d+/i.test(stripped)) {
    return false;
  }

  const echoLike = isLikelyLocalEchoOutput(data);

  // Suppress local echo when user is still drafting (no Enter submitted yet).
  if (isComposingPrompt && echoLike) {
    return false;
  }

  // Suppress short-lived command echo right after Enter.
  if (echoLike && lastSubmittedInputAtMs > 0 && (nowMs - lastSubmittedInputAtMs) < 1500) {
    return false;
  }

  return true;
}

module.exports = {
  hasSubmittedInput,
  stripAnsi,
  isLikelyLocalEchoOutput,
  shouldCountOutputAsActivity
};
