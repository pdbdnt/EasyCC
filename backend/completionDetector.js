const EventEmitter = require('events');

/**
 * CompletionDetector - Monitors terminal output for task completion signals
 *
 * Features:
 * - Watches agent session terminal output for stage completion patterns
 * - Emits completion events when signals are detected
 * - Configurable detection patterns per stage
 * - Supports multiple signal types (regex, keywords, commands)
 */
class CompletionDetector extends EventEmitter {
  constructor(sessionManager, taskManager, agentPoolManager) {
    super();
    this.sessionManager = sessionManager;
    this.taskManager = taskManager;
    this.agentPoolManager = agentPoolManager;

    // Completion signal patterns per stage
    this.signalPatterns = {
      planning: [
        { type: 'regex', pattern: /plan.*approved/i, description: 'Plan approved' },
        { type: 'regex', pattern: /exit.*plan.*mode/i, description: 'Exited plan mode' },
        { type: 'command', pattern: '/plan-done', description: 'Plan done command' }
      ],
      coding: [
        { type: 'regex', pattern: /build.*success/i, description: 'Build successful' },
        { type: 'regex', pattern: /no.*error/i, description: 'No errors found' },
        { type: 'regex', pattern: /compilation.*complete/i, description: 'Compilation complete' },
        { type: 'command', pattern: '/code-done', description: 'Code done command' }
      ],
      testing: [
        { type: 'regex', pattern: /all.*tests.*passed/i, description: 'All tests passed' },
        { type: 'regex', pattern: /test.*suite.*passed/i, description: 'Test suite passed' },
        { type: 'regex', pattern: /\d+\s+passed.*0\s+failed/i, description: 'Tests passed' },
        { type: 'command', pattern: '/test-done', description: 'Test done command' }
      ],
      review: [
        // Review stage requires human approval via UI, not terminal output
        { type: 'command', pattern: '/review-approved', description: 'Review approved command' }
      ]
    };

    // Track recent output per session to avoid duplicate detections
    this.recentDetections = new Map(); // sessionId -> { timestamp, signal }

    this.setupOutputMonitoring();
  }

  /**
   * Setup monitoring of terminal output from all sessions
   */
  setupOutputMonitoring() {
    this.sessionManager.on('output', ({ sessionId, data }) => {
      this.checkForCompletionSignal(sessionId, data);
    });
  }

  /**
   * Check terminal output for completion signals
   * @param {string} sessionId - The session ID
   * @param {string} data - Terminal output data
   */
  checkForCompletionSignal(sessionId, data) {
    // Get agent info to determine current task and stage
    const agentInfo = this.agentPoolManager.getAgentInfo(sessionId);
    if (!agentInfo || !agentInfo.taskId) {
      return; // Agent is not working on a task
    }

    const task = this.taskManager.getTask(agentInfo.taskId);
    if (!task) {
      return;
    }

    const stage = this.taskManager.getStages().find(s => s.id === task.stage);
    if (!stage || !stage.completionSignal) {
      return; // Stage doesn't have auto-completion enabled
    }

    // Get patterns for this stage
    const patterns = this.signalPatterns[stage.id] || [];

    // Check each pattern
    for (const pattern of patterns) {
      let matched = false;

      if (pattern.type === 'regex' && pattern.pattern.test(data)) {
        matched = true;
      } else if (pattern.type === 'command' && data.includes(pattern.pattern)) {
        matched = true;
      }

      if (matched) {
        // Check for duplicate detection (within last 5 seconds)
        const recent = this.recentDetections.get(sessionId);
        if (recent && Date.now() - recent.timestamp < 5000) {
          return; // Skip duplicate
        }

        this.recentDetections.set(sessionId, {
          timestamp: Date.now(),
          signal: pattern.description
        });

        console.log(`[CompletionDetector] Detected completion signal for task ${task.id} (stage: ${stage.id}): ${pattern.description}`);

        this.emit('completionDetected', {
          sessionId,
          taskId: task.id,
          stageId: stage.id,
          signal: pattern.description,
          data
        });

        break; // Only emit once per output
      }
    }
  }

  /**
   * Add a custom completion pattern for a stage
   * @param {string} stageId - The stage ID
   * @param {object} pattern - The pattern to add
   */
  addPattern(stageId, pattern) {
    if (!this.signalPatterns[stageId]) {
      this.signalPatterns[stageId] = [];
    }

    // Convert string patterns to RegExp
    if (pattern.type === 'regex' && typeof pattern.pattern === 'string') {
      pattern.pattern = new RegExp(pattern.pattern, 'i');
    }

    this.signalPatterns[stageId].push(pattern);
    console.log(`[CompletionDetector] Added pattern for stage ${stageId}: ${pattern.description}`);
  }

  /**
   * Remove all patterns for a stage
   * @param {string} stageId - The stage ID
   */
  clearPatterns(stageId) {
    if (this.signalPatterns[stageId]) {
      this.signalPatterns[stageId] = [];
      console.log(`[CompletionDetector] Cleared patterns for stage ${stageId}`);
    }
  }

  /**
   * Get patterns for a stage
   * @param {string} stageId - The stage ID
   * @returns {Array} Patterns for the stage
   */
  getPatterns(stageId) {
    return this.signalPatterns[stageId] || [];
  }

  /**
   * Set patterns for a stage (replaces existing)
   * @param {string} stageId - The stage ID
   * @param {Array} patterns - The patterns to set
   */
  setPatterns(stageId, patterns) {
    // Convert string patterns to RegExp
    this.signalPatterns[stageId] = patterns.map(p => {
      if (p.type === 'regex' && typeof p.pattern === 'string') {
        return { ...p, pattern: new RegExp(p.pattern, 'i') };
      }
      return p;
    });
    console.log(`[CompletionDetector] Set ${patterns.length} patterns for stage ${stageId}`);
  }
}

module.exports = CompletionDetector;
