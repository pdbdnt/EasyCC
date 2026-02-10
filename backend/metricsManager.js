/**
 * MetricsManager - Calculate and track task/workflow metrics
 *
 * Features:
 * - Cycle time (time from backlog to done)
 * - Lead time (time from creation to completion)
 * - Throughput (tasks completed per time period)
 * - Stage duration (time spent in each stage)
 * - WIP (work in progress) limits
 * - Bottleneck detection
 */
class MetricsManager {
  constructor(taskManager, dataStore) {
    this.taskManager = taskManager;
    this.dataStore = dataStore;
  }

  /**
   * Calculate cycle time for a task (backlog → done)
   * @param {object} task - The task
   * @returns {number|null} Cycle time in milliseconds or null
   */
  calculateCycleTime(task) {
    if (!task.createdAt || task.stage !== 'done') {
      return null;
    }

    const start = new Date(task.createdAt).getTime();
    const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();

    return end - start;
  }

  /**
   * Calculate average cycle time for completed tasks
   * @param {object} options - Filter options (project, dateRange, etc.)
   * @returns {number} Average cycle time in milliseconds
   */
  getAverageCycleTime(options = {}) {
    const tasks = this.taskManager.getTasks({ stage: 'done', ...options });

    if (tasks.length === 0) {
      return 0;
    }

    const cycleTimes = tasks
      .map(task => this.calculateCycleTime(task))
      .filter(time => time !== null);

    if (cycleTimes.length === 0) {
      return 0;
    }

    const sum = cycleTimes.reduce((acc, time) => acc + time, 0);
    return sum / cycleTimes.length;
  }

  /**
   * Calculate throughput (tasks completed per day)
   * @param {number} days - Number of days to calculate over
   * @param {object} options - Filter options
   * @returns {number} Tasks per day
   */
  getThroughput(days = 7, options = {}) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const tasks = this.taskManager.getTasks({ stage: 'done', ...options });

    const recentlyCompleted = tasks.filter(task => {
      if (!task.completedAt) return false;
      const completedTime = new Date(task.completedAt).getTime();
      return completedTime >= cutoff;
    });

    return recentlyCompleted.length / days;
  }

  /**
   * Calculate time spent in each stage for a task
   * @param {object} task - The task
   * @returns {object} Stage durations { stageId: milliseconds }
   */
  getStageDurations(task) {
    const transitions = this.dataStore.getRecentTransitions(1000);
    const taskTransitions = transitions.filter(t => t.taskId === task.id);

    const durations = {};
    let lastTime = new Date(task.createdAt).getTime();
    let lastStage = 'todo';

    for (const transition of taskTransitions) {
      const transitionTime = new Date(transition.timestamp).getTime();
      const duration = transitionTime - lastTime;

      if (!durations[lastStage]) {
        durations[lastStage] = 0;
      }
      durations[lastStage] += duration;

      lastStage = transition.toStage;
      lastTime = transitionTime;
    }

    // Add time in current stage
    if (task.stage !== 'done') {
      const now = Date.now();
      if (!durations[task.stage]) {
        durations[task.stage] = 0;
      }
      durations[task.stage] += now - lastTime;
    }

    return durations;
  }

  /**
   * Calculate average stage durations across all completed tasks
   * @param {object} options - Filter options
   * @returns {object} Average durations { stageId: milliseconds }
   */
  getAverageStageDurations(options = {}) {
    const tasks = this.taskManager.getTasks({ stage: 'done', ...options });

    const stageTotals = {};
    const stageCounts = {};

    for (const task of tasks) {
      const durations = this.getStageDurations(task);

      for (const [stageId, duration] of Object.entries(durations)) {
        if (!stageTotals[stageId]) {
          stageTotals[stageId] = 0;
          stageCounts[stageId] = 0;
        }
        stageTotals[stageId] += duration;
        stageCounts[stageId]++;
      }
    }

    const averages = {};
    for (const stageId of Object.keys(stageTotals)) {
      averages[stageId] = stageTotals[stageId] / stageCounts[stageId];
    }

    return averages;
  }

  /**
   * Get work in progress (WIP) count per stage
   * @returns {object} WIP counts { stageId: count }
   */
  getWIPCounts() {
    const tasks = this.taskManager.getAllTasks();
    const wipCounts = {};

    for (const task of tasks) {
      if (task.stage && task.stage !== 'done' && task.status !== 'blocked') {
        if (!wipCounts[task.stage]) {
          wipCounts[task.stage] = 0;
        }
        wipCounts[task.stage]++;
      }
    }

    return wipCounts;
  }

  /**
   * Detect bottlenecks (stages with high WIP or long duration)
   * @returns {Array} Bottleneck info
   */
  detectBottlenecks() {
    const wipCounts = this.getWIPCounts();
    const avgDurations = this.getAverageStageDurations();
    const stages = this.taskManager.getStages();

    const bottlenecks = [];

    for (const stage of stages) {
      const wip = wipCounts[stage.id] || 0;
      const avgDuration = avgDurations[stage.id] || 0;

      // Bottleneck if WIP > agentPool * 2 or avg duration > 2x overall average
      const isHighWIP = stage.agentPool > 0 && wip > stage.agentPool * 2;
      const overallAvg = Object.values(avgDurations).reduce((a, b) => a + b, 0) / Object.keys(avgDurations).length;
      const isSlowStage = avgDuration > overallAvg * 2;

      if (isHighWIP || isSlowStage) {
        bottlenecks.push({
          stageId: stage.id,
          stageName: stage.name,
          wip,
          avgDuration,
          reasons: [
            isHighWIP ? `High WIP (${wip} tasks, pool size: ${stage.agentPool})` : null,
            isSlowStage ? `Slow processing (${Math.round(avgDuration / 1000 / 60)} min avg)` : null
          ].filter(Boolean)
        });
      }
    }

    return bottlenecks;
  }

  /**
   * Get comprehensive metrics dashboard data
   * @param {object} options - Filter options
   * @returns {object} Dashboard metrics
   */
  getDashboardMetrics(options = {}) {
    return {
      averageCycleTime: this.getAverageCycleTime(options),
      throughput: this.getThroughput(7, options),
      wipCounts: this.getWIPCounts(),
      averageStageDurations: this.getAverageStageDurations(options),
      bottlenecks: this.detectBottlenecks(),
      taskStats: this.taskManager.getStageStats(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get metrics for a specific project
   * @param {string} project - Project path
   * @returns {object} Project metrics
   */
  getProjectMetrics(project) {
    return this.getDashboardMetrics({ project });
  }

  /**
   * Get metrics trend over time (last N days)
   * @param {number} days - Number of days
   * @returns {Array} Daily metrics
   */
  getMetricsTrend(days = 30) {
    const trend = [];
    const now = Date.now();

    for (let i = 0; i < days; i++) {
      const dayStart = now - ((days - i) * 24 * 60 * 60 * 1000);
      const dayEnd = dayStart + (24 * 60 * 60 * 1000);

      const dayThroughput = this.getThroughput(1, {
        completedAfter: new Date(dayStart).toISOString(),
        completedBefore: new Date(dayEnd).toISOString()
      });

      trend.push({
        date: new Date(dayStart).toISOString().split('T')[0],
        throughput: dayThroughput
      });
    }

    return trend;
  }
}

module.exports = MetricsManager;
