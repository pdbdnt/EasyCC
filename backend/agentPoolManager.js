const EventEmitter = require('events');

/**
 * AgentPoolManager - Manages agent pools for task processing across stages
 *
 * Features:
 * - Maintains agent pools per stage (specialized, shared, or human-managed)
 * - Auto-spawns agents when tasks are waiting and pool has capacity
 * - Claims idle agents for queued tasks (respects blockedBy dependencies)
 * - Recycles or terminates agents after task completion
 * - Passes context between agents for stage transitions
 *
 * Pool Types:
 * - 'specialized': Dedicated agents for this stage only
 * - 'shared': Agents can work across multiple stages (generalist pool)
 * - 'human': No auto-processing, requires human approval
 * - 'none': No agents, tasks just queue
 */
class AgentPoolManager extends EventEmitter {
  constructor(sessionManager, taskManager) {
    super();
    this.sessionManager = sessionManager;
    this.taskManager = taskManager;

    // Agent pools: { stageId: { agents: Map(sessionId -> agentInfo), maxSize: number, poolType: string } }
    this.pools = new Map();

    // Shared agent pool (for 'shared' pool type stages)
    this.sharedPool = {
      agents: new Map(), // sessionId -> agentInfo
      maxSize: 5, // Total shared pool size
      poolType: 'shared'
    };

    // Task assignment tracking: taskId -> sessionId
    this.taskAssignments = new Map();

    // Agent status tracking: sessionId -> { stageId, taskId, status: 'idle' | 'working', lastUsed }
    this.agentStatus = new Map();

    this.initializePools();
    this.setupEventHandlers();
  }

  /**
   * Initialize pools based on stage configurations
   */
  initializePools() {
    const stages = this.taskManager.getStages();

    for (const stage of stages) {
      if (stage.agentPool > 0 && stage.poolType !== 'none' && stage.poolType !== 'human') {
        if (stage.poolType === 'specialized') {
          this.pools.set(stage.id, {
            agents: new Map(),
            maxSize: stage.agentPool,
            poolType: 'specialized',
            stageId: stage.id
          });
        }
        // 'shared' pool is already initialized above
      }
    }

    console.log(`[AgentPoolManager] Initialized pools for ${this.pools.size} specialized stages, shared pool max: ${this.sharedPool.maxSize}`);
  }

  /**
   * Setup event handlers for task and session events
   */
  setupEventHandlers() {
    // Listen for task updates that require agent assignment
    this.taskManager.on('taskMoved', ({ task }) => {
      this.tryAssignAgent(task);
    });

    this.taskManager.on('taskCreated', (task) => {
      this.tryAssignAgent(task);
    });

    this.taskManager.on('taskUpdated', (task) => {
      // Check if task was unblocked
      if (task.status === 'queued' && (!task.blockedBy || task.blockedBy.length === 0)) {
        this.tryAssignAgent(task);
      }
    });

    // Listen for session status changes
    this.sessionManager.on('statusChange', ({ sessionId, status }) => {
      const agentInfo = this.agentStatus.get(sessionId);
      if (agentInfo) {
        if (status === 'idle' || status === 'completed') {
          // Agent finished work
          this.handleAgentFinished(sessionId);
        }
      }
    });

    this.sessionManager.on('sessionEnded', ({ sessionId }) => {
      this.removeAgent(sessionId);
    });

    this.sessionManager.on('sessionKilled', ({ sessionId }) => {
      this.removeAgent(sessionId);
    });
  }

  /**
   * Try to assign an agent to a task
   * @param {object} task - The task to assign
   */
  async tryAssignAgent(task) {
    // Skip if task is not queued or is blocked
    if (task.status !== 'queued') {
      return;
    }

    if (task.blockedBy && task.blockedBy.length > 0) {
      console.log(`[AgentPoolManager] Task ${task.id} is blocked by ${task.blockedBy.length} task(s), skipping assignment`);
      return;
    }

    // Skip if task already has an agent
    if (task.assignedAgent) {
      return;
    }

    const stage = this.taskManager.getStages().find(s => s.id === task.stage);
    if (!stage) {
      console.error(`[AgentPoolManager] Stage not found: ${task.stage}`);
      return;
    }

    // Skip human or none stages
    if (stage.poolType === 'human' || stage.poolType === 'none') {
      return;
    }

    // Try to claim an idle agent
    const agent = this.claimIdleAgent(stage);

    if (agent) {
      await this.assignTaskToAgent(task, agent);
    } else {
      // No idle agent available, try to spawn one
      const spawned = await this.trySpawnAgent(stage);
      if (spawned) {
        // Agent spawned, it will auto-claim the task when ready
        console.log(`[AgentPoolManager] Spawned new agent for task ${task.id} in stage ${stage.id}`);
      } else {
        console.log(`[AgentPoolManager] No available agents for task ${task.id} in stage ${stage.id}, pool at capacity`);
      }
    }
  }

  /**
   * Claim an idle agent from a pool
   * @param {object} stage - The stage needing an agent
   * @returns {object|null} Agent info or null
   */
  claimIdleAgent(stage) {
    const pool = stage.poolType === 'shared' ? this.sharedPool : this.pools.get(stage.id);

    if (!pool) {
      return null;
    }

    // Find an idle agent
    for (const [sessionId, agentInfo] of pool.agents) {
      const status = this.agentStatus.get(sessionId);
      if (status && status.status === 'idle') {
        console.log(`[AgentPoolManager] Claimed idle agent ${sessionId} for stage ${stage.id}`);
        return { sessionId, agentInfo };
      }
    }

    return null;
  }

  /**
   * Try to spawn a new agent for a stage
   * @param {object} stage - The stage needing an agent
   * @returns {boolean} True if spawned successfully
   */
  async trySpawnAgent(stage) {
    const pool = stage.poolType === 'shared' ? this.sharedPool : this.pools.get(stage.id);

    if (!pool) {
      return false;
    }

    // Check if pool is at capacity
    if (pool.agents.size >= pool.maxSize) {
      return false;
    }

    // Spawn a new session for this agent
    try {
      const agentName = stage.poolType === 'shared'
        ? `shared-agent-${Date.now()}`
        : `${stage.id}-agent-${Date.now()}`;

      // Get a task from this stage to determine working directory
      const tasks = this.taskManager.getTasks({ stage: stage.id, status: 'queued' });
      const workingDir = tasks.length > 0 ? tasks[0].project : process.cwd();

      const session = this.sessionManager.createSession(agentName, workingDir, 'claude');

      if (session) {
        const agentInfo = {
          sessionId: session.id,
          stageId: stage.id,
          poolType: stage.poolType,
          createdAt: new Date().toISOString()
        };

        pool.agents.set(session.id, agentInfo);
        this.agentStatus.set(session.id, {
          stageId: stage.id,
          taskId: null,
          status: 'idle',
          lastUsed: Date.now()
        });

        this.emit('agentSpawned', { sessionId: session.id, stageId: stage.id, poolType: stage.poolType });
        console.log(`[AgentPoolManager] Spawned agent ${session.id} for stage ${stage.id} (${stage.poolType})`);
        return true;
      }
    } catch (error) {
      console.error(`[AgentPoolManager] Error spawning agent for stage ${stage.id}:`, error.message);
    }

    return false;
  }

  /**
   * Assign a task to an agent
   * @param {object} task - The task to assign
   * @param {object} agent - The agent to assign to
   */
  async assignTaskToAgent(task, agent) {
    try {
      // Update task assignment
      this.taskManager.assignAgent(task.id, agent.sessionId, agent.sessionId);

      // Update agent status
      const agentStatusInfo = this.agentStatus.get(agent.sessionId);
      if (agentStatusInfo) {
        agentStatusInfo.taskId = task.id;
        agentStatusInfo.status = 'working';
        agentStatusInfo.lastUsed = Date.now();
      }

      this.taskAssignments.set(task.id, agent.sessionId);

      this.emit('taskAssigned', { taskId: task.id, sessionId: agent.sessionId, stageId: task.stage });
      console.log(`[AgentPoolManager] Assigned task ${task.id} to agent ${agent.sessionId}`);

      // Send context/instructions to agent via terminal
      this.sendTaskInstructions(agent.sessionId, task);
    } catch (error) {
      console.error(`[AgentPoolManager] Error assigning task ${task.id} to agent ${agent.sessionId}:`, error.message);
    }
  }

  /**
   * Send task instructions to an agent's terminal
   * @param {string} sessionId - The agent session ID
   * @param {object} task - The task to work on
   */
  sendTaskInstructions(sessionId, task) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.pty) {
      console.error(`[AgentPoolManager] Cannot send instructions to agent ${sessionId}, session not found or no PTY`);
      return;
    }

    // Build task context message
    const instructions = `
# New Task Assignment
Task: ${task.title}
Stage: ${task.stage}
Priority: ${task.priority}

${task.description || 'No description provided.'}

${task.context && task.context.planFile ? `\nPlan file: ${task.context.planFile}` : ''}
${task.context && task.context.workingDir ? `\nWorking directory: ${task.context.workingDir}` : ''}

---
Please proceed with this task. Type /task-done when complete.
`.trim();

    // Send to terminal (this will appear in the agent's session)
    session.pty.write(`\r\n${instructions}\r\n\r\n`);
    console.log(`[AgentPoolManager] Sent task instructions to agent ${sessionId}`);
  }

  /**
   * Handle agent finishing work (status changed to idle/completed)
   * @param {string} sessionId - The agent session ID
   */
  async handleAgentFinished(sessionId) {
    const agentInfo = this.agentStatus.get(sessionId);
    if (!agentInfo || !agentInfo.taskId) {
      // Agent is idle but no task assigned
      return;
    }

    const taskId = agentInfo.taskId;
    const task = this.taskManager.getTask(taskId);

    if (!task) {
      console.error(`[AgentPoolManager] Task ${taskId} not found for agent ${sessionId}`);
      return;
    }

    console.log(`[AgentPoolManager] Agent ${sessionId} finished task ${taskId}`);

    // Mark agent as idle (CompletionDetector handles auto-advancement)
    agentInfo.taskId = null;
    agentInfo.status = 'idle';
    agentInfo.lastUsed = Date.now();

    this.taskAssignments.delete(taskId);
    this.emit('agentIdle', { sessionId, taskId });

    // Try to recycle or terminate agent
    this.recycleOrTerminateAgent(sessionId);

    // Try to assign next task from queue
    this.tryAssignNextTask(task.stage);
  }

  /**
   * Recycle or terminate an agent based on pool policy
   * @param {string} sessionId - The agent session ID
   */
  recycleOrTerminateAgent(sessionId) {
    const agentInfo = this.agentStatus.get(sessionId);
    if (!agentInfo) {
      return;
    }

    // For now, keep agents alive (recycle) - they can be reused
    // In future, implement termination logic based on:
    // - Idle time threshold
    // - Pool size optimization
    // - Task queue depth
    console.log(`[AgentPoolManager] Recycling agent ${sessionId} for reuse`);
  }

  /**
   * Try to assign the next queued task in a stage
   * @param {string} stageId - The stage ID
   */
  async tryAssignNextTask(stageId) {
    const tasks = this.taskManager.getAssignableTasks(stageId);
    if (tasks.length > 0) {
      const nextTask = tasks[0]; // Highest priority, unblocked task
      await this.tryAssignAgent(nextTask);
    }
  }

  /**
   * Remove an agent from all pools
   * @param {string} sessionId - The agent session ID
   */
  removeAgent(sessionId) {
    // Remove from agent status
    const agentInfo = this.agentStatus.get(sessionId);
    if (agentInfo) {
      // Unassign any task
      if (agentInfo.taskId) {
        try {
          this.taskManager.unassignAgent(agentInfo.taskId);
        } catch (err) {
          console.error(`[AgentPoolManager] Error unassigning task ${agentInfo.taskId}:`, err.message);
        }
        this.taskAssignments.delete(agentInfo.taskId);
      }

      this.agentStatus.delete(sessionId);
    }

    // Remove from pools
    for (const [stageId, pool] of this.pools) {
      if (pool.agents.has(sessionId)) {
        pool.agents.delete(sessionId);
        console.log(`[AgentPoolManager] Removed agent ${sessionId} from pool ${stageId}`);
      }
    }

    if (this.sharedPool.agents.has(sessionId)) {
      this.sharedPool.agents.delete(sessionId);
      console.log(`[AgentPoolManager] Removed agent ${sessionId} from shared pool`);
    }

    this.emit('agentRemoved', { sessionId });
  }

  /**
   * Get pool status for all stages
   * @returns {Array} Pool status for each stage
   */
  getPoolStatus() {
    const status = [];

    for (const [stageId, pool] of this.pools) {
      const idle = Array.from(pool.agents.keys()).filter(sessionId => {
        const info = this.agentStatus.get(sessionId);
        return info && info.status === 'idle';
      }).length;

      const working = Array.from(pool.agents.keys()).filter(sessionId => {
        const info = this.agentStatus.get(sessionId);
        return info && info.status === 'working';
      }).length;

      status.push({
        stageId,
        poolType: pool.poolType,
        maxSize: pool.maxSize,
        currentSize: pool.agents.size,
        idle,
        working
      });
    }

    // Add shared pool status
    const sharedIdle = Array.from(this.sharedPool.agents.keys()).filter(sessionId => {
      const info = this.agentStatus.get(sessionId);
      return info && info.status === 'idle';
    }).length;

    const sharedWorking = Array.from(this.sharedPool.agents.keys()).filter(sessionId => {
      const info = this.agentStatus.get(sessionId);
      return info && info.status === 'working';
    }).length;

    status.push({
      stageId: 'shared',
      poolType: 'shared',
      maxSize: this.sharedPool.maxSize,
      currentSize: this.sharedPool.agents.size,
      idle: sharedIdle,
      working: sharedWorking
    });

    return status;
  }

  /**
   * Get agent info for a session
   * @param {string} sessionId - The session ID
   * @returns {object|null} Agent info or null
   */
  getAgentInfo(sessionId) {
    return this.agentStatus.get(sessionId) || null;
  }

  /**
   * Update pool configuration (e.g., max size, pool type)
   * @param {string} stageId - The stage ID
   * @param {object} config - Pool configuration updates
   */
  updatePoolConfig(stageId, config) {
    const pool = this.pools.get(stageId);
    if (!pool) {
      console.error(`[AgentPoolManager] Pool not found for stage ${stageId}`);
      return;
    }

    if (config.maxSize !== undefined) {
      pool.maxSize = config.maxSize;
      console.log(`[AgentPoolManager] Updated pool ${stageId} max size to ${config.maxSize}`);
    }

    if (config.poolType !== undefined) {
      pool.poolType = config.poolType;
      console.log(`[AgentPoolManager] Updated pool ${stageId} type to ${config.poolType}`);
    }

    this.emit('poolConfigUpdated', { stageId, config });
  }
}

module.exports = AgentPoolManager;
