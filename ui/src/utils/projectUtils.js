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

export function getSessionGroupKey(session) {
  if (!session) return '';
  return normalizeWorkingDir(session.groupKey || session.repoRoot || session.workingDir);
}

export function getProjectAlias(projectAliases, ...keys) {
  for (const key of keys) {
    const normalized = normalizeWorkingDir(key);
    if (!normalized) continue;
    const alias = projectAliases?.[key] || projectAliases?.[normalized];
    if (alias) return alias;
  }
  return '';
}

/**
 * Get display name for a project - alias if set, otherwise directory name
 */
export function getProjectDisplayName(projectOrSession, projectAliases) {
  if (!projectOrSession) return 'Unknown';

  if (typeof projectOrSession === 'object') {
    const alias = getProjectAlias(
      projectAliases,
      projectOrSession.repoRoot,
      projectOrSession.groupKey,
      projectOrSession.workingDir
    );
    if (alias) return alias;
    if (projectOrSession.repoName) return projectOrSession.repoName;
    return getDirectoryName(projectOrSession.workingDir);
  }

  const normalized = normalizeWorkingDir(projectOrSession);
  const alias = getProjectAlias(projectAliases, projectOrSession, normalized);
  if (alias) return alias;
  return getDirectoryName(projectOrSession);
}
