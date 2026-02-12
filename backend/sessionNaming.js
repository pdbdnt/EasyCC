/**
 * Build the base auto-generated session name for a CLI type.
 * @param {Date} now
 * @param {string} cliType
 * @returns {string}
 */
function generateSessionName(now = new Date(), cliType = 'claude') {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const time = `${hours}${minutes}`;
  const prefix = cliType === 'terminal' ? 'Terminal' : cliType === 'codex' ? 'Codex' : 'Session';
  return `${prefix} ${date}-${time}`;
}

/**
 * Ensure an auto-generated name is unique among existing names.
 * @param {string} baseName
 * @param {string[]} existingNames
 * @returns {string}
 */
function ensureUniqueSessionName(baseName, existingNames = []) {
  const used = new Set((existingNames || []).filter(Boolean));
  if (!used.has(baseName)) return baseName;

  let n = 2;
  while (used.has(`${baseName} (${n})`)) {
    n += 1;
  }
  return `${baseName} (${n})`;
}

module.exports = {
  generateSessionName,
  ensureUniqueSessionName
};
