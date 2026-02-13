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
      version: 1,
      keyboard: {
        copyKey: 'Ctrl+C',
        pasteKey: 'Ctrl+V',
        cancelKey: 'Ctrl+C',
        clearKey: 'Ctrl+L',
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
        scrollback: 2000
      },
      ui: {
        defaultView: 'list',
        theme: 'dark',
        confirmBeforeLeave: true
      },
      session: {
        defaultWorkingDir: '',
        autoResumeOnStart: true
      },
      projectAliases: {}

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
    this.saveSettings(updated);
    return updated;
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
    return this.deepMerge(defaults, settings);
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
