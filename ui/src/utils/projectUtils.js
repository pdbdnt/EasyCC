/**
 * Extract the bottom-level directory name from a path
 */
export function getDirectoryName(path) {
  if (!path) return 'Unknown';
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'Unknown';
}

/**
 * Normalize path for consistent alias lookup (handles slash variants)
 */
export function normalizeWorkingDir(dir) {
  if (!dir) return '';
  return dir.replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * Get display name for a project - alias if set, otherwise directory name
 */
export function getProjectDisplayName(workingDir, projectAliases) {
  if (!workingDir) return 'Unknown';
  const normalized = normalizeWorkingDir(workingDir);
  const alias = projectAliases?.[workingDir] || projectAliases?.[normalized];
  if (alias) return alias;
  return getDirectoryName(workingDir);
}
