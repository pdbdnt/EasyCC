import { useState, useMemo, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'claude-manager-session-groups';

function loadGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistGroups(groups) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

export function useSessionGroups(sessions) {
  const [sessionGroups, setSessionGroups] = useState(loadGroups);

  // Build O(1) lookup: sessionId -> group
  const sessionIdToGroup = useMemo(() => {
    const map = new Map();
    for (const group of sessionGroups) {
      for (const sid of group.sessionIds) {
        map.set(sid, group);
      }
    }
    return map;
  }, [sessionGroups]);

  // Prune dead session IDs from groups when sessions list changes
  useEffect(() => {
    if (!sessions || sessions.length === 0) return;
    const liveIds = new Set(sessions.map(s => s.id));

    setSessionGroups(prev => {
      let changed = false;
      const updated = prev.map(group => {
        const filtered = group.sessionIds.filter(id => liveIds.has(id));
        if (filtered.length !== group.sessionIds.length) {
          changed = true;
          return { ...group, sessionIds: filtered };
        }
        return group;
      }).filter(group => group.sessionIds.length > 1);

      if (changed || updated.length !== prev.length) {
        persistGroups(updated);
        return updated;
      }
      return prev;
    });
  }, [sessions]);

  const saveGroup = useCallback((name, sessionIds) => {
    const newGroup = {
      id: `group-${Date.now()}`,
      name,
      sessionIds: [...sessionIds],
      createdAt: new Date().toISOString()
    };

    setSessionGroups(prev => {
      // Remove these sessions from any existing groups (one group per session)
      const sessionSet = new Set(sessionIds);
      const cleaned = prev.map(group => ({
        ...group,
        sessionIds: group.sessionIds.filter(id => !sessionSet.has(id))
      })).filter(group => group.sessionIds.length > 1);

      const updated = [...cleaned, newGroup];
      persistGroups(updated);
      return updated;
    });

    return newGroup;
  }, []);

  const deleteGroup = useCallback((groupId) => {
    setSessionGroups(prev => {
      const updated = prev.filter(g => g.id !== groupId);
      persistGroups(updated);
      return updated;
    });
  }, []);

  const renameGroup = useCallback((groupId, newName) => {
    setSessionGroups(prev => {
      const updated = prev.map(g =>
        g.id === groupId ? { ...g, name: newName } : g
      );
      persistGroups(updated);
      return updated;
    });
  }, []);

  const removeSessionFromGroup = useCallback((groupId, sessionId) => {
    setSessionGroups(prev => {
      const updated = prev.map(g => {
        if (g.id !== groupId) return g;
        return { ...g, sessionIds: g.sessionIds.filter(id => id !== sessionId) };
      }).filter(g => g.sessionIds.length > 1);
      persistGroups(updated);
      return updated;
    });
  }, []);

  return {
    sessionGroups,
    sessionIdToGroup,
    saveGroup,
    deleteGroup,
    renameGroup,
    removeSessionFromGroup
  };
}
