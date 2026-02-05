/**
 * Central registry for keyboard hint targets
 * Manages hint code to action mappings for Vimium-style navigation
 */

// Map of hint codes to their configurations
const hintRegistry = new Map();

/**
 * Register a hint target
 * @param {string} code - The hint code (e.g., 's1', 'ns', 'ct')
 * @param {object} config - Hint configuration
 * @param {function} config.action - Function to execute when hint is triggered
 * @param {React.RefObject} [config.elementRef] - Optional ref to the target element
 * @param {string} [config.label] - Optional human-readable label
 */
export function registerHint(code, config) {
  if (typeof config === 'function') {
    // Allow shorthand: registerHint('code', actionFn)
    hintRegistry.set(code.toLowerCase(), { action: config });
  } else {
    hintRegistry.set(code.toLowerCase(), config);
  }
}

/**
 * Unregister a hint target
 * @param {string} code - The hint code to remove
 */
export function unregisterHint(code) {
  hintRegistry.delete(code.toLowerCase());
}

/**
 * Execute a hint action by its code
 * @param {string} code - The hint code to execute
 * @returns {boolean} True if hint was found and executed
 */
export function executeHint(code) {
  const hint = hintRegistry.get(code.toLowerCase());
  if (hint && typeof hint.action === 'function') {
    try {
      hint.action();
      return true;
    } catch (error) {
      console.error(`Error executing hint '${code}':`, error);
      return false;
    }
  }
  return false;
}

/**
 * Check if a code matches any registered hint (exact match)
 * @param {string} code - The code to check
 * @returns {boolean} True if there's an exact match
 */
export function hasExactMatch(code) {
  return hintRegistry.has(code.toLowerCase());
}

/**
 * Check if a code is a partial match for any registered hint
 * @param {string} code - The partial code to check
 * @returns {string[]} Array of hint codes that start with this prefix
 */
export function getPartialMatches(code) {
  const prefix = code.toLowerCase();
  const matches = [];

  for (const hintCode of hintRegistry.keys()) {
    if (hintCode.startsWith(prefix)) {
      matches.push(hintCode);
    }
  }

  return matches;
}

/**
 * Check if typed chars could potentially match a hint
 * @param {string} code - The typed characters
 * @returns {boolean} True if there are potential matches
 */
export function hasPotentialMatch(code) {
  return getPartialMatches(code).length > 0;
}

/**
 * Get all registered hints
 * @returns {Array<[string, object]>} Array of [code, config] pairs
 */
export function getAllHints() {
  return Array.from(hintRegistry.entries());
}

/**
 * Get a specific hint configuration
 * @param {string} code - The hint code
 * @returns {object|undefined} The hint configuration or undefined
 */
export function getHint(code) {
  return hintRegistry.get(code.toLowerCase());
}

/**
 * Clear all registered hints
 */
export function clearAllHints() {
  hintRegistry.clear();
}

/**
 * Get the count of registered hints
 * @returns {number} Number of registered hints
 */
export function getHintCount() {
  return hintRegistry.size;
}

export default {
  registerHint,
  unregisterHint,
  executeHint,
  hasExactMatch,
  getPartialMatches,
  hasPotentialMatch,
  getAllHints,
  getHint,
  clearAllHints,
  getHintCount
};
