const BASE = 'http://localhost:5010';

async function apiFetch(page, path, options = {}) {
  return page.evaluate(async ({ url, opts }) => {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    return res.json();
  }, { url: `${BASE}${path}`, opts: options });
}

async function createTestSession(page, { name, workingDir, cliType } = {}) {
  return apiFetch(page, '/api/sessions', {
    method: 'POST',
    body: {
      name: name || `Test-${Date.now()}`,
      workingDir: workingDir || 'C:\\Users\\testuser\\apps\\EasyCC',
      cliType: cliType || 'claude'
    }
  });
}

async function killTestSession(page, id) {
  return apiFetch(page, `/api/sessions/${id}`, { method: 'DELETE' });
}

async function pauseTestSession(page, id) {
  return apiFetch(page, `/api/sessions/${id}/pause`, { method: 'POST' });
}

async function getAllSessions(page) {
  return apiFetch(page, '/api/sessions');
}

async function getAllTasks(page) {
  return apiFetch(page, '/api/tasks');
}

async function createTask(page, { title, project, stage, description } = {}) {
  return apiFetch(page, '/api/tasks', {
    method: 'POST',
    body: {
      title: title || `Task-${Date.now()}`,
      project: project || 'C:\\Users\\testuser\\apps\\EasyCC',
      stage: stage || 'todo',
      description: description || ''
    }
  });
}

async function moveTask(page, taskId, stage) {
  return apiFetch(page, `/api/tasks/${taskId}/move`, {
    method: 'POST',
    body: { stage }
  });
}

async function patchTask(page, taskId, updates) {
  return apiFetch(page, `/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: updates
  });
}

async function deleteTask(page, taskId) {
  return apiFetch(page, `/api/tasks/${taskId}`, { method: 'DELETE' });
}

async function patchSession(page, id, updates) {
  return apiFetch(page, `/api/sessions/${id}`, {
    method: 'PATCH',
    body: updates
  });
}

async function getStages(page) {
  return apiFetch(page, '/api/stages');
}

async function getTask(page, taskId) {
  return apiFetch(page, `/api/tasks/${taskId}`);
}

async function getSettings(page) {
  return apiFetch(page, '/api/settings');
}

async function updateSettings(page, updates) {
  return apiFetch(page, '/api/settings', {
    method: 'PUT',
    body: updates
  });
}

module.exports = {
  createTestSession,
  killTestSession,
  pauseTestSession,
  getAllSessions,
  getAllTasks,
  createTask,
  moveTask,
  patchTask,
  deleteTask,
  patchSession,
  getStages,
  getTask,
  getSettings,
  updateSettings
};
