import { useState, useEffect } from 'react';
import { AGENT_TEMPLATES } from '../utils/agentTemplates';
import DirectoryBrowser, { normalizeWindowsPath } from './DirectoryBrowser';

function generateDefaultSessionName() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  return `Session ${date}-${time}`;
}

function NewSessionModal({ onClose, onCreate, defaultWorkingDir = '' }) {
  const normalizedDefaultWorkingDir = normalizeWindowsPath(defaultWorkingDir);
  const [name, setName] = useState(() => generateDefaultSessionName());
  const [cliType, setCliType] = useState('claude');
  const [selectedTemplate, setSelectedTemplate] = useState('custom');
  const [role, setRole] = useState('');
  const [selectedPath, setSelectedPath] = useState(() => normalizedDefaultWorkingDir);
  const [loading, setLoading] = useState(false);

  // Close on ESC key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const workingDir = normalizeWindowsPath(selectedPath) || undefined;

    setLoading(true);
    try {
      const finalName = name.trim() || generateDefaultSessionName();
      await onCreate(finalName, workingDir, cliType, role);
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal modal-wide">
        <h2>New Session</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-form-grid">
            <div className="form-group-left">
              <div className="form-group">
                <label htmlFor="name">Session Name</label>
                <input
                  type="text"
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Auto-generated"
                  autoFocus
                  disabled={loading}
                />
              </div>

              <div className="form-group">
                <label htmlFor="template">Template</label>
                <select
                  id="template"
                  value={selectedTemplate}
                  onChange={(e) => {
                    const templateId = e.target.value;
                    setSelectedTemplate(templateId);
                    const template = AGENT_TEMPLATES.find((item) => item.id === templateId);
                    if (!template) return;
                    setCliType(template.cliType);
                    setRole(template.role || '');
                    if (templateId !== 'custom') {
                      setName(template.name);
                    }
                  }}
                  disabled={loading}
                  className="cli-select"
                >
                  {AGENT_TEMPLATES.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="cliType">CLI Type</label>
                <select
                  id="cliType"
                  value={cliType}
                  onChange={(e) => {
                    setCliType(e.target.value);
                    setSelectedTemplate('custom');
                  }}
                  disabled={loading}
                  className="cli-select"
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex (WSL)</option>
                  <option value="terminal">Terminal (PowerShell)</option>
                </select>
              </div>
            </div>

            <div className="form-group-right">
              <div className="form-group">
                <label htmlFor="role">Role / System Prompt</label>
                <textarea
                  id="role"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setSelectedTemplate('custom');
                  }}
                  rows={6}
                  placeholder="Optional. Define the role or system prompt for this session."
                  disabled={loading}
                  className="custom-path-input role-input"
                />
              </div>

              <div className="form-group">
                <label>Working Directory</label>
                <DirectoryBrowser
                  selectedPath={selectedPath}
                  onSelectPath={setSelectedPath}
                  defaultBase={normalizedDefaultWorkingDir || undefined}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? 'Creating...' : 'Create Session'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default NewSessionModal;
