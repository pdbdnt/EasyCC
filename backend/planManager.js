const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

/**
 * Manages Claude plan files from ~/.claude/plans directory
 */
class PlanManager extends EventEmitter {
  constructor(plansDir = null) {
    super();
    this.plansDir = plansDir || path.join(os.homedir(), '.claude', 'plans');
    this.watcher = null;
    this.planCache = new Map();
    this.watchCallbacks = [];
  }

  /**
   * Check if plans directory exists
   * @returns {boolean}
   */
  plansDirectoryExists() {
    return fs.existsSync(this.plansDir);
  }

  /**
   * List all plan files
   * @returns {Array} Array of plan info objects
   */
  listPlans() {
    try {
      if (!this.plansDirectoryExists()) {
        return [];
      }

      const files = fs.readdirSync(this.plansDir);
      const plans = [];

      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = path.join(this.plansDir, file);
          const stats = fs.statSync(filePath);

          plans.push({
            filename: file,
            name: file.replace('.md', '').replace(/-/g, ' '),
            path: filePath,
            createdAt: stats.birthtime.toISOString(),
            modifiedAt: stats.mtime.toISOString(),
            size: stats.size
          });
        }
      }

      // Sort by modified time (newest first)
      plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

      return plans;
    } catch (error) {
      console.error('Error listing plans:', error.message);
      return [];
    }
  }

  /**
   * Resolve a plan reference to a file path.
   * Accepts either a filename in the managed plans directory or a full file path.
   * @param {string} planRef - Filename or full path
   * @returns {object|null} Resolved metadata
   */
  resolvePlanReference(planRef) {
    if (typeof planRef !== 'string') {
      return null;
    }

    const trimmedRef = planRef.trim();
    if (!trimmedRef) {
      return null;
    }

    const baseName = trimmedRef.split(/[\\/]/).pop();
    const candidatePaths = [];

    if (path.isAbsolute(trimmedRef) || /[\\/]/.test(trimmedRef)) {
      candidatePaths.push(path.resolve(trimmedRef));
    }

    if (baseName) {
      candidatePaths.push(path.join(this.plansDir, baseName));
    }

    for (const candidate of candidatePaths) {
      if (!candidate || !candidate.toLowerCase().endsWith('.md')) {
        continue;
      }

      try {
        if (fs.existsSync(candidate)) {
          return { filePath: candidate, filename: path.basename(candidate) };
        }
      } catch (error) {
        console.warn(`resolvePlanReference: error checking ${candidate}:`, error.message);
      }
    }

    return null;
  }

  /**
   * Get content of a specific plan file
   * @param {string} planRef - Plan filename or path
   * @returns {object|null} Plan content and metadata
   */
  getPlanContent(planRef) {
    try {
      const resolved = this.resolvePlanReference(planRef);
      if (!resolved) {
        return null;
      }
      const { filePath, filename } = resolved;

      const content = fs.readFileSync(filePath, 'utf8');
      const stats = fs.statSync(filePath);

      // Try to extract working directory from plan content
      const workingDirMatch = content.match(/Working Directory[:\s]+([^\n]+)/i) ||
                              content.match(/Project[:\s]+([^\n]+)/i) ||
                              content.match(/Path[:\s]+([^\n]+)/i);
      let derivedWorkingDir = workingDirMatch ? workingDirMatch[1].trim() : null;

      // Fall back to deriving workingDir from "<workingDir>/plans/<plan>.md"
      if (!derivedWorkingDir) {
        const parentDir = path.dirname(filePath);
        const parentName = path.basename(parentDir);
        if (parentName === 'plans') {
          derivedWorkingDir = path.dirname(parentDir);
        }
      }

      return {
        filename,
        name: filename.replace('.md', '').replace(/-/g, ' '),
        path: filePath,
        content: content,
        workingDir: derivedWorkingDir,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString()
      };
    } catch (error) {
      console.error('Error reading plan:', error.message);
      return null;
    }
  }

  /**
   * Get the file path for a plan
   * @param {string} filename - Plan filename
   * @returns {string|null} Full file path or null if not found
   */
  getPlanPath(filename) {
    try {
      // Security: prevent directory traversal
      const safeFilename = path.basename(filename);
      const filePath = path.join(this.plansDir, safeFilename);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      return filePath;
    } catch (error) {
      console.error('Error getting plan path:', error.message);
      return null;
    }
  }

  /**
   * Find plans that match a working directory
   * @param {string} workingDir - Working directory path
   * @returns {Array} Matching plans
   */
  getPlansForWorkingDir(workingDir) {
    const plans = this.listPlans();
    const matches = [];

    // Normalize the working directory for comparison
    const normalizedDir = workingDir.toLowerCase().replace(/\\/g, '/');

    for (const plan of plans) {
      const content = this.getPlanContent(plan.filename);
      if (content) {
        // Check if the working dir appears in the plan content
        const contentLower = content.content.toLowerCase().replace(/\\/g, '/');
        if (contentLower.includes(normalizedDir)) {
          matches.push({
            ...plan,
            workingDir: content.workingDir
          });
        }
      }
    }

    return matches;
  }

  /**
   * Get plans created after a specific time (for matching with sessions)
   * @param {Date|string} afterTime - Time threshold
   * @returns {Array} Plans created after the specified time
   */
  getPlansCreatedAfter(afterTime) {
    const threshold = new Date(afterTime);
    const plans = this.listPlans();

    return plans.filter(plan => new Date(plan.createdAt) > threshold);
  }

  /**
   * Start watching for new plan files
   * @param {function} callback - Called when a new plan is detected
   */
  watchPlans(callback) {
    // Accumulate callbacks — multiple consumers can register without replacing the watcher
    if (callback) {
      this.watchCallbacks.push(callback);
    }

    // If watcher is already running, just register the callback — don't restart
    if (this.watcher) {
      return;
    }

    if (!this.plansDirectoryExists()) {
      console.log('Plans directory does not exist yet:', this.plansDir);
      // Try to watch parent directory for creation
      const parentDir = path.dirname(this.plansDir);
      if (fs.existsSync(parentDir)) {
        this.watchParentForPlansDir();
      }
      return;
    }

    this._startWatcher();
  }

  /**
   * Internal: start the fs.watch on the plans directory
   */
  _startWatcher() {
    try {
      // Cache existing files
      const existingPlans = this.listPlans();
      for (const plan of existingPlans) {
        this.planCache.set(plan.filename, plan.modifiedAt);
      }

      this.watcher = fs.watch(this.plansDir, { persistent: false }, (eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filePath = path.join(this.plansDir, filename);

          // Check if file exists (not deleted)
          if (fs.existsSync(filePath)) {
            const cachedTime = this.planCache.get(filename);
            const stats = fs.statSync(filePath);
            const modifiedAt = stats.mtime.toISOString();

            // Trigger for new files OR modified files (cache time changed)
            if (!cachedTime || cachedTime !== modifiedAt) {
              this.planCache.set(filename, modifiedAt);

              const plan = this.getPlanContent(filename);
              if (plan) {
                const isNew = !cachedTime;
                this.emit(isNew ? 'newPlan' : 'planUpdated', plan);
                // Notify all registered callbacks
                for (const cb of this.watchCallbacks) {
                  try {
                    cb(plan);
                  } catch (err) {
                    console.error('Plan watch callback error:', err.message);
                  }
                }
              }
            }
          } else if (eventType === 'rename') {
            // File was deleted (only on rename event)
            this.planCache.delete(filename);
            this.emit('planDeleted', filename);
          }
        }
      });

      this.watcher.on('error', (error) => {
        console.error('Plan watcher error:', error.message);
      });
    } catch (error) {
      console.error('Error starting plan watcher:', error.message);
    }
  }

  /**
   * Watch parent directory for plans dir creation
   */
  watchParentForPlansDir() {
    const parentDir = path.dirname(this.plansDir);

    try {
      const parentWatcher = fs.watch(parentDir, { persistent: false }, (eventType, filename) => {
        if (filename === 'plans' && fs.existsSync(this.plansDir)) {
          parentWatcher.close();
          this._startWatcher();
        }
      });
    } catch (error) {
      console.error('Error watching parent directory:', error.message);
    }
  }

  /**
   * Stop watching for plan files
   */
  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Get plans directory path
   * @returns {string}
   */
  getPlansDirectory() {
    return this.plansDir;
  }

  /**
   * Get plans tracked by a specific Claude session
   * Reads Claude's session transcript to find plan files that were edited during that session
   * @param {string} claudeSessionId - Claude's session ID
   * @param {string} workingDir - Session's working directory
   * @returns {Array} Plan file paths tracked by this session
   */
  getPlansForClaudeSession(claudeSessionId, workingDir) {
    if (!claudeSessionId || !workingDir) return [];

    // Convert working dir to Claude's project folder format (e.g., C:\Users\user\apps\foo -> C--Users-user-apps-foo)
    const projectId = workingDir.replace(/[:\\/]/g, '-').replace(/^-/, '');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectId);
    const transcriptPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) return [];

    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const planPaths = new Set();

      // Parse each line looking for trackedFileBackups entries
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.snapshot?.trackedFileBackups) {
            for (const filePath of Object.keys(entry.snapshot.trackedFileBackups)) {
              // Only include files from the plans directory
              if (filePath.includes('.claude') && filePath.includes('plans') && filePath.endsWith('.md')) {
                // Normalize path separators
                planPaths.add(filePath.replace(/\\\\/g, '\\'));
              }
            }
          }
        } catch (e) { /* skip invalid JSON lines */ }
      }

      return [...planPaths];
    } catch (error) {
      console.error('Error reading Claude session transcript:', error.message);
      return [];
    }
  }
}

module.exports = PlanManager;
