import { useState, useMemo } from 'react';
import KanbanColumn from './KanbanColumn';
import TaskModal from './TaskModal';
import TaskViewModal from './TaskViewModal';
import useTasks from '../hooks/useTasks';

function KanbanBoard({ sessions, settings, onUpdateSession }) {
  const {
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
    unassignAgent
  } = useTasks();

  const [draggingTaskId, setDraggingTaskId] = useState(null);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [viewingTask, setViewingTask] = useState(null);
  const [selectedProjects, setSelectedProjects] = useState(new Set()); // Empty = all

  // Get unique projects from tasks
  const projects = useMemo(() => {
    const projectSet = new Set(tasks.map(t => t.project));
    return Array.from(projectSet).sort();
  }, [tasks]);

  // Filter tasks by selected projects (empty set = show all)
  const filteredTasksByStage = useMemo(() => {
    if (selectedProjects.size === 0) {
      return tasksByStage;
    }
    const filtered = {};
    stages.forEach(stage => {
      filtered[stage.id] = (tasksByStage[stage.id] || []).filter(
        task => selectedProjects.has(task.project)
      );
    });
    return filtered;
  }, [tasksByStage, selectedProjects, stages]);

  // Get session for a task (by assignedSessionId)
  const getTaskSession = (task) => {
    if (!task.assignedSessionId) return null;
    return sessions?.find(s => s.id === task.assignedSessionId) || null;
  };

  // Toggle project selection
  const toggleProject = (project) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(project)) {
        next.delete(project);
      } else {
        next.add(project);
      }
      return next;
    });
  };

  // Select all / none
  const toggleAllProjects = () => {
    if (selectedProjects.size === projects.length) {
      setSelectedProjects(new Set());
    } else {
      setSelectedProjects(new Set(projects));
    }
  };

  const handleDragStart = (task) => {
    setDraggingTaskId(task.id);
  };

  const handleDragEnd = () => {
    setDraggingTaskId(null);
  };

  const handleTaskDrop = async (taskId, targetStageId) => {
    setDraggingTaskId(null);
    const task = tasks.find(t => t.id === taskId);
    if (task && task.stage !== targetStageId) {
      try {
        await moveTask(taskId, targetStageId);
      } catch (err) {
        alert(`Failed to move task: ${err.message}`);
      }
    }
  };

  const handleAddTask = (stageId) => {
    setEditingTask(null);
    setShowTaskModal(true);
  };

  const handleEditTask = (task) => {
    setEditingTask(task);
    setShowTaskModal(true);
  };

  const handleViewTask = (task) => {
    setViewingTask(task);
  };

  const handleDeleteTask = async (taskId) => {
    try {
      await deleteTask(taskId);
    } catch (err) {
      alert(`Failed to delete task: ${err.message}`);
    }
  };

  const handleSaveTask = async (taskData) => {
    try {
      if (editingTask) {
        await updateTask(editingTask.id, taskData);
      } else {
        await createTask(taskData);
      }
      setShowTaskModal(false);
      setEditingTask(null);
    } catch (err) {
      alert(`Failed to save task: ${err.message}`);
    }
  };

  const handleCloseModal = () => {
    setShowTaskModal(false);
    setEditingTask(null);
  };

  const handleCloseViewModal = () => {
    setViewingTask(null);
  };

  const handleAdvanceTask = async (taskId) => {
    try {
      await advanceTask(taskId);
      // Close modal - WebSocket will update the task in the list
      setViewingTask(null);
    } catch (err) {
      alert(`Failed to advance task: ${err.message}`);
    }
  };

  const handleRejectTask = async (taskId, reason, targetStage) => {
    try {
      await rejectTask(taskId, reason, targetStage);
      // Close modal - WebSocket will update the task in the list
      setViewingTask(null);
    } catch (err) {
      alert(`Failed to reject task: ${err.message}`);
    }
  };

  const handleUnassignTask = async (taskId) => {
    try {
      await unassignAgent(taskId);
      if (viewingTask?.id === taskId) {
        const updated = tasks.find(t => t.id === taskId);
        if (updated) setViewingTask(updated);
      }
    } catch (err) {
      alert(`Failed to unassign task: ${err.message}`);
    }
  };

  // Calculate stats
  const stats = useMemo(() => {
    const total = tasks.length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;
    const done = tasks.filter(t => t.stage === 'done').length;
    return { total, inProgress, blocked, done };
  }, [tasks]);

  if (loading) {
    return (
      <div className="kanban-loading">
        <div className="loading-spinner"></div>
        <span>Loading kanban board...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="kanban-error">
        <span>Error loading kanban: {error}</span>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  return (
    <div className="kanban-board">
      <div className="kanban-toolbar">
        <div className="kanban-stats">
          <span className="stat">
            <strong>{stats.total}</strong> tasks
          </span>
          <span className="stat stat-active">
            <strong>{stats.inProgress}</strong> active
          </span>
          {stats.blocked > 0 && (
            <span className="stat stat-blocked">
              <strong>{stats.blocked}</strong> blocked
            </span>
          )}
          <span className="stat stat-done">
            <strong>{stats.done}</strong> done
          </span>
        </div>

        <div className="kanban-filters">
          <div className="project-filter-chips">
            <button
              className={`project-chip project-chip-all ${selectedProjects.size === 0 ? 'selected' : ''}`}
              onClick={() => setSelectedProjects(new Set())}
            >
              All
            </button>
            {projects.map(project => (
              <button
                key={project}
                className={`project-chip ${selectedProjects.has(project) ? 'selected' : ''}`}
                onClick={() => toggleProject(project)}
              >
                {project.split(/[/\\]/).pop()}
              </button>
            ))}
          </div>

          <button
            className="btn-primary"
            onClick={() => handleAddTask('backlog')}
          >
            + New Task
          </button>
        </div>
      </div>

      <div className="kanban-columns">
        {stages.map(stage => (
          <KanbanColumn
            key={stage.id}
            stage={stage}
            tasks={filteredTasksByStage[stage.id] || []}
            onTaskClick={handleViewTask}
            onTaskEdit={handleEditTask}
            onTaskDelete={handleDeleteTask}
            onTaskDrop={handleTaskDrop}
            onAddTask={handleAddTask}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            draggingTaskId={draggingTaskId}
          />
        ))}
      </div>

      {showTaskModal && (
        <TaskModal
          task={editingTask}
          projects={projects}
          sessions={sessions}
          onSave={handleSaveTask}
          onClose={handleCloseModal}
        />
      )}

      {viewingTask && (
        <TaskViewModal
          task={viewingTask}
          session={getTaskSession(viewingTask)}
          stages={stages}
          onClose={handleCloseViewModal}
          onUpdateTask={updateTask}
          onUpdateSession={onUpdateSession}
          onAdvance={handleAdvanceTask}
          onReject={handleRejectTask}
          onUnassign={handleUnassignTask}
          settings={settings}
        />
      )}
    </div>
  );
}

export default KanbanBoard;
