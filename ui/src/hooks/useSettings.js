import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

// Deep merge: defaults are filled in where saved settings are missing keys
function deepMerge(defaults, saved) {
  if (!saved) return defaults;
  const result = { ...defaults };
  for (const key of Object.keys(saved)) {
    if (
      saved[key] && typeof saved[key] === 'object' && !Array.isArray(saved[key]) &&
      defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])
    ) {
      result[key] = deepMerge(defaults[key], saved[key]);
    } else {
      result[key] = saved[key];
    }
  }
  return result;
}

// Default settings (should match backend)
const defaultSettings = {
  version: 1,
  keyboard: {
    copyKey: 'Ctrl+C',
    pasteKey: 'Ctrl+V',
    cancelKey: 'Ctrl+C',
    clearKey: 'Ctrl+L',
    navigation: {
      prevSession: 'Ctrl+E',
      nextSession: 'Ctrl+R',
      prevSessionGlobal: 'Ctrl+3',
      nextSessionGlobal: 'Ctrl+4',
      prevGroup: 'Alt+3',
      nextGroup: 'Alt+4'
    },
    hintMode: {
      enabled: true,
      triggerKey: '`',
      hints: {
        newSession: 'ns',
        settings: 'st',
        contextToggle: 'ct',
        sessionPrefix: 's'
      }
    }
  },
  terminal: {
    fontSize: 14,
    fontFamily: "Consolas, Monaco, 'Courier New', monospace",
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000
  },
  ui: {
    defaultView: 'list',
    theme: 'midnight',
    confirmBeforeLeave: true,
    showFlipAnimation: true,
    flipAnimationSpeed: 1,
    maxFlipAnimationCards: 60
  },
  session: {
    defaultWorkingDir: '',
    autoResumeOnStart: true
  },
  projectAliases: {}
};

export function useSettings() {
  const [settings, setSettings] = useState(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load settings on mount
  useEffect(() => {
    const controller = new AbortController();
    const loadSettings = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/settings`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          setSettings(deepMerge(defaultSettings, data.settings));
        } else {
          console.error('Failed to load settings');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Error loading settings:', err);
          setError(err.message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    loadSettings();
    return () => controller.abort();
  }, []);

  // Update settings
  const updateSettings = useCallback(async (updates) => {
    try {
      const response = await fetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (response.ok) {
        const data = await response.json();
        setSettings(data.settings);
        return true;
      } else {
        console.error('Failed to update settings');
        return false;
      }
    } catch (err) {
      console.error('Error updating settings:', err);
      setError(err.message);
      return false;
    }
  }, []);

  // Reset settings to defaults
  const resetSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/settings/reset`, {
        method: 'POST'
      });

      if (response.ok) {
        const data = await response.json();
        setSettings(data.settings);
        return true;
      } else {
        console.error('Failed to reset settings');
        return false;
      }
    } catch (err) {
      console.error('Error resetting settings:', err);
      setError(err.message);
      return false;
    }
  }, []);

  // Get default settings (for UI reset)
  const getDefaults = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/settings/defaults`);
      if (response.ok) {
        const data = await response.json();
        return data.settings;
      }
    } catch (err) {
      console.error('Error getting defaults:', err);
    }
    return defaultSettings;
  }, []);

  return {
    settings,
    loading,
    error,
    updateSettings,
    resetSettings,
    getDefaults
  };
}

/**
 * Format a keyboard event into a key combo string
 * @param {KeyboardEvent} event - Keyboard event
 * @returns {string} Key combo string like "Ctrl+Shift+C"
 */
export function formatKeyCombo(event) {
  const parts = [];

  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  // Get the key name
  let key = event.key;

  // Normalize some key names
  if (key === ' ') key = 'Space';
  if (key === 'Escape') key = 'Esc';
  if (key === 'ArrowUp') key = 'Up';
  if (key === 'ArrowDown') key = 'Down';
  if (key === 'ArrowLeft') key = 'Left';
  if (key === 'ArrowRight') key = 'Right';

  // Don't include modifier keys as the main key
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    // Uppercase single letter keys
    if (key.length === 1) {
      key = key.toUpperCase();
    }
    parts.push(key);
  }

  return parts.join('+');
}

/**
 * Check if a keyboard event matches a key combo string
 * @param {KeyboardEvent} event - Keyboard event
 * @param {string} keyCombo - Key combo string like "Ctrl+Shift+C"
 * @returns {boolean} True if matches
 */
export function matchKeyCombo(event, keyCombo) {
  const formatted = formatKeyCombo(event);
  return formatted.toLowerCase() === keyCombo.toLowerCase();
}
