import { useState } from 'react';
import { AGENT_TEMPLATES } from '../utils/agentTemplates';
import DirectoryBrowser from './DirectoryBrowser';

function NewAgentModal({ onClose, onCreate }) {
  const [selectedTemplate, setSelectedTemplate] = useState('primary');
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [cliType, setCliType] = useState('claude');
  const [role, setRole] = useState('');
  const [skills, setSkills] = useState('');
  const [startupPrompt, setStartupPrompt] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');

  const handleTemplateSelect = (templateId) => {
    setSelectedTemplate(templateId);
    const template = AGENT_TEMPLATES.find(t => t.id === templateId);
    if (!template) return;

    if (templateId === 'custom') {
      setName('');
      setCliType('claude');
      setRole('');
      return;
    }

    setName(template.name);
    setCliType(template.cliType || 'claude');
    setRole(template.role || '');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    await onCreate?.({
      name: name.trim(),
      workingDir: workingDir || undefined,
      cliType,
      role,
      skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
      startupPrompt,
      notes: notes.trim(),
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean)
    });
    onClose?.();
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="new-agent-modal">
        <div className="new-agent-modal-header">
          <h2>New Agent</h2>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>

        {/* Template Selector */}
        <div className="new-agent-templates">
          <label className="new-agent-section-label">Template</label>
          <div className="new-agent-template-chips">
            {AGENT_TEMPLATES.map(template => (
              <button
                key={template.id}
                type="button"
                className={`new-agent-template-chip ${selectedTemplate === template.id ? 'active' : ''} ${template.cliType === 'codex' ? 'codex' : template.cliType === 'terminal' ? 'terminal' : template.cliType === 'wsl' ? 'wsl' : ''}`}
                onClick={() => handleTemplateSelect(template.id)}
              >
                <span className="new-agent-template-chip-name">{template.name}</span>
                {template.cliType !== 'claude' && (
                  <span className="new-agent-template-chip-type">{template.cliType}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="new-agent-form">
          {/* Identity Section */}
          <div className="new-agent-section">
            <label className="new-agent-section-label">Identity</label>
            <div className="new-agent-field">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name" autoFocus />
            </div>
            <div className="new-agent-field">
              <label>Working Directory</label>
              <DirectoryBrowser
                selectedPath={workingDir}
                onSelectPath={setWorkingDir}
                disabled={false}
              />
            </div>
            <div className="new-agent-field">
              <label>Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional notes about this agent..." />
            </div>
          </div>

          {/* Configuration Section */}
          <div className="new-agent-section">
            <label className="new-agent-section-label">Configuration</label>
            <div className="new-agent-field">
              <label>CLI Type</label>
              <div className="new-agent-cli-selector">
                {['claude', 'codex', 'terminal', 'wsl'].map(type => (
                  <button
                    key={type}
                    type="button"
                    className={`new-agent-cli-option ${cliType === type ? 'active' : ''}`}
                    onClick={() => setCliType(type)}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
            <div className="new-agent-field">
              <label>Role / System Prompt</label>
              <textarea value={role} onChange={(e) => setRole(e.target.value)} rows={3} placeholder="Define what this agent does, its constraints and specializations..." />
            </div>
          </div>

          {/* Advanced Section */}
          <div className="new-agent-section">
            <label className="new-agent-section-label">Advanced</label>
            <div className="new-agent-field-row">
              <div className="new-agent-field">
                <label>Skills</label>
                <input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="skill1, skill2, ..." />
              </div>
              <div className="new-agent-field">
                <label>Tags</label>
                <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag1, tag2, ..." />
              </div>
            </div>
            <div className="new-agent-field">
              <label>Startup Prompt</label>
              <textarea value={startupPrompt} onChange={(e) => setStartupPrompt(e.target.value)} rows={2} placeholder="Initial instruction sent when agent starts..." />
            </div>
          </div>

          <div className="new-agent-modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Create Agent</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default NewAgentModal;
