import { useState, useEffect, useCallback } from 'react';
import { formatKeyCombo } from '../hooks/useSettings';

function SettingsModal({ settings, onClose, onSave, onReset }) {
  const [activeTab, setActiveTab] = useState('keyboard');
  const [localSettings, setLocalSettings] = useState(settings);
  const [recordingKey, setRecordingKey] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Sync with external settings
  useEffect(() => {
    setLocalSettings(settings);
    setHasChanges(false);
  }, [settings]);

  const updateSetting = useCallback((category, key, value) => {
    setLocalSettings(prev => ({
      ...prev,
      [category]: {
        ...prev[category],
        [key]: value
      }
    }));
    setHasChanges(true);
  }, []);

  const handleSave = async () => {
    const success = await onSave(localSettings);
    if (success) {
      onClose();
    }
  };

  const handleReset = async () => {
    if (window.confirm('Reset all settings to defaults?')) {
      await onReset();
    }
  };

  // Handle key recording
  useEffect(() => {
    if (!recordingKey) return;

    const handleKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();

      // Ignore lone modifier keys
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        return;
      }

      const combo = formatKeyCombo(event);
      if (combo) {
        updateSetting('keyboard', recordingKey, combo);
        setRecordingKey(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingKey, updateSetting]);

  // Close on ESC key (but not when recording a shortcut)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !recordingKey) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, recordingKey]);

  const startRecording = (keyName) => {
    setRecordingKey(keyName);
  };

  const keyboardLabels = {
    copyKey: 'Copy',
    pasteKey: 'Paste',
    cancelKey: 'Cancel (SIGINT)',
    clearKey: 'Clear Screen'
  };

  const hintLabels = {
    newSession: 'New Session',
    settings: 'Settings',
    contextToggle: 'Context Toggle',
    sessionPrefix: 'Session Prefix'
  };

  // Hint mode settings with defaults
  const hintModeSettings = localSettings.keyboard?.hintMode || {
    enabled: true,
    triggerKey: '`',
    hints: {
      newSession: 'ns',
      settings: 'st',
      contextToggle: 'ct',
      sessionPrefix: 's'
    }
  };

  const updateHintSetting = useCallback((key, value) => {
    setLocalSettings(prev => ({
      ...prev,
      keyboard: {
        ...prev.keyboard,
        hintMode: {
          ...prev.keyboard?.hintMode,
          [key]: value
        }
      }
    }));
    setHasChanges(true);
  }, []);

  const updateHintCode = useCallback((hintKey, value) => {
    setLocalSettings(prev => ({
      ...prev,
      keyboard: {
        ...prev.keyboard,
        hintMode: {
          ...prev.keyboard?.hintMode,
          hints: {
            ...prev.keyboard?.hintMode?.hints,
            [hintKey]: value.toLowerCase()
          }
        }
      }
    }));
    setHasChanges(true);
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-tabs">
          <button
            className={`tab-btn ${activeTab === 'keyboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('keyboard')}
          >
            Keyboard
          </button>
          <button
            className={`tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => setActiveTab('terminal')}
          >
            Terminal
          </button>
          <button
            className={`tab-btn ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
        </div>

        <div className="modal-content">
          {activeTab === 'keyboard' && (
            <div className="settings-section">
              <p className="settings-description">
                Configure keyboard shortcuts for the terminal. Click "Record" and press a key combination.
              </p>
              <div className="keyboard-shortcuts-list">
                {Object.entries(localSettings.keyboard)
                  .filter(([key]) => key !== 'hintMode')
                  .map(([key, value]) => (
                  <div className="shortcut-row" key={key}>
                    <label className="shortcut-label">{keyboardLabels[key] || key}</label>
                    <div className="shortcut-input-group">
                      <input
                        type="text"
                        className={`shortcut-input ${recordingKey === key ? 'recording' : ''}`}
                        value={recordingKey === key ? 'Press key...' : value}
                        readOnly
                      />
                      <button
                        className={`btn btn-small ${recordingKey === key ? 'btn-danger' : 'btn-secondary'}`}
                        onClick={() => recordingKey === key ? setRecordingKey(null) : startRecording(key)}
                      >
                        {recordingKey === key ? 'Cancel' : 'Record'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-divider" />

              <h4 className="settings-subtitle">Hint Mode (Vimium-style)</h4>
              <p className="settings-description">
                Hold the trigger key to show hint badges on UI elements. Type the hint code to activate that element.
              </p>

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={hintModeSettings.enabled}
                    onChange={e => updateHintSetting('enabled', e.target.checked)}
                  />
                  Enable Hint Mode
                </label>
              </div>

              <div className="form-group">
                <label>Trigger Key</label>
                <select
                  value={hintModeSettings.triggerKey}
                  onChange={e => updateHintSetting('triggerKey', e.target.value)}
                  disabled={!hintModeSettings.enabled}
                >
                  <option value="`">` (Backtick)</option>
                  <option value="Ctrl+Alt">Ctrl+Alt</option>
                  <option value="Alt">Alt</option>
                  <option value="Ctrl">Ctrl</option>
                  <option value="Shift">Shift</option>
                </select>
              </div>

              <div className="hint-codes-section">
                <label className="section-label">Hint Codes</label>
                <div className="hint-codes-grid">
                  {Object.entries(hintModeSettings.hints || {}).map(([key, value]) => (
                    <div className="hint-code-row" key={key}>
                      <label className="hint-code-label">{hintLabels[key] || key}</label>
                      <input
                        type="text"
                        className="hint-code-input"
                        value={value}
                        onChange={e => updateHintCode(key, e.target.value)}
                        disabled={!hintModeSettings.enabled}
                        maxLength={4}
                        placeholder="..."
                      />
                    </div>
                  ))}
                </div>
                <p className="hint-help-text">
                  Sessions use prefix + number (e.g., s1, s2, s3...)
                </p>
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="settings-section">
              <div className="form-group">
                <label>Font Size</label>
                <input
                  type="number"
                  min="8"
                  max="32"
                  value={localSettings.terminal.fontSize}
                  onChange={e => updateSetting('terminal', 'fontSize', parseInt(e.target.value) || 14)}
                />
              </div>

              <div className="form-group">
                <label>Font Family</label>
                <select
                  value={localSettings.terminal.fontFamily}
                  onChange={e => updateSetting('terminal', 'fontFamily', e.target.value)}
                >
                  <option value="Consolas, Monaco, 'Courier New', monospace">Consolas</option>
                  <option value="'Fira Code', monospace">Fira Code</option>
                  <option value="'JetBrains Mono', monospace">JetBrains Mono</option>
                  <option value="'Source Code Pro', monospace">Source Code Pro</option>
                  <option value="monospace">System Monospace</option>
                </select>
              </div>

              <div className="form-group">
                <label>Cursor Style</label>
                <select
                  value={localSettings.terminal.cursorStyle}
                  onChange={e => updateSetting('terminal', 'cursorStyle', e.target.value)}
                >
                  <option value="block">Block</option>
                  <option value="underline">Underline</option>
                  <option value="bar">Bar</option>
                </select>
              </div>

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={localSettings.terminal.cursorBlink}
                    onChange={e => updateSetting('terminal', 'cursorBlink', e.target.checked)}
                  />
                  Cursor Blink
                </label>
              </div>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="settings-section">
              <div className="form-group">
                <label>Default Working Directory</label>
                <input
                  type="text"
                  placeholder="Leave empty for current directory"
                  value={localSettings.session.defaultWorkingDir}
                  onChange={e => updateSetting('session', 'defaultWorkingDir', e.target.value)}
                />
              </div>

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={localSettings.session.autoResumeOnStart}
                    onChange={e => updateSetting('session', 'autoResumeOnStart', e.target.checked)}
                  />
                  Auto-resume sessions on startup
                </label>
              </div>

              <div className="form-group">
                <label>Theme</label>
                <select
                  value={localSettings.ui.theme}
                  onChange={e => updateSetting('ui', 'theme', e.target.value)}
                >
                  <option value="dark">Dark</option>
                  <option value="light" disabled>Light (coming soon)</option>
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleReset}>
            Reset to Defaults
          </button>
          <div className="modal-footer-right">
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={!hasChanges}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
