import { useState, useCallback, useMemo, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';

export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const [stages, setStages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');

  // Fetch stages on mount
  useEffect(() => {
    const fetchStages = async () => {
      try {
        const res = await fetch('/api/stages');
        if (res.ok) {
          const data = await res.json();
          setStages(data.stages || []);
        }
      } catch (err) {
        console.error('Error fetching stages:', err);
      }
    };
    fetchStages();
  }, []);

  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case 'init':
        setSessions(data.sessions || []);
        // Auto-select first session if none selected
        setSelectedId(prev => {
          if (!prev && data.sessions?.length > 0) {
            return data.sessions[0].id;
          }
          return prev;
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
          session.id === data.id
            ? { ...session, ...data }
            : session
        ));
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
          // If we were viewing the killed session, select another one
          if (selectedId === data.sessionId && newSessions.length > 0) {
            setSelectedId(newSessions[0].id);
          } else if (selectedId === data.sessionId) {
            setSelectedId(null);
          }
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
    setSelectedId(id);
  }, []);

  const createSession = useCallback(async (name, workingDir, cliType = 'claude', options = {}) => {
    try {
      const { select = true, stage, priority, description } = options;
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workingDir, cliType, stage, priority, description })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const { session } = await response.json();
      setSessions(prev => [...prev, session]);
      if (select) {
        setSelectedId(session.id);
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

    try {
      const response = await fetch(`/api/sessions/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete session');
      }

      // Session will be removed via WebSocket message
      return true;
    } catch (error) {
      console.error('Error deleting session:', error);
      alert(`Error: ${error.message}`);
      return false;
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

  const resumeSession = useCallback(async (id) => {
    try {
      const response = await fetch(`/api/sessions/${id}/resume`, {
        method: 'POST'
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
    stages,
    sessionsByStage,
    selectedId,
    selectSession,
    createSession,
    killSession,
    pauseSession,
    resumeSession,
    updateSession,
    moveSession,
    advanceSession,
    rejectSession,
    connectionStatus,
    isConnected
  }), [sessions, stages, sessionsByStage, selectedId, selectSession, createSession, killSession, pauseSession, resumeSession, updateSession, moveSession, advanceSession, rejectSession, connectionStatus, isConnected]);
}

export default useSessions;
