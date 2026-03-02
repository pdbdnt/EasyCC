import { useState, useEffect, useCallback } from 'react';
import { formatKeyCombo } from '../hooks/useSettings';

function SettingsModal({ settings, onClose, onSave, onReset }) {
  const [activeTab, setActiveTab] = useState('keyboard');
  const [localSettings, setLocalSettings] = useState(settings);
  const [recordingKey, setRecordingKey] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [hooksInstalled, setHooksInstalled] = useState(null);
  const [hooksLoading, setHooksLoading] = useState(false);

  // Sync with external settings
  useEffect(() => {
    setLocalSettings(settings);
    setHasChanges(false);
  }, [settings]);

  // Check hooks status on mount
  useEffect(() => {
    fetch('/api/settings/hooks-status')
      .then(r => r.json())
      .then(data => setHooksInstalled(data.installed))
      .catch(() => setHooksInstalled(false));
  }, []);

  const handleInstallHooks = async () => {
    setHooksLoading(true);
    try {
      const res = await fetch('/api/settings/install-hooks', { method: 'POST' });
      if (res.ok) setHooksInstalled(true);
    } catch { /* silent */ }
    setHooksLoading(false);
  };

  const handleUninstallHooks = async () => {
    setHooksLoading(true);
    try {
      const res = await fetch('/api/settings/uninstall-hooks', { method: 'POST' });
      if (res.ok) setHooksInstalled(false);
    } catch { /* silent */ }
    setHooksLoading(false);
  };

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
        const navKeys = [
          'prevSession',
          'nextSession',
          'prevSessionGlobal',
          'nextSessionGlobal',
          'prevGroup',
          'nextGroup'
        ];
        if (navKeys.includes(recordingKey)) {
          setLocalSettings(prev => ({
            ...prev,
            keyboard: {
              ...prev.keyboard,
              navigation: {
                ...prev.keyboard?.navigation,
                [recordingKey]: combo
              }
            }
          }));
          setHasChanges(true);
        } else {
          updateSetting('keyboard', recordingKey, combo);
        }
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

  const navigationLabels = {
    prevSession: 'Previous Session (in project)',
    nextSession: 'Next Session (in project)',
    prevSessionGlobal: 'Previous Session (all projects)',
    nextSessionGlobal: 'Next Session (all projects)',
    prevGroup: 'Previous Group',
    nextGroup: 'Next Group'
  };

  const navigationSettings = localSettings.keyboard?.navigation || {};

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
                  .filter(([key]) => key !== 'hintMode' && key !== 'navigation')
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

              <h4 className="settings-subtitle">Session Navigation</h4>
              <p className="settings-description">
                Shortcuts for switching between sessions and groups.
              </p>
              <div className="keyboard-shortcuts-list">
                {Object.entries(navigationSettings).map(([key, value]) => (
                  <div className="shortcut-row" key={key}>
                    <label className="shortcut-label">{navigationLabels[key] || key}</label>
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
                <label>Scrollback Lines</label>
                <input
                  type="number"
                  min="500"
                  max="20000"
                  value={localSettings.terminal.scrollback ?? 5000}
                  onChange={e => updateSetting('terminal', 'scrollback', Math.max(500, Math.min(20000, parseInt(e.target.value, 10) || 5000)))}
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

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={localSettings.ui?.confirmBeforeLeave ?? true}
                    onChange={e => updateSetting('ui', 'confirmBeforeLeave', e.target.checked)}
                  />
                  Confirm before closing or reloading this tab
                </label>
                <p className="settings-description">
                  Browser shows a native confirmation dialog. Custom text is not supported.
                </p>
              </div>

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={localSettings.ui?.showFlipAnimation ?? true}
                    onChange={e => updateSetting('ui', 'showFlipAnimation', e.target.checked)}
                  />
                  Animate cards on view switch (Ctrl+O)
                </label>
              </div>

              {(localSettings.ui?.showFlipAnimation ?? true) && (
                <div className="form-group">
                  <label>Animation Speed</label>
                  <select
                    value={localSettings.ui?.flipAnimationSpeed ?? 1}
                    onChange={e => updateSetting('ui', 'flipAnimationSpeed', parseFloat(e.target.value))}
                  >
                    <option value={0.1}>Super Slow (10x)</option>
                    <option value={0.25}>Very Slow (4x)</option>
                    <option value={0.5}>Slow (2x)</option>
                    <option value={1}>Normal</option>
                    <option value={2}>Fast (0.5x)</option>
                    <option value={4}>Very Fast (0.25x)</option>
                  </select>
                </div>
              )}

              {(localSettings.ui?.showFlipAnimation ?? true) && (
                <div className="form-group">
                  <label>Max Animated Cards</label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={localSettings.ui?.maxFlipAnimationCards ?? 60}
                    onChange={e => updateSetting('ui', 'maxFlipAnimationCards', Math.max(1, Math.min(200, parseInt(e.target.value) || 60)))}
                  />
                  <p className="settings-description">
                    Skip animation when card count exceeds this limit. Default: 60.
                  </p>
                </div>
              )}

              <div className="form-group">
                <label>Theme</label>
                <select
                  value={localSettings.ui.theme}
                  onChange={e => updateSetting('ui', 'theme', e.target.value)}
                >
                  <option value="midnight">Midnight</option>
                  <option value="parchment">Parchment</option>
                </select>
              </div>

              <div className="settings-divider" />

              <h4 className="settings-subtitle">Claude Code Integration</h4>
              <p className="settings-description">
                Install lifecycle hooks into Claude Code so kanban cards move instantly
                when Claude finishes responding (Stop) or you submit a prompt (UserPromptSubmit).
                Hooks are written to <code>~/.claude/settings.json</code> and run silently in the background.
              </p>
              <div className="hooks-status-row">
                <span className={`hooks-status-badge ${hooksInstalled ? 'installed' : 'not-installed'}`}>
                  {hooksInstalled === null ? 'Checking...' : hooksInstalled ? 'Hooks installed' : 'Not installed'}
                </span>
                {hooksInstalled ? (
                  <button
                    className="btn btn-small btn-secondary"
                    onClick={handleUninstallHooks}
                    disabled={hooksLoading}
                  >
                    {hooksLoading ? 'Removing...' : 'Uninstall Hooks'}
                  </button>
                ) : (
                  <button
                    className="btn btn-small btn-primary"
                    onClick={handleInstallHooks}
                    disabled={hooksLoading || hooksInstalled === null}
                  >
                    {hooksLoading ? 'Installing...' : 'Install Hooks'}
                  </button>
                )}
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
