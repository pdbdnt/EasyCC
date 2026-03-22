const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const VALID_CLI_TYPES = ['claude', 'codex', 'terminal'];
const MAX_SESSIONS_PER_PRESET = 20;

class PresetStore {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'presets.json');
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
      return parsed.presets || {};
    } catch (error) {
      console.error('Error loading presets:', error.message);
      return {};
    }
  }

  saveAll(presets) {
    fs.writeFileSync(this.filePath, JSON.stringify({ presets }, null, 2), 'utf8');
  }

  list() {
    return Object.values(this.load())
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  }

  get(id) {
    return this.load()[id] || null;
  }

  validateSessions(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return 'sessions must be a non-empty array';
    }
    if (sessions.length > MAX_SESSIONS_PER_PRESET) {
      return `sessions cannot exceed ${MAX_SESSIONS_PER_PRESET} entries`;
    }
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (!s.workingDir || typeof s.workingDir !== 'string') {
        return `session ${i}: workingDir is required`;
      }
      if (s.cliType && !VALID_CLI_TYPES.includes(s.cliType)) {
        return `session ${i}: cliType must be one of ${VALID_CLI_TYPES.join(', ')}`;
      }
    }
    return null;
  }

  create(config = {}) {
    if (!config.name || typeof config.name !== 'string' || !config.name.trim()) {
      throw new Error('name is required');
    }
    const sessionsError = this.validateSessions(config.sessions);
    if (sessionsError) {
      throw new Error(sessionsError);
    }

    const presets = this.load();
    const now = new Date().toISOString();
    const id = uuidv4();
    const preset = {
      id,
      name: config.name.trim(),
      description: typeof config.description === 'string' ? config.description : '',
      createdAt: now,
      updatedAt: now,
      sessions: config.sessions.map(s => ({
        name: typeof s.name === 'string' ? s.name : '',
        workingDir: s.workingDir,
        cliType: VALID_CLI_TYPES.includes(s.cliType) ? s.cliType : 'claude',
        role: typeof s.role === 'string' ? s.role : '',
        initialPrompt: typeof s.initialPrompt === 'string' ? s.initialPrompt : ''
      }))
    };
    presets[id] = preset;
    this.saveAll(presets);
    return preset;
  }

  update(id, updates = {}) {
    const presets = this.load();
    if (!presets[id]) return null;
    const preset = presets[id];

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || !updates.name.trim()) {
        throw new Error('name cannot be empty');
      }
      preset.name = updates.name.trim();
    }
    if (updates.description !== undefined) {
      preset.description = typeof updates.description === 'string' ? updates.description : '';
    }
    if (updates.sessions !== undefined) {
      const sessionsError = this.validateSessions(updates.sessions);
      if (sessionsError) {
        throw new Error(sessionsError);
      }
      preset.sessions = updates.sessions.map(s => ({
        name: typeof s.name === 'string' ? s.name : '',
        workingDir: s.workingDir,
        cliType: VALID_CLI_TYPES.includes(s.cliType) ? s.cliType : 'claude',
        role: typeof s.role === 'string' ? s.role : '',
        initialPrompt: typeof s.initialPrompt === 'string' ? s.initialPrompt : ''
      }));
    }

    preset.updatedAt = new Date().toISOString();
    presets[id] = preset;
    this.saveAll(presets);
    return preset;
  }

  delete(id) {
    const presets = this.load();
    if (!presets[id]) return null;
    const deleted = presets[id];
    delete presets[id];
    this.saveAll(presets);
    return deleted;
  }
}

module.exports = PresetStore;
