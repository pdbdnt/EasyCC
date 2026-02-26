/**
 * Plan Version Store
 *
 * Stores snapshots of plan files when sessions transition to idle state.
 * This batches rapid edits into single versions per work session.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PlanVersionStore {
  constructor(dataDir = path.join(__dirname, '..', 'data', 'plan-versions')) {
    this.dataDir = dataDir;
    this.dirtyPlans = new Map(); // planPath -> { content, lastModified }
    this.ensureDataDir();
  }

  /**
   * Ensure the data directory exists
   */
  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Generate a unique ID for a plan file path
   */
  getPlanId(planPath) {
    // Create a short hash of the path for the directory name
    return crypto.createHash('md5').update(planPath).digest('hex').slice(0, 12);
  }

  /**
   * Get the directory for a plan's versions
   */
  getPlanDir(planPath) {
    const planId = this.getPlanId(planPath);
    const planDir = path.join(this.dataDir, planId);
    if (!fs.existsSync(planDir)) {
      fs.mkdirSync(planDir, { recursive: true });
    }
    return planDir;
  }

  /**
   * Mark a plan as dirty (changed since last version)
   * Called when plan file changes are detected
   */
  markDirty(planPath, content) {
    this.dirtyPlans.set(planPath, {
      content,
      lastModified: new Date().toISOString()
    });
  }

  /**
   * Check if a plan has unsaved changes
   */
  isDirty(planPath) {
    return this.dirtyPlans.has(planPath);
  }

  /**
   * Create a version snapshot for a plan
   * Called when session transitions to idle
   */
  createVersion(planPath) {
    const dirty = this.dirtyPlans.get(planPath);
    if (!dirty) {
      return null; // No changes to save
    }

    const planDir = this.getPlanDir(planPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const versionFile = path.join(planDir, `${timestamp}.md`);

    // Save the version
    fs.writeFileSync(versionFile, dirty.content, 'utf8');

    // Save metadata
    const metaFile = path.join(planDir, `${timestamp}.meta.json`);
    fs.writeFileSync(metaFile, JSON.stringify({
      planPath,
      timestamp: dirty.lastModified,
      savedAt: new Date().toISOString(),
      contentHash: crypto.createHash('md5').update(dirty.content.trim()).digest('hex')
    }, null, 2), 'utf8');

    // Clear dirty flag
    this.dirtyPlans.delete(planPath);

    console.log(`[PlanVersionStore] Created version for ${planPath}: ${timestamp}`);

    return {
      timestamp,
      versionFile,
      planPath
    };
  }

  /**
   * Create versions for all dirty plans
   * Called when any session goes idle
   */
  flushDirtyPlans() {
    const versions = [];
    for (const planPath of this.dirtyPlans.keys()) {
      const version = this.createVersion(planPath);
      if (version) {
        versions.push(version);
      }
    }
    return versions;
  }

  /**
   * Get all versions for a plan
   */
  getVersions(planPath) {
    const planDir = this.getPlanDir(planPath);

    if (!fs.existsSync(planDir)) {
      return [];
    }

    const files = fs.readdirSync(planDir);
    const versions = [];

    for (const file of files) {
      if (file.endsWith('.md') && !file.endsWith('.meta.json')) {
        const metaFile = file.replace('.md', '.meta.json');
        const metaPath = path.join(planDir, metaFile);

        let meta = {};
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch (e) {
            // Ignore meta errors
          }
        }

        versions.push({
          filename: file,
          timestamp: meta.timestamp || file.replace('.md', ''),
          savedAt: meta.savedAt,
          contentHash: meta.contentHash
        });
      }
    }

    // Sort by timestamp (newest first)
    versions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return versions;
  }

  /**
   * Get content of a specific version
   */
  getVersionContent(planPath, versionFilename) {
    const planDir = this.getPlanDir(planPath);
    const versionPath = path.join(planDir, versionFilename);

    if (!fs.existsSync(versionPath)) {
      return null;
    }

    return fs.readFileSync(versionPath, 'utf8');
  }

  /**
   * Get the version count for a plan
   */
  getVersionCount(planPath) {
    return this.getVersions(planPath).length;
  }

  /**
   * Delete old versions beyond a limit
   */
  pruneVersions(planPath, keepCount = 50) {
    const versions = this.getVersions(planPath);
    if (versions.length <= keepCount) {
      return 0;
    }

    const planDir = this.getPlanDir(planPath);
    const toDelete = versions.slice(keepCount);
    let deleted = 0;

    for (const version of toDelete) {
      try {
        const versionPath = path.join(planDir, version.filename);
        const metaPath = path.join(planDir, version.filename.replace('.md', '.meta.json'));

        if (fs.existsSync(versionPath)) {
          fs.unlinkSync(versionPath);
          deleted++;
        }
        if (fs.existsSync(metaPath)) {
          fs.unlinkSync(metaPath);
        }
      } catch (e) {
        console.error(`[PlanVersionStore] Error deleting version: ${e.message}`);
      }
    }

    return deleted;
  }

  /**
   * Compute diff between two versions (simple line-based diff)
   */
  diffVersions(content1, content2) {
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');

    const diff = [];
    let i = 0, j = 0;

    while (i < lines1.length || j < lines2.length) {
      if (i >= lines1.length) {
        // Rest of lines2 are additions
        diff.push({ type: 'add', line: lines2[j], lineNumber: j + 1 });
        j++;
      } else if (j >= lines2.length) {
        // Rest of lines1 are deletions
        diff.push({ type: 'delete', line: lines1[i], lineNumber: i + 1 });
        i++;
      } else if (lines1[i] === lines2[j]) {
        // Same line
        diff.push({ type: 'same', line: lines1[i], lineNumber: i + 1 });
        i++;
        j++;
      } else {
        // Different - mark as delete from old, add from new
        diff.push({ type: 'delete', line: lines1[i], lineNumber: i + 1 });
        diff.push({ type: 'add', line: lines2[j], lineNumber: j + 1 });
        i++;
        j++;
      }
    }

    return diff;
  }
}

module.exports = PlanVersionStore;
