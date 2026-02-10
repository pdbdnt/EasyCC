/**
 * Task Manager for Kanban Agent Orchestration
 *
 * Manages tasks with stages, dependencies, and agent assignments.
 * Tasks extend the session concept for kanban workflow.
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const { TASK_STATUS, DEFAULT_STAGES, getNextStage, getPreviousStage, hasAgentPool } = require('./stagesConfig');

class TaskManager extends EventEmitter {
  constructor(dataStore, sessionManager) {
    super();
    this.dataStore = dataStore;
    this.sessionManager = sessionManager;
    this.tasks = new Map();
    this.stages = [...DEFAULT_STAGES];
  }

  /**
   * Initialize task manager - load persisted tasks and stages
   */
  async initialize() {
    const data = await this.dataStore.loadTasks();
    if (data.tasks) {
      for (const [id, task] of Object.entries(data.tasks)) {
        this.tasks.set(id, task);
      }
    }
    if (data.stages && data.stages.length > 0) {
      this.stages = data.stages;
    }
    console.log(`TaskManager initialized with ${this.tasks.size} tasks and ${this.stages.length} stages`);
  }

  /**
   * Create a new task
   * @param {Object} taskData - Task creation data
   * @returns {Object} - Created task
   */
  createTask({
    title,
    description = '',
    project,
    stage = 'todo',
    priority = 0,
    blockedBy = [],
    tags = []
  }) {
    const id = `task-${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();

    const task = {
      id,
      title,
      description,
      project,
      stage,
      assignedAgent: null,
      assignedSessionId: null,
      status: TASK_STATUS.QUEUED,
      priority,
      createdAt: now,
      updatedAt: now,
      completedAt: null,

      // Dependencies
      blockedBy: [...blockedBy],
      blocks: [],

      // Tags
      tags: [...tags],

      // Rejection history for backwards flow
      rejectionHistory: [],

      // Manual placement lock
      manuallyPlaced: false,
      manualPlacedAt: null,

      // Context preserved between stages
      context: {
        planFile: null,
        workingDir: project,
        notes: '',
        promptHistory: []
      }
    };

    // Update reverse dependencies
    for (const blockerId of blockedBy) {
      const blocker = this.tasks.get(blockerId);
      if (blocker && !blocker.blocks.includes(id)) {
        blocker.blocks.push(id);
        this.tasks.set(blockerId, blocker);
      }
    }

    this.tasks.set(id, task);
    this._persist();

    this.emit('taskCreated', task);
    return task;
  }

  /**
   * Get a task by ID
   * @param {string} taskId - Task ID
   * @returns {Object|null} - Task or null
   */
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * Get all tasks
   * @returns {Array} - All tasks
   */
  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks filtered by criteria
   * @param {Object} filter - Filter criteria
   * @returns {Array} - Filtered tasks
   */
  getTasks({ stage, project, status, assignedAgent } = {}) {
    let tasks = this.getAllTasks();

    if (stage) {
      tasks = tasks.filter(t => t.stage === stage);
    }
    if (project) {
      tasks = tasks.filter(t => t.project === project);
    }
    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    if (assignedAgent !== undefined) {
      tasks = tasks.filter(t => t.assignedAgent === assignedAgent);
    }

    return tasks;
  }

  /**
   * Get tasks that are ready to be assigned (no blockers, in queue)
   * @param {string} stageId - Stage to check
   * @returns {Array} - Assignable tasks sorted by priority
   */
  getAssignableTasks(stageId) {
    return this.getTasks({ stage: stageId, status: TASK_STATUS.QUEUED })
      .filter(task => this._areBlockersResolved(task))
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Check if all blockers for a task are resolved
   * @param {Object} task - Task to check
   * @returns {boolean}
   */
  _areBlockersResolved(task) {
    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.get(blockerId);
      // Blocker must exist and be in 'done' stage
      if (!blocker || blocker.stage !== 'done') {
        return false;
      }
    }
    return true;
  }

  /**
   * Update a task
   * @param {string} taskId - Task ID
   * @param {Object} updates - Fields to update
   * @returns {Object} - Updated task
   */
  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const allowedFields = [
      'title', 'description', 'priority', 'tags', 'status',
      'assignedAgent', 'assignedSessionId', 'context', 'manuallyPlaced'
    ];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === 'context') {
          task.context = { ...task.context, ...updates.context };
        } else if (field === 'tags') {
          task.tags = [...updates.tags];
        } else {
          task[field] = updates[field];
        }
      }
    }

    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    this._persist();

    this.emit('taskUpdated', task);
    return task;
  }

  /**
   * Move task to a different stage
   * @param {string} taskId - Task ID
   * @param {string} targetStageId - Target stage ID
   * @param {Object} options - Move options
   * @returns {Object} - Updated task
   */
  moveTask(taskId, targetStageId, { reason = null, preserveAgent = false, source = 'system' } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Auto-sync must not override manual placement
    if (source === 'auto' && task.manuallyPlaced) {
      return task; // no-op
    }

    const targetStage = this.stages.find(s => s.id === targetStageId);
    if (!targetStage) {
      throw new Error(`Stage not found: ${targetStageId}`);
    }

    // Skip if already in target stage
    if (task.stage === targetStageId) {
      return task;
    }

    const previousStage = task.stage;

    // If moving backwards (rejection), record in history
    const currentStageOrder = this.stages.find(s => s.id === task.stage)?.order ?? 0;
    const targetStageOrder = targetStage.order;

    if (targetStageOrder < currentStageOrder && reason) {
      task.rejectionHistory.push({
        from: previousStage,
        to: targetStageId,
        reason,
        at: new Date().toISOString()
      });
    }

    task.stage = targetStageId;
    task.status = targetStageId === 'done' ? TASK_STATUS.DONE : TASK_STATUS.QUEUED;
    task.updatedAt = new Date().toISOString();
    if (targetStageId === 'done') {
      task.completedAt = new Date().toISOString();
    }

    // Set manual placement lock on manual moves
    if (source === 'manual') {
      task.manuallyPlaced = true;
      task.manualPlacedAt = new Date().toISOString();
    }

    // Clear agent assignment unless preserving
    if (!preserveAgent) {
      task.assignedAgent = null;
      task.assignedSessionId = null;
    }

    this.tasks.set(taskId, task);
    this._persist();

    this.emit('taskMoved', {
      task,
      fromStage: previousStage,
      toStage: targetStageId,
      reason
    });

    return task;
  }

  /**
   * Reset manual placement lock, re-enabling auto-sync
   * @param {string} taskId - Task ID
   * @returns {Object} - Updated task
   */
  resetManualPlacement(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.manuallyPlaced = false;
    task.manualPlacedAt = null;
    task.updatedAt = new Date().toISOString();

    this.tasks.set(taskId, task);
    this._persist();

    this.emit('taskUpdated', task);
    return task;
  }

  /**
   * Advance task to next stage
   * @param {string} taskId - Task ID
   * @returns {Object} - Updated task
   */
  advanceTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const nextStage = getNextStage(this.stages, task.stage);
    if (!nextStage) {
      throw new Error(`No next stage from: ${task.stage}`);
    }

    return this.moveTask(taskId, nextStage.id);
  }

  /**
   * Reject task back to previous stage
   * @param {string} taskId - Task ID
   * @param {string} reason - Rejection reason
   * @param {string} targetStageId - Optional specific stage to send back to
   * @returns {Object} - Updated task
   */
  rejectTask(taskId, reason, targetStageId = null) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    let targetStage;
    if (targetStageId) {
      targetStage = this.stages.find(s => s.id === targetStageId);
    } else {
      targetStage = getPreviousStage(this.stages, task.stage);
    }

    if (!targetStage) {
      throw new Error(`No valid rejection target from: ${task.stage}`);
    }

    return this.moveTask(taskId, targetStage.id, { reason });
  }

  /**
   * Assign an agent/session to a task
   * @param {string} taskId - Task ID
   * @param {string} agentId - Agent identifier
   * @param {string} sessionId - Session ID (from SessionManager)
   * @returns {Object} - Updated task
   */
  assignAgent(taskId, agentId, sessionId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.assignedAgent = agentId;
    task.assignedSessionId = sessionId;
    task.status = TASK_STATUS.IN_PROGRESS;
    task.updatedAt = new Date().toISOString();

    this.tasks.set(taskId, task);
    this._persist();

    this.emit('taskAssigned', { task, agentId, sessionId });
    return task;
  }

  /**
   * Unassign agent from task
   * @param {string} taskId - Task ID
   * @returns {Object} - Updated task
   */
  unassignAgent(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.assignedAgent = null;
    task.assignedSessionId = null;
    task.status = TASK_STATUS.QUEUED;
    task.updatedAt = new Date().toISOString();

    this.tasks.set(taskId, task);
    this._persist();

    this.emit('taskUnassigned', task);
    return task;
  }

  /**
   * Mark task as blocked
   * @param {string} taskId - Task ID
   * @param {string} reason - Block reason
   * @returns {Object} - Updated task
   */
  blockTask(taskId, reason) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = TASK_STATUS.BLOCKED;
    task.context.blockReason = reason;
    task.updatedAt = new Date().toISOString();

    this.tasks.set(taskId, task);
    this._persist();

    this.emit('taskBlocked', { task, reason });
    return task;
  }

  /**
   * Add a dependency to a task
   * @param {string} taskId - Task that will be blocked
   * @param {string} blockerId - Task that blocks
   * @returns {Object} - Updated task
   */
  addDependency(taskId, blockerId) {
    const task = this.tasks.get(taskId);
    const blocker = this.tasks.get(blockerId);

    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!blocker) throw new Error(`Blocker task not found: ${blockerId}`);

    if (!task.blockedBy.includes(blockerId)) {
      task.blockedBy.push(blockerId);
    }
    if (!blocker.blocks.includes(taskId)) {
      blocker.blocks.push(taskId);
    }

    task.updatedAt = new Date().toISOString();
    blocker.updatedAt = new Date().toISOString();

    this.tasks.set(taskId, task);
    this.tasks.set(blockerId, blocker);
    this._persist();

    this.emit('dependencyAdded', { task, blocker });
    return task;
  }

  /**
   * Remove a dependency from a task
   * @param {string} taskId - Task that was blocked
   * @param {string} blockerId - Task that was blocking
   * @returns {Object} - Updated task
   */
  removeDependency(taskId, blockerId) {
    const task = this.tasks.get(taskId);
    const blocker = this.tasks.get(blockerId);

    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.blockedBy = task.blockedBy.filter(id => id !== blockerId);
    if (blocker) {
      blocker.blocks = blocker.blocks.filter(id => id !== taskId);
      blocker.updatedAt = new Date().toISOString();
      this.tasks.set(blockerId, blocker);
    }

    task.updatedAt = new Date().toISOString();
    this.tasks.set(taskId, task);
    this._persist();

    this.emit('dependencyRemoved', { task, blockerId });
    return task;
  }

  /**
   * Delete a task
   * @param {string} taskId - Task ID
   * @returns {boolean} - Success
   */
  deleteTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    // Clean up dependencies
    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.get(blockerId);
      if (blocker) {
        blocker.blocks = blocker.blocks.filter(id => id !== taskId);
        this.tasks.set(blockerId, blocker);
      }
    }

    for (const blockedId of task.blocks) {
      const blocked = this.tasks.get(blockedId);
      if (blocked) {
        blocked.blockedBy = blocked.blockedBy.filter(id => id !== taskId);
        this.tasks.set(blockedId, blocked);
      }
    }

    this.tasks.delete(taskId);
    this._persist();

    this.emit('taskDeleted', { id: taskId });
    return true;
  }

  /**
   * Get all stages
   * @returns {Array} - All stages
   */
  getStages() {
    return [...this.stages].sort((a, b) => a.order - b.order);
  }

  /**
   * Update stages configuration
   * @param {Array} stages - New stages configuration
   * @returns {Array} - Updated stages
   */
  updateStages(stages) {
    this.stages = [...stages];
    this._persist();
    this.emit('stagesUpdated', this.stages);
    return this.stages;
  }

  /**
   * Get unique projects from all tasks
   * @returns {Array} - Project names
   */
  getProjects() {
    const projects = new Set();
    for (const task of this.tasks.values()) {
      if (task.project) {
        projects.add(task.project);
      }
    }
    return Array.from(projects).sort();
  }

  /**
   * Get task statistics per stage
   * @returns {Object} - Stats per stage
   */
  getStageStats() {
    const stats = {};

    for (const stage of this.stages) {
      const stageTasks = this.getTasks({ stage: stage.id });
      stats[stage.id] = {
        total: stageTasks.length,
        queued: stageTasks.filter(t => t.status === TASK_STATUS.QUEUED).length,
        inProgress: stageTasks.filter(t => t.status === TASK_STATUS.IN_PROGRESS).length,
        blocked: stageTasks.filter(t => t.status === TASK_STATUS.BLOCKED).length
      };
    }

    return stats;
  }

  /**
   * Persist tasks and stages to data store
   */
  _persist() {
    this.dataStore.saveTasks({
      tasks: Object.fromEntries(this.tasks),
      stages: this.stages
    });
  }
}

module.exports = TaskManager;
