import { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import KanbanColumn from './KanbanColumn';
import KanbanSessionColumn from './KanbanSessionColumn';
import TaskModal from './TaskModal';
import TaskViewModal from './TaskViewModal';
import { getProjectDisplayName, getSessionGroupKey } from '../utils/projectUtils';

function KanbanBoard({
  sessions,
  tasks,
  agents,
  stages,
  sessionsByStage,
  moveSession,
  advanceSession,
  rejectSession,
  createTask,
  updateTask,
  deleteTask,
  assignTaskAgents,
  addTaskComment,
  startTaskRun,
  stopTaskRun,
  settings,
  onUpdateSession,
  onSessionSelect,
  onCreateSession,
  selectedSessionId,
  focusedColumnId,
  onPauseSession,
  onResumeSession,
  onKillSession,
  onResetPlacement,
  onLockPlacement,
  addToast,
  cardNodeRefs,
  sidebarRects,
  s2kFlipTriggerNonce = 0,
  onSidebarRectsConsumed,
  viewTransition,
  onProjectFilterChange,
  initialSelectedProjects
}) {
  const [draggingTaskId, setDraggingTaskId] = useState(null);
  const [draggingSessionId, setDraggingSessionId] = useState(null);
  const [viewingTask, setViewingTask] = useState(null);
  const [viewingSession, setViewingSession] = useState(null);
  const [entityMode, setEntityMode] = useState('sessions');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState(new Set());
  const lastS2kNonceRef = useRef(0);

  // Sync project filter from Sessions view on Ctrl+O switch
  useEffect(() => {
    if (initialSelectedProjects) {
      setSelectedProjects(new Set(initialSelectedProjects));
      onProjectFilterChange?.(new Set(initialSelectedProjects));
    } else {
      setSelectedProjects(new Set());
      onProjectFilterChange?.(new Set());
    }
  }, [initialSelectedProjects]); // eslint-disable-line react-hooks/exhaustive-deps

  // s2k FLIP animation: animate cards from sidebar positions to kanban positions
  useLayoutEffect(() => {
    const flipRequested = s2kFlipTriggerNonce > 0 && s2kFlipTriggerNonce !== lastS2kNonceRef.current;
    if (!flipRequested || !sidebarRects || sidebarRects.size === 0) return;
    if (!viewTransition?.active || viewTransition?.direction !== 's2k') return;
    if (settings?.ui?.showFlipAnimation === false) return;

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const userExplicitlyEnabled = settings?.ui?.showFlipAnimation === true;
    if (prefersReducedMotion && !userExplicitlyEnabled) return;

    const maxCards = settings?.ui?.maxFlipAnimationCards ?? 60;
    if (cardNodeRefs.size > maxCards) return;

    const speedMult = settings?.ui?.flipAnimationSpeed || 1;
    const flipDuration = Math.round(350 / speedMult);
    const fadeDuration = Math.round(200 / speedMult);
    const staggerMs = Math.round(40 / speedMult);

    // Temporarily allow overflow on kanban board + all columns for flying cards
    const boardEl = document.querySelector('.kanban-board');
    const columnEls = document.querySelectorAll('.kanban-column, .kanban-column-body');
    const savedOverflows = [];
    if (boardEl) { savedOverflows.push([boardEl, boardEl.style.overflow]); boardEl.style.overflow = 'visible'; }
    columnEls.forEach(el => { savedOverflows.push([el, el.style.overflow]); el.style.overflow = 'visible'; });

    const animations = [];
    let animIndex = 0;

    // Iterate ALL kanban card refs (across all columns)
    cardNodeRefs.forEach((node, sessionId) => {
      if (!node?.isConnected) return;
      const sidebarRect = sidebarRects.get(sessionId);
      if (!sidebarRect) {
        // No sidebar position — fade-in fallback
        node.style.willChange = 'transform, opacity';
        const anim = node.animate(
          [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: fadeDuration, easing: 'ease-out', delay: animIndex * staggerMs, fill: 'backwards' }
        );
        anim.onfinish = () => { node.style.willChange = ''; };
        animations.push(anim);
        animIndex++;
        return;
      }

      const kanbanRect = node.getBoundingClientRect();
      const dx = sidebarRect.left - kanbanRect.left;
      const dy = sidebarRect.top - kanbanRect.top;
      const staggerDelay = animIndex * staggerMs;

      node.style.position = 'relative';
      node.style.zIndex = '9999';
      node.style.willChange = 'transform, opacity';

      const anim = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.7 }, { transform: 'translate(0, 0)', opacity: 1 }],
        { duration: flipDuration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', delay: staggerDelay, fill: 'backwards' }
      );
      anim.onfinish = () => { node.style.willChange = ''; node.style.zIndex = ''; node.style.position = ''; };
      animations.push(anim);
      animIndex++;
    });

    // Restore overflow after all animations complete
    if (animations.length > 0) {
      const maxDuration = flipDuration + (animIndex * staggerMs) + 50;
      setTimeout(() => { savedOverflows.forEach(([el, val]) => { el.style.overflow = val || ''; }); }, maxDuration);
    }

    lastS2kNonceRef.current = s2kFlipTriggerNonce;
    onSidebarRectsConsumed?.();
  }, [s2kFlipTriggerNonce, sidebarRects, viewTransition, settings, cardNodeRefs, onSidebarRectsConsumed]);

  const activeTasks = useMemo(
    () => (tasks || []).filter((task) => !task.archivedAt),
    [tasks]
  );

  const tasksByStage = useMemo(() => {
    const grouped = {};
    for (const stage of stages || []) {
      grouped[stage.id] = activeTasks.filter((task) => task.stage === stage.id);
    }
    return grouped;
  }, [activeTasks, stages]);

  const agentsById = useMemo(() => {
    const map = new Map();
    for (const agent of agents || []) {
      if (!agent.deletedAt) map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const taskStats = useMemo(() => {
    const total = activeTasks.length;
    const inProgress = activeTasks.filter((task) => task.stage === 'in_progress').length;
    const blocked = activeTasks.filter((task) => task.stage === 'blocked').length;
    const done = activeTasks.filter((task) => task.stage === 'done').length;
    return { total, inProgress, blocked, done };
  }, [activeTasks]);

  const projects = useMemo(() => {
    const projectMap = new Map();
    for (const session of sessions || []) {
      const groupKey = getSessionGroupKey(session);
      if (!groupKey || projectMap.has(groupKey)) continue;
      projectMap.set(groupKey, getProjectDisplayName(session, settings?.projectAliases));
    }
    return Array.from(projectMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [sessions, settings?.projectAliases]);

  const filteredSessionsByStage = useMemo(() => {
    if (selectedProjects.size === 0) return sessionsByStage;
    const filtered = {};
    for (const stage of stages || []) {
      filtered[stage.id] = (sessionsByStage[stage.id] || [])
        .filter(s => selectedProjects.has(getSessionGroupKey(s)));
    }
    return filtered;
  }, [sessionsByStage, selectedProjects, stages]);

  const sessionStats = useMemo(() => {
    const allSessions = [];
    for (const stage of stages || []) {
      allSessions.push(...(filteredSessionsByStage[stage.id] || []));
    }
    const total = allSessions.length;
    const active = allSessions.filter((s) => ['active', 'thinking', 'editing'].includes(s.status)).length;
    const paused = allSessions.filter((s) => s.status === 'paused').length;
    const done = allSessions.filter((s) => s.stage === 'done').length;
    return { total, active, paused, done };
  }, [filteredSessionsByStage, stages]);

  const toggleProject = useCallback((project) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      onProjectFilterChange?.(new Set(next));
      return next;
    });
  }, [onProjectFilterChange]);

  const clearProjectFilter = useCallback(() => {
    setSelectedProjects(new Set());
    onProjectFilterChange?.(new Set());
  }, [onProjectFilterChange]);

  const handleTaskDrop = async (taskId, targetStageId) => {
    setDraggingTaskId(null);
    const task = activeTasks.find((item) => item.id === taskId);
    if (!task || task.stage === targetStageId) return;

    try {
      await updateTask?.(taskId, { stage: targetStageId });
      addToast?.('Task moved', 'success');
    } catch (error) {
      addToast?.(`Failed to move task: ${error.message}`, 'error');
    }
  };

  const handleSessionDrop = async (sessionId, targetStageId) => {
    setDraggingSessionId(null);
    const session = (sessions || []).find((item) => item.id === sessionId);
    if (!session || session.stage === targetStageId) return;

    try {
      await moveSession?.(sessionId, targetStageId);
      addToast?.('Session moved', 'success');
    } catch (error) {
      addToast?.(`Failed to move session: ${error.message}`, 'error');
    }
  };

  const handleAddTask = async (stageId) => {
    try {
      const task = await createTask?.({
        title: 'New Task',
        description: '',
        stage: stageId
      });
      if (task) {
        setViewingTask(task);
      }
    } catch (error) {
      addToast?.(`Failed to create task: ${error.message}`, 'error');
    }
  };

  const toggleTaskSelection = useCallback((taskId) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleSelectAllInColumn = useCallback((stageId) => {
    const columnTasks = tasksByStage[stageId] || [];
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      const allSelected = columnTasks.every(t => prev.has(t.id));
      if (allSelected) {
        columnTasks.forEach(t => next.delete(t.id));
      } else {
        columnTasks.forEach(t => next.add(t.id));
      }
      return next;
    });
  }, [tasksByStage]);

  const handleBulkDelete = async () => {
    if (selectedTaskIds.size === 0) return;
    setBulkDeleting(true);
    const ids = [...selectedTaskIds];
    const results = await Promise.allSettled(ids.map(id => deleteTask?.(id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    if (failed > 0) {
      addToast?.(`Deleted ${succeeded}, failed ${failed}`, 'warning');
    } else {
      addToast?.(`Deleted ${succeeded} tasks`, 'success');
    }
    setSelectedTaskIds(new Set());
    setConfirmBulkDelete(false);
    setBulkDeleting(false);
    setBulkMode(false);
  };

  const exitBulkMode = () => {
    setBulkMode(false);
    setSelectedTaskIds(new Set());
    setConfirmBulkDelete(false);
  };

  if (!stages || stages.length === 0) {
    return (
      <div className="kanban-loading">
        <div className="loading-spinner"></div>
        <span>Loading kanban board...</span>
      </div>
    );
  }

  const modalTask = viewingTask ? (activeTasks.find((task) => task.id === viewingTask.id) || viewingTask) : null;

  return (
    <div className="kanban-board">
      <div className="kanban-toolbar">
        <div className="kanban-stats">
          {entityMode === 'tasks' ? (
            <>
              <span className="stat"><strong>{taskStats.total}</strong> tasks</span>
              <span className="stat stat-active"><strong>{taskStats.inProgress}</strong> in progress</span>
              <span className="stat stat-blocked"><strong>{taskStats.blocked}</strong> blocked</span>
              <span className="stat stat-done"><strong>{taskStats.done}</strong> done</span>
            </>
          ) : (
            <>
              <span className="stat"><strong>{sessionStats.total}</strong> sessions</span>
              <span className="stat stat-active"><strong>{sessionStats.active}</strong> active</span>
              <span className="stat stat-blocked"><strong>{sessionStats.paused}</strong> paused</span>
              <span className="stat stat-done"><strong>{sessionStats.done}</strong> done</span>
            </>
          )}
        </div>

        {entityMode === 'sessions' && projects.length > 1 && (
          <div className="project-filter-chips">
            <button
              className={`project-chip project-chip-all ${selectedProjects.size === 0 ? 'selected' : ''}`}
              onClick={clearProjectFilter}
            >All</button>
            {projects.map(([projectKey, projectName]) => (
              <button
                key={projectKey}
                className={`project-chip ${selectedProjects.has(projectKey) ? 'selected' : ''}`}
                onClick={() => toggleProject(projectKey)}
              >{projectName}</button>
            ))}
          </div>
        )}

        <div className="kanban-entity-toggle">
          <button className={`btn btn-small ${entityMode === 'sessions' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setEntityMode('sessions'); exitBulkMode(); }}>Sessions</button>
          <button className={`btn btn-small ${entityMode === 'tasks' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setEntityMode('tasks')}>Tasks</button>
          {entityMode === 'tasks' && (
            <button
              className={`btn btn-small ${bulkMode ? 'btn-warning' : 'btn-secondary'}`}
              onClick={() => bulkMode ? exitBulkMode() : setBulkMode(true)}
            >
              {bulkMode ? 'Cancel Select' : 'Select'}
            </button>
          )}
        </div>
      </div>

      <div className="kanban-columns">
        {stages.map((stage) => (
          entityMode === 'tasks' ? (
            <KanbanColumn
              key={stage.id}
              stage={stage}
              tasks={tasksByStage[stage.id] || []}
              agentsById={agentsById}
              onTaskClick={(task) => { if (!bulkMode) setViewingTask(task); }}
              onTaskDrop={handleTaskDrop}
              onAddTask={handleAddTask}
              onDragStart={(task) => setDraggingTaskId(task.id)}
              onDragEnd={() => setDraggingTaskId(null)}
              draggingTaskId={draggingTaskId}
              bulkMode={bulkMode}
              selectedTaskIds={selectedTaskIds}
              onToggleTaskSelect={toggleTaskSelection}
              onToggleSelectAll={toggleSelectAllInColumn}
            />
          ) : (
            <KanbanSessionColumn
              key={stage.id}
              stage={stage}
              sessions={(filteredSessionsByStage && filteredSessionsByStage[stage.id]) || []}
              settings={settings}
              onSessionClick={(session) => setViewingSession(session)}
              onSessionDrop={handleSessionDrop}
              onAddSession={onCreateSession}
              onDragStart={(session) => setDraggingSessionId(session.id)}
              onDragEnd={() => setDraggingSessionId(null)}
              draggingSessionId={draggingSessionId}
              onSessionSelect={onSessionSelect}
              selectedSessionId={selectedSessionId}
              focusedColumnId={focusedColumnId}
              cardNodeRefs={cardNodeRefs}
              onResetPlacement={onResetPlacement}
              onLockPlacement={onLockPlacement}
            />
          )
        ))}
      </div>

      {bulkMode && selectedTaskIds.size > 0 && (
        <div className="kanban-bulk-bar">
          <span className="kanban-bulk-count">{selectedTaskIds.size} selected</span>
          {!confirmBulkDelete ? (
            <button className="btn btn-small btn-danger" onClick={() => setConfirmBulkDelete(true)}>Delete Selected</button>
          ) : (
            <>
              <span className="kanban-bulk-confirm-text">Delete {selectedTaskIds.size} tasks?</span>
              <button className="btn btn-small btn-danger" onClick={handleBulkDelete} disabled={bulkDeleting}>
                {bulkDeleting ? 'Deleting...' : 'Confirm'}
              </button>
              <button className="btn btn-small" onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
            </>
          )}
          <button className="btn btn-small" onClick={exitBulkMode}>Exit Select</button>
        </div>
      )}

      {modalTask && entityMode === 'tasks' && !bulkMode && (
        <TaskModal
          task={modalTask}
          agents={agents}
          stages={stages}
          onClose={() => setViewingTask(null)}
          onUpdateTask={updateTask}
          onDeleteTask={deleteTask}
          onAssignTaskAgents={assignTaskAgents}
          onAddTaskComment={addTaskComment}
          onStartTaskRun={startTaskRun}
          onStopTaskRun={stopTaskRun}
          addToast={addToast}
        />
      )}

      {viewingSession && entityMode === 'sessions' && (
        <TaskViewModal
          session={viewingSession}
          stages={stages}
          onClose={() => setViewingSession(null)}
          onUpdateSession={onUpdateSession}
          onAdvance={advanceSession}
          onReject={rejectSession}
          onSessionSelect={onSessionSelect}
          settings={settings}
          onPauseSession={onPauseSession}
          onResumeSession={onResumeSession}
          onKillSession={onKillSession}
        />
      )}
    </div>
  );
}

export default KanbanBoard;
