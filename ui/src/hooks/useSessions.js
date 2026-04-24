import { useState, useCallback, useMemo, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';

async function fetchWithLocalFallback(path, options = {}) {
  const attempts = [path];
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const shouldProbeLocal = protocol === 'file:' || hostname === 'localhost';
    if (shouldProbeLocal) {
      if (port !== '5010') attempts.push(`http://localhost:5010${path}`);
      if (port !== '5011') attempts.push(`http://localhost:5011${path}`);
    }
  }

  let lastResponse = null;
  for (const url of attempts) {
    try {
      const response = await fetch(url, options);
      lastResponse = response;
      if (response.status !== 404) {
        return response;
      }
    } catch {
      // Try next candidate.
    }
  }

  if (lastResponse) return lastResponse;
  return fetch(path, options);
}

export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [stages, setStages] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  // Derived compat field — last selected is the "primary" for context sidebar etc.
  const selectedId = selectedIds[selectedIds.length - 1] || null;
  const [connectionStatus, setConnectionStatus] = useState('connecting');

  // Fetch stages on mount
  useEffect(() => {
    const controller = new AbortController();
    const fetchStages = async () => {
      try {
        const res = await fetch('/api/stages', { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setStages(data.stages || []);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Error fetching stages:', err);
        }
      }
    };
    fetchStages();
    return () => controller.abort();
  }, []);

  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case 'init':
        setSessions(data.sessions || []);
        setAgents(data.agents || []);
        setTasks(data.tasks || []);
        // Auto-select first session if none selected
        setSelectedIds(prev => {
          if (prev.length === 0 && data.sessions?.length > 0) {
            return [data.sessions[0].id];
          }
          return prev;
        });
        break;

      case 'sessionCreated':
        setSessions(prev => {
          if (prev.some(s => s.id === data.session.id)) return prev;
          return [...prev, data.session];
        });
        break;

      case 'statusChange':
        setSessions(prev => prev.map(session =>
          session.id === data.sessionId
            ? {
                ...session,
                status: data.status,
                currentTask: data.currentTask || session.currentTask,
                lastActivity: new Date().toISOString()
              }
            : session
        ));
        break;

      case 'sessionUpdated':
        setSessions(prev => prev.map(session =>
          session.id === (data.id || data.sessionId)
            ? { ...session, ...data }
            : session
        ));
        break;

      case 'agentUpdated':
        setAgents(prev => {
          if (!data.agent) return prev;
          if (data.agent.deletedAt) return prev.filter(a => a.id !== data.agent.id);
          const idx = prev.findIndex(agent => agent.id === data.agent.id);
          if (idx === -1) return [...prev, data.agent];
          const next = [...prev];
          next[idx] = data.agent;
          return next;
        });
        break;

      case 'taskUpdated':
        setTasks(prev => {
          if (!data.task) return prev;
          if (data.task.archivedAt) return prev.filter(t => t.id !== data.task.id);
          const idx = prev.findIndex(task => task.id === data.task.id);
          if (idx === -1) return [...prev, data.task];
          const next = [...prev];
          next[idx] = data.task;
          return next;
        });
        break;

      case 'sessionMoved':
        setSessions(prev => prev.map(session =>
          session.id === data.sessionId
            ? { ...session, stage: data.toStage }
            : session
        ));
        break;

      case 'promptAdded':
        setSessions(prev => prev.map(session =>
          session.id === data.sessionId
            ? { ...session, promptHistory: data.promptHistory }
            : session
        ));
        break;

      case 'stagesUpdated':
        setStages(data.stages);
        break;

      case 'sessionKilled':
      case 'sessionEnded':
        setSessions(prev => {
          const newSessions = prev.filter(s => s.id !== data.sessionId);
          // Prune deleted session from selection
          setSelectedIds(prevIds => {
            const next = prevIds.filter(id => id !== data.sessionId);
            if (next.length === 0 && newSessions.length > 0) {
              return [newSessions[0].id];
            }
            return next;
          });
          return newSessions;
        });
        break;

      default:
        break;
    }
  }, []); // No dependencies - callback is stable

  const handleOpen = useCallback(() => {
    setConnectionStatus('connected');
  }, []);

  const handleClose = useCallback(() => {
    setConnectionStatus('disconnected');
  }, []);

  const { isConnected } = useWebSocket('/socket/dashboard', {
    onMessage: handleMessage,
    onOpen: handleOpen,
    onClose: handleClose
  });

  const selectSession = useCallback((id) => {
    setSelectedIds([id]);
  }, []);

  const setActiveSelectedId = useCallback((id) => {
    setSelectedIds(prev => {
      if (!prev.includes(id)) return prev;
      return [...prev.filter(x => x !== id), id];
    });
  }, []);

  const selectMultiple = useCallback((ids, activeId = null) => {
    setSelectedIds(activeId ? [...ids.filter(x => x !== activeId), activeId] : ids);
  }, []);

  const toggleSelectSession = useCallback((id) => {
    setSelectedIds(prev => {
      const idx = prev.indexOf(id);
      if (idx >= 0) return prev.filter(x => x !== id);
      return [...prev, id];
    });
  }, []);

  const createSession = useCallback(async (name, workingDir, cliType = 'claude', options = {}) => {
    try {
      const { select = true, stage, priority, description, role, isOrchestrator, parentSessionId, teamAction, teamName } = options;
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workingDir, cliType, stage, priority, description, role, isOrchestrator, parentSessionId, teamAction, teamName })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const { session } = await response.json();
      setSessions(prev => {
        if (prev.some(s => s.id === session.id)) return prev;
        return [...prev, session];
      });
      if (select) {
        setSelectedIds([session.id]);
      }
      return session;
    } catch (error) {
      console.error('Error creating session:', error);
      alert(`Error: ${error.message}`);
      return null;
    }
  }, []);

  const killSession = useCallback(async (id, options = {}) => {
    const { skipConfirm = false } = options;
    if (!skipConfirm && !confirm('Are you sure you want to delete this session?')) {
      return false;
    }

    const removeFromState = () => {
      setSessions(prev => prev.filter(s => s.id !== id));
      setSelectedIds(prev => prev.filter(sid => sid !== id));
    };

    try {
      const response = await fetch(`/api/sessions/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 404) {
        console.warn(`Kill session ${id}: server returned ${response.status}, removing locally anyway`);
      }
      // Remove from state on any response (200, 404, or error) — user wants it gone
      // WebSocket sessionKilled message is a harmless no-op backup (filter is idempotent)
      removeFromState();
      return true;
    } catch (error) {
      console.error('Error deleting session (removing locally):', error);
      // Network error — still remove from state, session is likely orphaned
      removeFromState();
      return true;
    }
  }, []);

  const pauseSession = useCallback(async (id) => {
    try {
      const response = await fetch(`/api/sessions/${id}/pause`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to pause session');
      }

      const { session } = await response.json();
      setSessions(prev => prev.map(s => s.id === id ? session : s));
      return true;
    } catch (error) {
      console.error('Error pausing session:', error);
      alert(`Error: ${error.message}`);
      return false;
    }
  }, []);

  const resumeSession = useCallback(async (id, { fresh = false } = {}) => {
    try {
      const response = await fetch(`/api/sessions/${id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fresh })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to resume session');
      }

      const { session } = await response.json();
      setSessions(prev => prev.map(s => s.id === id ? session : s));
      return true;
    } catch (error) {
      console.error('Error resuming session:', error);
      alert(`Error: ${error.message}`);
      return false;
    }
  }, []);

  const restartSession = useCallback(async (id) => {
    const session = sessions.find(item => item.id === id);
    if (!session || session.status === 'completed') {
      return false;
    }

    if (session.status !== 'paused') {
      const paused = await pauseSession(id);
      if (!paused) {
        return false;
      }
    }

    return resumeSession(id, { fresh: true });
  }, [pauseSession, resumeSession, sessions]);

  const updateSession = useCallback(async (id, updates) => {
    try {
      const response = await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update session');
      }

      const { session } = await response.json();
      setSessions(prev => prev.map(s => s.id === id ? session : s));
      return true;
    } catch (error) {
      console.error('Error updating session:', error);
      alert(`Error: ${error.message}`);
      return false;
    }
  }, []);

  // Stage/kanban methods
  const moveSession = useCallback(async (id, targetStage, reason = null) => {
    try {
      const response = await fetch(`/api/sessions/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: targetStage, reason })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to move session');
      }

      const { session } = await response.json();
      setSessions(prev => prev.map(s => s.id === id ? session : s));
      return session;
    } catch (err) {
      console.error('Error moving session:', err);
      throw err;
    }
  }, []);

  const advanceSession = useCallback(async (id) => {
    try {
      const response = await fetch(`/api/sessions/${id}/advance`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to advance session');
      }

      const { session } = await response.json();
      setSessions(prev => prev.map(s => s.id === id ? session : s));
      return session;
    } catch (err) {
      console.error('Error advancing session:', err);
      throw err;
    }
  }, []);

  const rejectSession = useCallback(async (id, reason, targetStage = null) => {
    try {
      const response = await fetch(`/api/sessions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, targetStage })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to reject session');
      }

      const { session } = await response.json();
      setSessions(prev => prev.map(s => s.id === id ? session : s));
      return session;
    } catch (err) {
      console.error('Error rejecting session:', err);
      throw err;
    }
  }, []);

  const resetPlacement = useCallback(async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/reset-placement`, { method: 'POST' });
      if (res.ok) {
        const { session } = await res.json();
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, ...session } : s));
      }
    } catch (err) {
      console.error('Failed to reset placement:', err);
    }
  }, []);

  const lockPlacement = useCallback(async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/lock-placement`, { method: 'POST' });
      if (res.ok) {
        const { session } = await res.json();
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, ...session } : s));
      }
    } catch (err) {
      console.error('Failed to lock placement:', err);
    }
  }, []);

  const createAgent = useCallback(async (payload) => {
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create agent');
      }
      const { agent } = await response.json();
      // Don't optimistically add - let the WebSocket 'agentUpdated' handler add it
      // to avoid duplicate entries from race between HTTP response and WS broadcast
      setAgents(prev => {
        if (prev.some(a => a.id === agent.id)) return prev;
        return [...prev, agent];
      });
      return agent;
    } catch (error) {
      console.error('Error creating agent:', error);
      alert(`Error: ${error.message}`);
      return null;
    }
  }, []);

  const updateAgent = useCallback(async (id, updates) => {
    try {
      const response = await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update agent');
      }
      const { agent } = await response.json();
      setAgents(prev => prev.map(a => (a.id === id ? agent : a)));
      return agent;
    } catch (error) {
      console.error('Error updating agent:', error);
      alert(`Error: ${error.message}`);
      return null;
    }
  }, []);

  const startAgent = useCallback(async (id) => {
    const response = await fetch(`/api/agents/${id}/start`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to start agent');
    const payload = await response.json();
    if (payload.agent) setAgents(prev => prev.map(a => (a.id === id ? payload.agent : a)));
    if (payload.session) setSessions(prev => {
      const exists = prev.some(s => s.id === payload.session.id);
      return exists ? prev.map(s => (s.id === payload.session.id ? payload.session : s)) : [...prev, payload.session];
    });
    return payload;
  }, []);

  const stopAgent = useCallback(async (id) => {
    const response = await fetch(`/api/agents/${id}/stop`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to stop agent');
    const payload = await response.json();
    if (payload.agent) setAgents(prev => prev.map(a => (a.id === id ? payload.agent : a)));
    return payload;
  }, []);

  const restartAgent = useCallback(async (id) => {
    const response = await fetch(`/api/agents/${id}/restart`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to restart agent');
    const payload = await response.json();
    if (payload.agent) setAgents(prev => prev.map(a => (a.id === id ? payload.agent : a)));
    if (payload.session) setSessions(prev => {
      const exists = prev.some(s => s.id === payload.session.id);
      return exists ? prev.map(s => (s.id === payload.session.id ? payload.session : s)) : [...prev, payload.session];
    });
    return payload;
  }, []);

  const rewarmAgent = useCallback(async (id) => {
    const response = await fetch(`/api/agents/${id}/rewarm`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to re-warm agent');
    return response.json();
  }, []);

  const createTask = useCallback(async (payload) => {
    const response = await fetchWithLocalFallback('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to create task');
    const { task } = await response.json();
    // Don't optimistically add - let the WebSocket 'taskUpdated' handler add it
    // to avoid duplicate entries from race between HTTP response and WS broadcast
    setTasks(prev => {
      if (prev.some(t => t.id === task.id)) return prev;
      return [...prev, task];
    });
    return task;
  }, []);

  const updateTask = useCallback(async (id, updates) => {
    const response = await fetchWithLocalFallback(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to update task');
    const { task } = await response.json();
    setTasks(prev => prev.map(t => (t.id === id ? task : t)));
    return task;
  }, []);

  const assignTaskAgents = useCallback(async (id, assignedAgents) => {
    const response = await fetchWithLocalFallback(`/api/tasks/${id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedAgents })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to assign task agents');
    const { task } = await response.json();
    setTasks(prev => prev.map(t => (t.id === id ? task : t)));
    return task;
  }, []);

  const addTaskComment = useCallback(async (id, payload) => {
    const response = await fetchWithLocalFallback(`/api/tasks/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to add task comment');
    const result = await response.json();
    if (result.task) {
      setTasks(prev => prev.map(t => (t.id === id ? result.task : t)));
    }
    return result;
  }, []);

  const startTaskRun = useCallback(async (id, agentId) => {
    const response = await fetchWithLocalFallback(`/api/tasks/${id}/start-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to start task run');
    const payload = await response.json();
    if (payload.task) {
      setTasks(prev => prev.map(t => (t.id === id ? payload.task : t)));
    }
    if (payload.session) {
      setSessions(prev => {
        const exists = prev.some(s => s.id === payload.session.id);
        return exists ? prev.map(s => (s.id === payload.session.id ? payload.session : s)) : [...prev, payload.session];
      });
    }
    return payload;
  }, []);

  const stopTaskRun = useCallback(async (id, agentId) => {
    const response = await fetchWithLocalFallback(`/api/tasks/${id}/stop-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to stop task run');
    const payload = await response.json();
    if (payload.task) {
      setTasks(prev => prev.map(t => (t.id === id ? payload.task : t)));
    }
    return payload;
  }, []);

  const deleteTask = useCallback(async (id) => {
    setTasks(prev => prev.filter(t => t.id !== id));
    try {
      const response = await fetchWithLocalFallback(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Failed to delete task');
      return await response.json();
    } catch (error) {
      // Rollback: re-fetch tasks
      const res = await fetchWithLocalFallback('/api/tasks');
      if (res.ok) { const data = await res.json(); setTasks(data.tasks || []); }
      throw error;
    }
  }, []);

  const deleteAgent = useCallback(async (id) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, deletedAt: new Date().toISOString() } : a));
    try {
      const response = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Failed to delete agent');
      return await response.json();
    } catch (error) {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, deletedAt: null } : a));
      throw error;
    }
  }, []);

  // Sessions grouped by stage
  const sessionsByStage = useMemo(() => {
    const grouped = {};
    stages.forEach(stage => {
      grouped[stage.id] = sessions.filter(s => s.stage === stage.id);
    });
    return grouped;
  }, [sessions, stages]);

  return useMemo(() => ({
    sessions,
    agents,
    tasks,
    stages,
    sessionsByStage,
    selectedId,
    selectedIds,
    setSelectedIds,
    selectSession,
    selectMultiple,
    setActiveSelectedId,
    toggleSelectSession,
    createSession,
    killSession,
    pauseSession,
    resumeSession,
    restartSession,
    updateSession,
    moveSession,
    advanceSession,
    rejectSession,
    resetPlacement,
    lockPlacement,
    createAgent,
    updateAgent,
    startAgent,
    stopAgent,
    restartAgent,
    rewarmAgent,
    createTask,
    updateTask,
    assignTaskAgents,
    addTaskComment,
    startTaskRun,
    stopTaskRun,
    deleteTask,
    deleteAgent,
    connectionStatus,
    isConnected
  }), [sessions, agents, tasks, stages, sessionsByStage, selectedId, selectedIds, setSelectedIds, selectSession, selectMultiple, setActiveSelectedId, toggleSelectSession, createSession, killSession, pauseSession, resumeSession, restartSession, updateSession, moveSession, advanceSession, rejectSession, resetPlacement, lockPlacement, createAgent, updateAgent, startAgent, stopAgent, restartAgent, rewarmAgent, createTask, updateTask, assignTaskAgents, addTaskComment, startTaskRun, stopTaskRun, deleteTask, deleteAgent, connectionStatus, isConnected]);
}

export default useSessions;
