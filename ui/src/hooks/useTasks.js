import { useState, useCallback, useMemo, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';

export function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [tasksRes, stagesRes] = await Promise.all([
          fetch('/api/tasks'),
          fetch('/api/stages')
        ]);

        if (!tasksRes.ok || !stagesRes.ok) {
          throw new Error('Failed to fetch data');
        }

        const tasksData = await tasksRes.json();
        const stagesData = await stagesRes.json();

        setTasks(tasksData.tasks || []);
        setStages(stagesData.stages || []);
        setError(null);
      } catch (err) {
        setError(err.message);
        console.error('Error fetching tasks/stages:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  // Handle WebSocket messages for real-time updates
  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case 'taskCreated':
        setTasks(prev => {
          if (prev.some(t => t.id === data.task.id)) return prev;
          return [...prev, data.task];
        });
        break;

      case 'taskUpdated':
      case 'taskMoved':
      case 'taskAssigned':
      case 'taskUnassigned':
      case 'taskBlocked':
        setTasks(prev => prev.map(task =>
          task.id === data.task.id ? data.task : task
        ));
        break;

      case 'taskDeleted':
        setTasks(prev => prev.filter(task => task.id !== data.taskId));
        break;

      case 'stagesUpdated':
        setStages(data.stages);
        break;

      case 'dependencyAdded':
      case 'dependencyRemoved':
        // Refresh the affected task
        if (data.task) {
          setTasks(prev => prev.map(task =>
            task.id === data.task.id ? data.task : task
          ));
        }
        break;

      default:
        break;
    }
  }, []);

  // Connect to dashboard WebSocket for task updates
  useWebSocket('/socket/dashboard', {
    onMessage: handleMessage
  });

  // Get tasks grouped by stage
  const tasksByStage = useMemo(() => {
    const grouped = {};
    stages.forEach(stage => {
      grouped[stage.id] = tasks.filter(task => task.stage === stage.id);
    });
    return grouped;
  }, [tasks, stages]);

  // Create a new task
  const createTask = useCallback(async (taskData) => {
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create task');
      }

      const { task } = await response.json();
      // Task will be added via WebSocket, but add optimistically
      setTasks(prev => [...prev, task]);
      return task;
    } catch (err) {
      console.error('Error creating task:', err);
      throw err;
    }
  }, []);

  // Update a task
  const updateTask = useCallback(async (taskId, updates) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update task');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error updating task:', err);
      throw err;
    }
  }, []);

  // Delete a task
  const deleteTask = useCallback(async (taskId) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete task');
      }

      setTasks(prev => prev.filter(t => t.id !== taskId));
      return true;
    } catch (err) {
      console.error('Error deleting task:', err);
      throw err;
    }
  }, []);

  // Move task to a different stage
  const moveTask = useCallback(async (taskId, targetStage, reason = null) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: targetStage, reason })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to move task');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error moving task:', err);
      throw err;
    }
  }, []);

  // Advance task to next stage
  const advanceTask = useCallback(async (taskId) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/advance`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to advance task');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error advancing task:', err);
      throw err;
    }
  }, []);

  // Reject task to previous stage
  const rejectTask = useCallback(async (taskId, reason, targetStage = null) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, targetStage })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to reject task');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error rejecting task:', err);
      throw err;
    }
  }, []);

  // Assign agent to task
  const assignAgent = useCallback(async (taskId, agentId, sessionId) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, sessionId })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to assign agent');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error assigning agent:', err);
      throw err;
    }
  }, []);

  // Unassign agent from task
  const unassignAgent = useCallback(async (taskId) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/unassign`, {
        method: 'POST'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to unassign agent');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error unassigning agent:', err);
      throw err;
    }
  }, []);

  // Add dependency
  const addDependency = useCallback(async (taskId, blockerId) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockerId })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to add dependency');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error adding dependency:', err);
      throw err;
    }
  }, []);

  // Remove dependency
  const removeDependency = useCallback(async (taskId, blockerId) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/dependencies/${blockerId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove dependency');
      }

      const { task } = await response.json();
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err) {
      console.error('Error removing dependency:', err);
      throw err;
    }
  }, []);

  return useMemo(() => ({
    tasks,
    stages,
    tasksByStage,
    loading,
    error,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    advanceTask,
    rejectTask,
    assignAgent,
    unassignAgent,
    addDependency,
    removeDependency
  }), [
    tasks,
    stages,
    tasksByStage,
    loading,
    error,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    advanceTask,
    rejectTask,
    assignAgent,
    unassignAgent,
    addDependency,
    removeDependency
  ]);
}

export default useTasks;
