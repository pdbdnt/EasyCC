const fs = require('fs');
const path = require('path');

/**
 * Manages application settings persistence
 */
class SettingsManager {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  /**
   * Get default settings
   * @returns {object} Default settings object
   */
  getDefaults() {
    return {
      version: 2,
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
        startupRecoveryMode: 'ask',
        autoParking: {
          enabled: true,
          confirmBeforeParking: true,
          maxLiveAiSessions: 6,
          idleMinutes: 15,
          snoozeMinutes: 15
        }
      },
      general: {
        clearTerminalWhenSessionListEmpty: false
      },
      codexWindows: {
        enabled: false,
        hookTrustAcknowledged: false
      },
      projectAliases: {},
      contextWidgetLayout: {
        rows: [
          { widgets: ['notes', 'prompts'], ratio: 0.5, colRatios: [0.5, 0.5] },
          { widgets: ['plans'], ratio: 0.5, colRatios: [1] },
        ],
        hiddenWidgets: [],
      }
    };
  }

  /**
   * Load settings from disk, returning defaults if file doesn't exist
   * @returns {object} Settings object
   */
  loadSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const data = fs.readFileSync(this.settingsFile, 'utf8');
        const settings = JSON.parse(data);

        // Merge with defaults to ensure all keys exist
        return this.mergeWithDefaults(settings);
      }
    } catch (error) {
      console.error('Error loading settings:', error.message);
    }

    return this.getDefaults();
  }

  /**
   * Save settings to disk
   * @param {object} settings - Settings to save
   * @returns {boolean} Success status
   */
  saveSettings(settings) {
    try {
      // Merge with defaults to ensure structure is complete
      const mergedSettings = this.mergeWithDefaults(settings);

      fs.writeFileSync(
        this.settingsFile,
        JSON.stringify(mergedSettings, null, 2),
        'utf8'
      );

      return true;
    } catch (error) {
      console.error('Error saving settings:', error.message);
      return false;
    }
  }

  /**
   * Update specific settings (partial update)
   * @param {object} updates - Partial settings to update
   * @returns {object} Updated settings
   */
  updateSettings(updates) {
    const current = this.loadSettings();
    const updated = this.deepMerge(current, updates);
    const normalized = this.mergeWithDefaults(updated);
    this.saveSettings(normalized);
    return normalized;
  }

  /**
   * Reset settings to defaults
   * @returns {object} Default settings
   */
  resetSettings() {
    const defaults = this.getDefaults();
    this.saveSettings(defaults);
    return defaults;
  }

  /**
   * Deep merge settings with defaults
   * @param {object} settings - Current settings
   * @returns {object} Merged settings
   */
  mergeWithDefaults(settings) {
    const defaults = this.getDefaults();
    const source = settings || {};
    const sourceVersion = Number(source.version) || 1;
    const migrated = this.deepMerge({}, source);
    if (sourceVersion < 2 && migrated.terminal?.scrollback === 20000) {
      migrated.terminal.scrollback = 5000;
    }
    migrated.version = 2;
    const merged = this.deepMerge(defaults, migrated);
    const validModes = new Set(['ask', 'auto-resume', 'restore-paused']);
    if (!validModes.has(merged.session?.startupRecoveryMode)) {
      merged.session.startupRecoveryMode = 'ask';
    }
    if (merged.session) {
      delete merged.session.autoResumeOnStart;
      const parking = merged.session.autoParking || {};
      parking.enabled = parking.enabled !== false;
      parking.confirmBeforeParking = true;
      parking.maxLiveAiSessions = Math.max(1, Math.min(20, Number(parking.maxLiveAiSessions) || 6));
      parking.idleMinutes = Math.max(1, Math.min(120, Number(parking.idleMinutes) || 15));
      parking.snoozeMinutes = 15;
      merged.session.autoParking = parking;
    }
    return merged;
  }

  /**
   * Deep merge two objects
   * @param {object} target - Target object
   * @param {object} source - Source object
   * @returns {object} Merged object
   */
  deepMerge(target, source) {
    const output = { ...target };

    for (const key in source) {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (key in target && typeof target[key] === 'object' && !Array.isArray(target[key])) {
          output[key] = this.deepMerge(target[key], source[key]);
        } else {
          output[key] = { ...source[key] };
        }
      } else {
        output[key] = source[key];
      }
    }

    return output;
  }
}

module.exports = SettingsManager;
