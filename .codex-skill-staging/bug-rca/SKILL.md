---
name: bug-rca
description: Investigate bugs with ranked root-cause analysis before proposing fixes. Use when debugging regressions, unexpected behavior, flaky tests, production issues, or unclear failures where the user wants confidence, evidence, blast radius, and structured solution options.
---

# Bug RCA

Use this skill when the user asks to debug, investigate, find root cause, explain a regression, or assess likely fixes.

## Operating Rules

- Do not jump directly to a fix.
- Separate diagnosis from solution design.
- Start with evidence gathering and competing hypotheses.
- Prefer repo-specific reasoning over generic bug lore.
- Quantify uncertainty with confidence levels.
- Call out when a hypothesis is inferred rather than proven.

## Investigation Workflow

Follow this sequence:

1. Restate the bug, symptoms, and known reproduction details.
2. Inspect the relevant code, configuration, tests, and recent change surface.
3. Identify the most likely failure boundaries.
4. Generate competing root-cause hypotheses.
5. Rank the top 5 hypotheses by confidence.
6. Recommend the fastest next validation step.
7. Only then propose solution options.

## Evidence Gathering

Check the most relevant subset of:

- failing code paths and callers
- recent edits or adjacent implementation changes
- runtime/config/env assumptions
- data shape, API contract, and state transitions
- logs, test failures, screenshots, traces, and reproduction steps
- auth, permissions, caching, or race/timing concerns
- schema, policy, migration, or generated-type drift

Use the repo's stack to shape the analysis. For example:

- `Next.js`: rendering boundary mismatch, cache behavior, route handlers, server/client split
- `React/Vite`: stale state, effect timing, prop flow, dev/build differences
- `Supabase`: auth/session, RLS, schema mismatch, client/server credential boundary
- `Convex`: stale reactive assumptions, function contract mismatch, index/query behavior

## RCA Output

Default to a compact table with these columns:

| Rank | Hypothesis | Confidence | Supporting Evidence | Contradicting Evidence / Gaps | Blast Radius | Fastest Validation |
| ---- | ---------- | ---------- | ------------------- | ----------------------------- | ------------ | ------------------ |

Rules for the table:

- Always provide 5 rows unless fewer hypotheses are defensible.
- Confidence should be explicit, for example `High`, `Medium`, `Low`, optionally with rough percentages.
- Do not list five variants of the same idea.
- Supporting and contradicting evidence must be specific to the repo or bug report.

## Solution Output

After the RCA table, provide solution options in ranked order.

Each option must include:

- proposed fix
- confidence
- expected blast radius
- likely affected subsystems or files
- regression risk
- validation plan

If the top RCA is weak, say that the right next step is more investigation instead of pretending the fix is known.

## Output Format

Use this structure unless the user asks for something else:

### Bug Summary

- symptoms
- reproduction status
- current evidence

### Scope of Investigation

- relevant subsystems and stack context

### Top RCA Candidates

- ranked RCA table

### Recommended Next Validation

- the single highest-value next check

### Solution Options

- ranked fixes with confidence and blast radius

### Verification

- tests, checks, and regression watchpoints

## Quality Bar

The output should help a human quickly decide what to inspect next, what is probably wrong, and how risky the likely fixes are. Favor specificity, evidence, and clear uncertainty over premature certainty.
