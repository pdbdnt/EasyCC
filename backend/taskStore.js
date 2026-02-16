const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class TaskStore {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'tasks.json');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed.tasks || {};
    } catch (error) {
      console.error('Error loading tasks:', error.message);
      return {};
    }
  }

  saveAll(tasks) {
    fs.writeFileSync(this.filePath, JSON.stringify({ tasks }, null, 2), 'utf8');
  }

  listTasks({ includeArchived = false } = {}) {
    return Object.values(this.load())
      .filter((task) => includeArchived || !task.archivedAt)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  }

  getTask(id) {
    const tasks = this.load();
    return tasks[id] || null;
  }

  createTask(config = {}) {
    const tasks = this.load();
    const now = new Date().toISOString();
    const id = `task-${uuidv4().slice(0, 8)}`;
    const task = {
      id,
      title: (config.title || 'Untitled Task').trim(),
      description: typeof config.description === 'string' ? config.description : '',
      planContent: typeof config.planContent === 'string' ? config.planContent : '',
      assignedAgents: Array.isArray(config.assignedAgents) ? config.assignedAgents : [],
      comments: Array.isArray(config.comments) ? config.comments : [],
      runHistory: Array.isArray(config.runHistory) ? config.runHistory : [],
      stage: typeof config.stage === 'string' ? config.stage : 'todo',
      priority: Number.isFinite(config.priority) ? config.priority : 0,
      blockedBy: Array.isArray(config.blockedBy) ? config.blockedBy : [],
      blocks: Array.isArray(config.blocks) ? config.blocks : [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    tasks[id] = task;
    this.saveAll(tasks);
    return task;
  }

  updateTask(id, updates = {}) {
    const tasks = this.load();
    if (!tasks[id]) return null;
    const task = tasks[id];
    const allowed = [
      'title', 'description', 'planContent', 'assignedAgents', 'comments', 'stage',
      'priority', 'blockedBy', 'blocks', 'archivedAt', 'runHistory'
    ];
    for (const field of allowed) {
      if (updates[field] !== undefined) {
        task[field] = updates[field];
      }
    }
    task.updatedAt = new Date().toISOString();
    tasks[id] = task;
    this.saveAll(tasks);
    return task;
  }

  deleteTask(id) {
    const tasks = this.load();
    if (!tasks[id]) return null;
    tasks[id].archivedAt = new Date().toISOString();
    tasks[id].updatedAt = new Date().toISOString();
    this.saveAll(tasks);
    return tasks[id];
  }

  addComment(taskId, { author = 'user', text = '', mentions = [] } = {}) {
    const tasks = this.load();
    const task = tasks[taskId];
    if (!task) return null;
    const comment = {
      id: uuidv4().slice(0, 8),
      author,
      text,
      mentions: Array.isArray(mentions) ? mentions : [],
      timestamp: new Date().toISOString()
    };
    task.comments.push(comment);
    task.updatedAt = new Date().toISOString();
    tasks[taskId] = task;
    this.saveAll(tasks);
    return comment;
  }

  appendRun(taskId, runEntry = {}) {
    const tasks = this.load();
    const task = tasks[taskId];
    if (!task) return null;

    if (!Array.isArray(task.runHistory)) {
      task.runHistory = [];
    }

    const entry = {
      sessionId: runEntry.sessionId || null,
      agentId: runEntry.agentId || null,
      startedAt: runEntry.startedAt || new Date().toISOString(),
      endedAt: runEntry.endedAt || null,
      status: runEntry.status || 'active'
    };

    task.runHistory.push(entry);
    task.updatedAt = new Date().toISOString();
    tasks[taskId] = task;
    this.saveAll(tasks);
    return entry;
  }

  closeRun(taskId, { sessionId, agentId = null, endedAt, status = 'stopped' } = {}) {
    const tasks = this.load();
    const task = tasks[taskId];
    if (!task) return null;
    if (!Array.isArray(task.runHistory) || task.runHistory.length === 0) {
      return null;
    }

    const idx = task.runHistory.findIndex((entry) => {
      if (sessionId && entry.sessionId !== sessionId) return false;
      if (agentId && entry.agentId !== agentId) return false;
      return !entry.endedAt;
    });

    if (idx === -1) {
      return null;
    }

    task.runHistory[idx] = {
      ...task.runHistory[idx],
      endedAt: endedAt || new Date().toISOString(),
      status
    };

    task.updatedAt = new Date().toISOString();
    tasks[taskId] = task;
    this.saveAll(tasks);
    return task.runHistory[idx];
  }
}

module.exports = TaskStore;
