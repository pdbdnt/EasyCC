/**
 * Stage Configuration for Kanban Agent Orchestration
 *
 * Defines the workflow stages and agent pool settings
 */

// Pool types determine how agents are assigned to stages
const POOL_TYPES = {
  NONE: 'none',           // No agents, just a queue (backlog, done)
  SPECIALIZED: 'specialized', // Dedicated agents for this stage only
  SHARED: 'shared',       // Agents can work multiple stages
  HUMAN: 'human'          // Requires human action, no auto-processing
};

// Default stage definitions
const DEFAULT_STAGES = [
  {
    id: 'todo',
    name: 'To Do',
    agentPool: 0,
    poolType: POOL_TYPES.NONE,
    description: 'Tasks/sessions queued up, not yet started',
    order: 0,
    color: '#6b7280' // gray
  },
  {
    id: 'in_progress',
    name: 'In Progress',
    agentPool: 0,
    poolType: POOL_TYPES.NONE,
    description: 'Agent actively working',
    order: 1,
    color: '#3b82f6' // blue
  },
  {
    id: 'in_review',
    name: 'In Review',
    agentPool: 0,
    poolType: POOL_TYPES.NONE,
    description: 'Agent finished, awaiting human review',
    order: 2,
    color: '#f59e0b' // amber
  },
  {
    id: 'testing',
    name: 'Testing',
    agentPool: 0,
    poolType: POOL_TYPES.NONE,
    description: 'Manual testing stage (never auto-mapped)',
    order: 3,
    color: '#8b5cf6' // purple
  },
  {
    id: 'done',
    name: 'Done',
    agentPool: 0,
    poolType: POOL_TYPES.NONE,
    description: 'Completed tasks',
    order: 4,
    color: '#22c55e' // green
  }
];

// Task status values
const TASK_STATUS = {
  QUEUED: 'queued',       // Waiting for agent assignment
  IN_PROGRESS: 'in_progress', // Agent actively working
  BLOCKED: 'blocked',     // Waiting on dependencies or error
  DONE: 'done'            // Completed this stage
};

// Completion signal types that trigger stage transitions
const COMPLETION_SIGNALS = {
  PLAN_APPROVED: 'plan_approved',
  CODE_COMPLETE: 'code_complete',
  TESTS_PASS: 'tests_pass',
  HUMAN_APPROVED: 'human_approved'
};

/**
 * Validates a stage configuration object
 * @param {Object} stage - Stage to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateStage(stage) {
  const errors = [];

  if (!stage.id || typeof stage.id !== 'string') {
    errors.push('Stage must have a string id');
  }

  if (!stage.name || typeof stage.name !== 'string') {
    errors.push('Stage must have a string name');
  }

  if (typeof stage.agentPool !== 'number' || stage.agentPool < 0) {
    errors.push('Stage agentPool must be a non-negative number');
  }

  if (!Object.values(POOL_TYPES).includes(stage.poolType)) {
    errors.push(`Stage poolType must be one of: ${Object.values(POOL_TYPES).join(', ')}`);
  }

  if (typeof stage.order !== 'number') {
    errors.push('Stage must have a numeric order');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates an array of stages
 * @param {Array} stages - Stages to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateStages(stages) {
  if (!Array.isArray(stages)) {
    return { valid: false, errors: ['Stages must be an array'] };
  }

  const allErrors = [];
  const ids = new Set();

  stages.forEach((stage, index) => {
    const { valid, errors } = validateStage(stage);
    if (!valid) {
      allErrors.push(...errors.map(e => `Stage ${index}: ${e}`));
    }

    if (ids.has(stage.id)) {
      allErrors.push(`Duplicate stage id: ${stage.id}`);
    }
    ids.add(stage.id);
  });

  return {
    valid: allErrors.length === 0,
    errors: allErrors
  };
}

/**
 * Gets the next stage in the workflow
 * @param {Array} stages - All stages
 * @param {string} currentStageId - Current stage id
 * @returns {Object|null} - Next stage or null if at end
 */
function getNextStage(stages, currentStageId) {
  const current = stages.find(s => s.id === currentStageId);
  if (!current) return null;

  // Use explicit nextStage if defined
  if (current.nextStage) {
    return stages.find(s => s.id === current.nextStage) || null;
  }

  // Otherwise use order
  const sorted = [...stages].sort((a, b) => a.order - b.order);
  const currentIndex = sorted.findIndex(s => s.id === currentStageId);

  if (currentIndex === -1 || currentIndex === sorted.length - 1) {
    return null;
  }

  return sorted[currentIndex + 1];
}

/**
 * Gets the previous stage in the workflow
 * @param {Array} stages - All stages
 * @param {string} currentStageId - Current stage id
 * @returns {Object|null} - Previous stage or null if at start
 */
function getPreviousStage(stages, currentStageId) {
  const sorted = [...stages].sort((a, b) => a.order - b.order);
  const currentIndex = sorted.findIndex(s => s.id === currentStageId);

  if (currentIndex <= 0) {
    return null;
  }

  return sorted[currentIndex - 1];
}

/**
 * Checks if a stage requires human intervention
 * @param {Object} stage - Stage to check
 * @returns {boolean}
 */
function isHumanStage(stage) {
  return stage.poolType === POOL_TYPES.HUMAN;
}

/**
 * Checks if a stage has an agent pool
 * @param {Object} stage - Stage to check
 * @returns {boolean}
 */
function hasAgentPool(stage) {
  return stage.agentPool > 0 && stage.poolType !== POOL_TYPES.NONE && stage.poolType !== POOL_TYPES.HUMAN;
}

/**
 * Maps session status to kanban stage ID.
 * 'testing' is manual-only and never auto-mapped.
 * @param {string} sessionStatus - Session status string
 * @returns {string|null} Stage ID or null if no mapping
 */
function sessionStatusToStage(sessionStatus) {
  switch (sessionStatus) {
    case 'created':
    case 'paused':
      return 'todo';
    case 'active':
    case 'thinking':
    case 'editing':
      return 'in_progress';
    case 'waiting':
      return 'in_review';
    case 'idle':
      return null; // Idle is ambiguous — don't auto-move
    case 'completed':
      return 'done';
    default:
      return null;
  }
}

module.exports = {
  POOL_TYPES,
  DEFAULT_STAGES,
  TASK_STATUS,
  COMPLETION_SIGNALS,
  validateStage,
  validateStages,
  getNextStage,
  getPreviousStage,
  isHumanStage,
  hasAgentPool,
  sessionStatusToStage
};
