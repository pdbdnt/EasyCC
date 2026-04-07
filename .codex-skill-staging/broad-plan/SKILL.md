---
name: broad-plan
description: Produce wider, stack-aware implementation plans for features, fixes, and refactors. Use when the user wants stronger planning, broader blast-radius analysis, better alternative evaluation, or more challenge to the initial framing than default planning usually provides.
---

# Broad Plan

Use this skill when the user asks for a plan, strategy, design, approach, implementation outline, or impact assessment.

## Operating Rules

- Do not accept the user's framing immediately.
- Start with a non-mutating repo discovery pass before planning.
- Adapt to the detected stack instead of assuming a framework.
- Prefer widening the problem before narrowing to implementation.
- Ask follow-up questions only when a missing answer would materially change the plan.
- Produce a decision-complete plan when enough context exists.

## Repo Discovery

Before planning, inspect the repo to identify the relevant stack and architecture. Check only the files needed to infer the implementation shape.

Prioritize:

- `package.json`, lockfiles, workspace config
- `tsconfig.json`
- `next.config.*`, `vite.config.*`, `astro.config.*`, `nuxt.config.*`
- backend/app entrypoints and API folders
- `supabase/`, `convex/`, `prisma/`, `drizzle/`, migrations, schema files
- test config and test folders such as Playwright, Vitest, Jest, Cypress
- deployment/config files that change runtime behavior

Infer the parts that matter for the task:

- frontend framework and rendering model
- backend/runtime boundaries
- database or hosted backend dependencies
- auth/session patterns if visible
- type-sharing boundaries
- test and validation surface

If a stack detail cannot be discovered reliably, say it is inferred or unknown.

## Planning Workflow

Follow this sequence:

1. Restate the request as goal, success criteria, and key constraints.
2. Summarize the discovered stack and architecture relevant to the task.
3. Expand the blast radius across affected layers.
4. Challenge the initial framing and identify non-obvious risks.
5. Offer 2-3 viable approaches when there is real design choice.
6. Recommend one approach with explicit reasoning.
7. Ask concise clarifying questions only if a high-impact decision remains unresolved.
8. Produce a decision-complete implementation plan.

## Blast Radius Checklist

Always consider the relevant subset of:

- UI and interaction flow
- routing, rendering, and data fetching boundaries
- API contracts and backend behavior
- database schema, policies, indexes, and migrations
- auth, permissions, and session behavior
- environment/config changes
- shared types and generated artifacts
- tests, fixtures, mocks, and observability
- rollout, backward compatibility, and regression risks
- developer workflow impact such as local dev, build, and CI

Adapt emphasis by stack:

- `Next.js`: route handlers, server/client boundaries, caching, rendering mode, auth/session flow
- `React/Vite`: client state flow, frontend/backend integration, build and watch ergonomics
- `Supabase`: auth, RLS/policies, RPC/storage, schema and migration impact
- `Convex`: query/mutation boundaries, indexes, reactivity, generated types
- TypeScript-heavy repos: shared types, compile-time surface, generated types, strictness risks

## Output Format

Use this structure unless the user asks for something else:

### Stack Summary

- Relevant stack and architecture discovered from the repo

### Goal

- User goal
- Success criteria
- Constraints and assumptions

### Options

- 2-3 viable approaches with tradeoffs, only when there is a real choice

### Recommended Approach

- Why this approach is preferred in this repo

### Blast Radius

- Affected subsystems and likely regression surface

### Implementation Plan

- Concrete, decision-complete steps grouped by behavior or subsystem

### Validation

- Tests, checks, rollout concerns, and acceptance criteria

## Office-Hours Mode

If the request is fuzzy, contradictory, or premature:

- stay in exploratory planning longer
- ask sharper questions about the actual problem, not just the requested solution
- surface better problem framings if the current one looks weak
- avoid writing an implementation plan until the core intent is stable

## Quality Bar

The plan should feel broader than a local code diff. It should explain how the change interacts with the repo's architecture, what it can break, and why the chosen approach is better than nearby alternatives.
