const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class AgentStore {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'agents.json');
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
      return parsed.agents || {};
    } catch (error) {
      console.error('Error loading agents:', error.message);
      return {};
    }
  }

  saveAll(agents) {
    fs.writeFileSync(this.filePath, JSON.stringify({ agents }, null, 2), 'utf8');
  }

  listAgents({ includeDeleted = false } = {}) {
    return Object.values(this.load())
      .filter((agent) => includeDeleted || !agent.deletedAt)
      .sort((a, b) => new Date(b.lastActiveAt || b.createdAt || 0) - new Date(a.lastActiveAt || a.createdAt || 0));
  }

  getAgent(id) {
    const agents = this.load();
    return agents[id] || null;
  }

  createAgent(config = {}) {
    const agents = this.load();
    const now = new Date().toISOString();
    const id = uuidv4();
    const agent = {
      id,
      name: (config.name || 'New Agent').trim(),
      role: typeof config.role === 'string' ? config.role : '',
      cliType: ['claude', 'codex', 'terminal', 'wsl'].includes(config.cliType) ? config.cliType : 'claude',
      workingDir: config.workingDir || process.cwd(),
      notes: typeof config.notes === 'string' ? config.notes : '',
      tags: Array.isArray(config.tags) ? config.tags : [],
      skills: Array.isArray(config.skills) ? config.skills : [],
      startupPrompt: typeof config.startupPrompt === 'string' ? config.startupPrompt : '',
      plans: Array.isArray(config.plans) ? config.plans : [],
      memory: Array.isArray(config.memory) ? config.memory : [],
      memoryEnabled: config.memoryEnabled !== false,
      activeSessionId: null,
      sessionHistory: [],
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      deletedAt: null
    };
    agents[id] = agent;
    this.saveAll(agents);
    return agent;
  }

  updateAgent(id, updates = {}) {
    const agents = this.load();
    if (!agents[id]) return null;
    const agent = agents[id];
    const allowed = [
      'name', 'role', 'cliType', 'workingDir', 'notes', 'tags', 'skills', 'startupPrompt',
      'plans', 'memory', 'memoryEnabled', 'activeSessionId',
      'sessionHistory', 'lastActiveAt', 'deletedAt'
    ];
    for (const field of allowed) {
      if (updates[field] !== undefined) {
        agent[field] = updates[field];
      }
    }
    agent.updatedAt = new Date().toISOString();
    agents[id] = agent;
    this.saveAll(agents);
    return agent;
  }

  deleteAgent(id) {
    const agents = this.load();
    if (!agents[id]) return null;
    agents[id].deletedAt = new Date().toISOString();
    agents[id].updatedAt = new Date().toISOString();
    this.saveAll(agents);
    return agents[id];
  }
}

module.exports = AgentStore;
