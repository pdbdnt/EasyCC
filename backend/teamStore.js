const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const BUILT_IN_TEAMS = [
  {
    id: 'feature-dev',
    name: 'Feature Dev Team',
    description: 'Orchestrator + Backend + Frontend + Tests',
    strategy: 'hierarchical',
    builtIn: true,
    members: [
      { role: 'orchestrator', template: 'orchestrator', isOrchestrator: true },
      { role: 'backend', template: 'backend-dev' },
      { role: 'frontend', template: 'frontend-dev' },
      { role: 'test', template: 'test-writer' }
    ]
  },
  {
    id: 'review-team',
    name: 'Code Review Team',
    description: 'Reviewer + Bug Hunter',
    strategy: 'parallel',
    builtIn: true,
    members: [
      { role: 'orchestrator', template: 'orchestrator', isOrchestrator: true },
      { role: 'reviewer', template: 'code-reviewer' },
      { role: 'bugs', template: 'bug-hunter' }
    ]
  },
  {
    id: 'full-stack',
    name: 'Full Stack Team',
    description: 'Architect + Backend + Frontend + DevOps + Tests',
    strategy: 'hierarchical',
    builtIn: true,
    members: [
      { role: 'orchestrator', template: 'orchestrator', isOrchestrator: true },
      { role: 'architect', template: 'architect' },
      { role: 'backend', template: 'backend-dev' },
      { role: 'frontend', template: 'frontend-dev' },
      { role: 'devops', template: 'devops' },
      { role: 'test', template: 'test-writer' }
    ]
  }
];

class TeamStore {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.teamsFile = path.join(dataDir, 'teams.json');
    this.instancesFile = path.join(dataDir, 'team-instances.json');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadTeams() {
    try {
      if (!fs.existsSync(this.teamsFile)) {
        return {};
      }
      const parsed = JSON.parse(fs.readFileSync(this.teamsFile, 'utf8'));
      return parsed.teams || {};
    } catch (error) {
      console.error('Error loading teams:', error.message);
      return {};
    }
  }

  saveAllTeams(teams) {
    fs.writeFileSync(this.teamsFile, JSON.stringify({ teams }, null, 2), 'utf8');
  }

  listTeams() {
    const customTeams = Object.values(this.loadTeams());
    const builtIns = BUILT_IN_TEAMS.map((team) => ({ ...team }));
    return [...builtIns, ...customTeams].sort((a, b) => {
      if (!!a.builtIn !== !!b.builtIn) return a.builtIn ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  getTeam(id) {
    const builtIn = BUILT_IN_TEAMS.find((team) => team.id === id);
    if (builtIn) return { ...builtIn };
    const teams = this.loadTeams();
    return teams[id] || null;
  }

  createTeam(config = {}) {
    const teams = this.loadTeams();
    const now = new Date().toISOString();
    const id = config.id || uuidv4();
    const team = {
      id,
      name: config.name || 'New Team',
      description: config.description || '',
      strategy: config.strategy || 'hierarchical',
      members: Array.isArray(config.members) ? config.members : [],
      builtIn: false,
      createdAt: now,
      updatedAt: now
    };
    teams[id] = team;
    this.saveAllTeams(teams);
    return team;
  }

  updateTeam(id, updates = {}) {
    const teams = this.loadTeams();
    if (!teams[id]) return null;
    const team = teams[id];
    const allowed = ['name', 'description', 'strategy', 'members'];
    for (const field of allowed) {
      if (updates[field] !== undefined) {
        team[field] = updates[field];
      }
    }
    team.updatedAt = new Date().toISOString();
    teams[id] = team;
    this.saveAllTeams(teams);
    return team;
  }

  deleteTeam(id) {
    const teams = this.loadTeams();
    if (!teams[id]) return null;
    const deleted = teams[id];
    delete teams[id];
    this.saveAllTeams(teams);
    return deleted;
  }

  loadTeamInstances() {
    try {
      if (!fs.existsSync(this.instancesFile)) {
        return {};
      }
      const parsed = JSON.parse(fs.readFileSync(this.instancesFile, 'utf8'));
      return parsed.teamInstances || {};
    } catch (error) {
      console.error('Error loading team instances:', error.message);
      return {};
    }
  }

  saveAllTeamInstances(teamInstances) {
    fs.writeFileSync(this.instancesFile, JSON.stringify({ teamInstances }, null, 2), 'utf8');
  }

  listTeamInstances({ includeCompleted = false } = {}) {
    return Object.values(this.loadTeamInstances())
      .filter((instance) => includeCompleted || instance.status !== 'completed')
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  getTeamInstance(id) {
    const instances = this.loadTeamInstances();
    return instances[id] || null;
  }

  createTeamInstance(config = {}) {
    const instances = this.loadTeamInstances();
    const now = new Date().toISOString();
    const id = config.id || uuidv4();
    const instance = {
      id,
      templateId: config.templateId || null,
      name: config.name || 'Team Instance',
      goal: config.goal || '',
      strategy: config.strategy || 'hierarchical',
      orchestratorSessionId: config.orchestratorSessionId || null,
      sessionIds: Array.isArray(config.sessionIds) ? config.sessionIds : [],
      status: config.status || 'active',
      createdAt: now,
      updatedAt: now,
      completedAt: config.completedAt || null
    };
    instances[id] = instance;
    this.saveAllTeamInstances(instances);
    return instance;
  }

  updateTeamInstance(id, updates = {}) {
    const instances = this.loadTeamInstances();
    if (!instances[id]) return null;
    const instance = instances[id];
    const allowed = [
      'templateId', 'name', 'goal', 'strategy', 'orchestratorSessionId',
      'sessionIds', 'status', 'completedAt'
    ];
    for (const field of allowed) {
      if (updates[field] !== undefined) {
        instance[field] = updates[field];
      }
    }
    instance.updatedAt = new Date().toISOString();
    instances[id] = instance;
    this.saveAllTeamInstances(instances);
    return instance;
  }
}

module.exports = TeamStore;
module.exports.BUILT_IN_TEAMS = BUILT_IN_TEAMS;
