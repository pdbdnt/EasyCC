import { useState, useEffect } from 'react';
import { AGENT_TEMPLATES } from '../utils/agentTemplates';
import DirectoryBrowser, { normalizeWindowsPath } from './DirectoryBrowser';

function generateDefaultSessionName() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  return `Session ${date}-${time}`;
}

function NewSessionModal({ onClose, onCreate, onLaunchTeam, defaultWorkingDir = '', sessions = [], defaultParentSessionId = null }) {
  const normalizedDefaultWorkingDir = normalizeWindowsPath(defaultWorkingDir);
  const [activeTab, setActiveTab] = useState('session');
  const [name, setName] = useState(() => generateDefaultSessionName());
  const [cliType, setCliType] = useState('claude');
  const [selectedTemplate, setSelectedTemplate] = useState('custom');
  const [role, setRole] = useState('');
  const [selectedPath, setSelectedPath] = useState(() => normalizedDefaultWorkingDir);
  const [loading, setLoading] = useState(false);

  // Team selector: 'none' | 'new' | '<teamInstanceId>'
  const [teamAction, setTeamAction] = useState('none');
  const [teamName, setTeamName] = useState('');
  const [activeTeams, setActiveTeams] = useState([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);

  // Teams tab state
  const [teams, setTeams] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamGoal, setTeamGoal] = useState('');

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

  // Fetch active team instances for the session tab team selector
  useEffect(() => {
    let cancelled = false;
    const loadActiveTeams = async () => {
      try {
        const res = await fetch('/api/team-instances');
        const data = await res.json();
        if (!cancelled) {
          setActiveTeams(data.teamInstances || []);
          setTeamsLoaded(true);
        }
      } catch (e) {
        if (!cancelled) setTeamsLoaded(true);
      }
    };
    loadActiveTeams();
    return () => { cancelled = true; };
  }, []);

  // Fetch team templates for the teams tab
  useEffect(() => {
    if (activeTab !== 'teams') return;
    let cancelled = false;

    const loadTeams = async () => {
      setTeamsLoading(true);
      setTeamsError('');
      try {
        const response = await fetch('/api/teams');
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load teams');
        }
        if (cancelled) return;
        const nextTeams = payload.teams || [];
        setTeams(nextTeams);
        setSelectedTeamId((prev) => prev || nextTeams[0]?.id || '');
      } catch (error) {
        if (!cancelled) {
          setTeamsError(error.message);
        }
      } finally {
        if (!cancelled) {
          setTeamsLoading(false);
        }
      }
    };

    loadTeams();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const workingDir = normalizeWindowsPath(selectedPath) || undefined;

    setLoading(true);
    try {
      const finalName = name.trim() || generateDefaultSessionName();
      await onCreate(finalName, workingDir, cliType, role, {
        teamAction,
        teamName: teamAction === 'new' ? (teamName.trim() || undefined) : undefined
      });
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleLaunchTeam = async () => {
    if (!selectedTeamId || !onLaunchTeam) return;
    const workingDir = normalizeWindowsPath(selectedPath) || undefined;
    setLoading(true);
    try {
      await onLaunchTeam(selectedTeamId, {
        workingDir,
        goal: teamGoal
      });
    } finally {
      setLoading(false);
    }
  };

  const selectedTeam = teams.find((team) => team.id === selectedTeamId) || null;

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal modal-wide">
        <h2>New Session</h2>
        <div className="modal-tabs">
          <button
            type="button"
            className={`tab-btn ${activeTab === 'session' ? 'active' : ''}`}
            onClick={() => setActiveTab('session')}
            disabled={loading}
          >
            Session
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'teams' ? 'active' : ''}`}
            onClick={() => setActiveTab('teams')}
            disabled={loading}
          >
            Teams
          </button>
        </div>

        {activeTab === 'session' ? (
          <form onSubmit={handleSubmit}>
            <div className="modal-form-grid">
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
                    rows={4}
                    placeholder="Optional. Define the role or system prompt for this session."
                    disabled={loading}
                    className="custom-path-input role-input role-input-compact"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="teamAction">Team</label>
                  <select
                    id="teamAction"
                    value={teamAction}
                    onChange={(e) => setTeamAction(e.target.value)}
                    disabled={loading}
                    className="cli-select"
                  >
                    <option value="none">None</option>
                    {activeTeams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.sessionIds?.length || 0} members)
                      </option>
                    ))}
                    <option value="new">+ New Team (orchestrator)</option>
                  </select>
                  {teamAction === 'new' && (
                    <input
                      type="text"
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      placeholder="Team name (auto-generated if empty)"
                      disabled={loading}
                      className="team-name-input"
                    />
                  )}
                </div>
              </div>

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

                <div className="form-row-inline">
                  <div className="form-group form-group-flex">
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
                        if (template.isOrchestrator) {
                          setTeamAction('new');
                        }
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

                  <div className="form-group form-group-flex">
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
        ) : (
          <div className="modal-form-grid">
            <div className="form-group-left">
              <div className="form-group">
                <label>Working Directory</label>
                <DirectoryBrowser
                  selectedPath={selectedPath}
                  onSelectPath={setSelectedPath}
                  defaultBase={normalizedDefaultWorkingDir || undefined}
                  disabled={loading}
                />
              </div>

              <div className="form-group">
                <label htmlFor="teamGoal">Goal</label>
                <textarea
                  id="teamGoal"
                  value={teamGoal}
                  onChange={(e) => setTeamGoal(e.target.value)}
                  rows={4}
                  placeholder="Describe what the team should accomplish."
                  disabled={loading}
                />
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
                  type="button"
                  className="btn btn-primary"
                  onClick={handleLaunchTeam}
                  disabled={loading || !selectedTeamId || !onLaunchTeam}
                >
                  {loading ? 'Launching...' : 'Launch Team'}
                </button>
              </div>
            </div>

            <div className="form-group-right">
              {teamsError && <div className="team-launch-error">{teamsError}</div>}
              {teamsLoading ? (
                <div className="team-launch-empty">Loading team templates...</div>
              ) : teams.length === 0 ? (
                <div className="team-launch-empty">No team templates available.</div>
              ) : (
                <div className="team-template-list">
                  {teams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      className={`team-template-card ${selectedTeamId === team.id ? 'active' : ''}`}
                      onClick={() => setSelectedTeamId(team.id)}
                      disabled={loading}
                    >
                      <div className="team-template-card__header">
                        <span>{team.name}</span>
                        <span className="team-template-card__strategy">{team.strategy}</span>
                      </div>
                      <div className="team-template-card__description">{team.description}</div>
                      <div className="team-template-card__members">
                        {(team.members || []).map((member) => (
                          <span key={`${team.id}-${member.role}`} className="team-template-card__member">
                            {member.role}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {selectedTeam && (
                <div className="team-template-detail">
                  <div className="team-template-detail__title">{selectedTeam.name}</div>
                  <div className="team-template-detail__meta">
                    {selectedTeam.strategy} · {(selectedTeam.members || []).length} members
                  </div>
                  <div className="team-template-detail__members">
                    {(selectedTeam.members || []).map((member) => (
                      <div key={`${selectedTeam.id}-detail-${member.role}`} className="team-template-detail__member">
                        <strong>{member.role}</strong> · {member.template}{member.isOrchestrator ? ' · orchestrator' : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default NewSessionModal;
