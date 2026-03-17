export const AGENT_TEMPLATES = [
  {
    id: 'primary',
    name: 'Primary',
    cliType: 'claude',
    role: ''
  },
  {
    id: 'architect',
    name: 'Architect',
    cliType: 'claude',
    role: "Design systems, plan architecture, review PRs. Don't write implementation code - produce specs and plans."
  },
  {
    id: 'backend-dev',
    name: 'Backend Dev',
    cliType: 'claude',
    role: 'Server-side specialist: API routes, database, auth, middleware. Never modify frontend/UI files.'
  },
  {
    id: 'frontend-dev',
    name: 'Frontend Dev',
    cliType: 'claude',
    role: 'React components, CSS/Tailwind, UI logic, accessibility. Never modify backend/server files.'
  },
  {
    id: 'test-writer',
    name: 'Test Writer',
    cliType: 'claude',
    role: "Write and run tests (Playwright, Jest). Review coverage gaps. Don't modify source code, only test files."
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    cliType: 'claude',
    role: 'Review code changes, find bugs, suggest improvements. Read-only - never edit files directly.'
  },
  {
    id: 'bug-hunter',
    name: 'Bug Hunter',
    cliType: 'claude',
    role: 'Investigate bugs: read logs, trace code, identify root cause. Propose minimal targeted fixes.'
  },
  {
    id: 'devops',
    name: 'DevOps',
    cliType: 'claude',
    role: 'Docker, CI/CD, deployment, environment config, infrastructure.'
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    cliType: 'claude',
    role: 'Coordinate multiple agents. Spawn sub-agents for subtasks, monitor progress, and collect results. Do not write code directly — delegate to specialized agents.',
    isOrchestrator: true
  },
  {
    id: 'codex-agent',
    name: 'Codex Agent',
    cliType: 'codex',
    role: 'General-purpose Codex coding assistant.'
  },
  {
    id: 'terminal',
    name: 'Terminal',
    cliType: 'terminal',
    role: ''
  },
  {
    id: 'custom',
    name: 'Custom',
    cliType: 'claude',
    role: ''
  }
];

