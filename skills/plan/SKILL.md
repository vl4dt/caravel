---
name: plan
description: The /plan command reads ANALYSIS.md or PROJECT-DESIGN.md and produces a structured project plan with phases and tasks. Use when the user types /plan, asks to create a project plan, or wants to turn design docs into actionable phases.
---

# /plan Command

## Purpose

Read the project's analysis or design documentation and produce a **structured project plan** (`PLAN.md`) with phases, tasks, and actionable items. Transforms static analysis into an execution roadmap.

## Invocation

The user invokes this skill by typing `/plan`. You may also trigger it programmatically:

```javascript
subagent("plan", "Read the current design docs and produce a structured project plan in PLAN.md.")
```

## How It Works

### 1. Locate Source Document

Search for the source document in order of preference:

1. `ANALYSIS.md` — Full codebase analysis report
2. `PROJECT-DESIGN.md` — Project design documentation
3. `README.md` — Fallback for minimal projects with no analysis

If neither exists, create a skeleton plan from the current directory structure and file scan.

```javascript
// Pseudocode logic:
if (fileExists("ANALYSIS.md")) {
  source = read("ANALYSIS.md");
} else if (fileExists("PROJECT-DESIGN.md")) {
  source = read("PROJECT-DESIGN.md");
} else {
  source = scanDirectory();
}
```

### 2. Parse and Extract Planning Context

From the source document, extract:

| From ANALYSIS.md | From PROJECT-DESIGN.md | Fallback |
|---|---|---|
| Tech stack & dependencies | Architecture overview | Directory structure |
| Existing patterns & conventions | Component/module boundaries | File scan for entry points |
| Technical debt items | Current state assessment | Key files found |
| Test gaps | Design goals | Dependencies from package.json |
| Entry points & architecture | Implementation targets | Build system config |

### 3. Produce Structured Plan

Generate `PLAN.md` with the following structure:

```markdown
# Project Plan

> Generated: YYYY-MM-DD HH:MM UTC
> Source: ANALYSIS.md / PROJECT-DESIGN.md
> Project: <project name>

## Summary

[1-2 paragraph overview of the project, its goals, and current state.]

## Phases

### Phase 1: <Phase Name>
**Goal:** <What this phase accomplishes>
**Priority:** P0 / P1 / P2
**Estimated Effort:** <e.g., 2-3 days>

| # | Task | Depends On | Priority | Notes |
|---|------|------------|----------|-------|
| 1 | <Task description> | — | P1 | <optional detail> |
| 2 | <Task description> | T1 | P1 | <optional detail> |
| 3 | <Task description> | — | P2 | <optional detail> |

### Phase 2: <Phase Name>
...

## Dependencies

- **Critical:** <tasks that block everything else>
- **Recommended:** <related but non-blocking>

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| <description> | <high/med/low> | <action> |

## Next Steps

1. <Immediate action to take first>
2. <Second priority action>
3. ...
```

### Phase Generation Rules

Use these rules to determine phases from the analysis:

| Condition | Phase Created |
|---|---|
| ANALYSIS.md has Critical debt items | `Phase: Fix Critical Debt` (before anything else) |
| ANALYSIS.md has test gaps | `Phase: Set Up Testing` |
| PROJECT-DESIGN.md has architecture goals | `Phase: Architecture Foundation` |
| ANALYSIS.md mentions setup/dependency issues | `Phase: Environment Setup` |
| DESIGN goals include new features | `Phase: Feature Implementation` |
| ANALYSIS.md has Important debt | `Phase: Address Important Debt` |
| DESIGN goals include refactoring | `Phase: Refactoring` |
| ANALYSIS.md has low-priority improvements | `Phase: Polish & Cleanup` |

### Task Assignment Rules

When assigning tasks to phases:

1. **Infrastructure first** — environment, tooling, configuration
2. **Foundation second** — core modules, data models, entry points
3. **Features third** — new functionality built on the foundation
4. **Polish last** — cleanup, optimization, documentation

### Progress Feedback

During execution, emit structured progress messages for each phase so the user always sees what's happening:

**Start — reading source documents:**
```
📋 Plan: Project roadmap generation
  Phase: 0 of 0
  Status: in-progress
  Detail: Reading ANALYSIS.md and PROJECT-DESIGN.md...
```

**Each phase as it's derived:**
```
📋 Plan: Phase 1 — Environment Setup
  Phase: 1 of 4
  Status: complete
  Detail: 3 tasks defined — install deps, configure linting, set up tests
```

**Final completion:**
```
📋 Plan: Project roadmap — complete
  Phase: 4 of 4
  Status: complete
  Result: 4 phases, 18 tasks, 3 blockers identified
  Artifact: PLAN.md
```

## Output

Write the plan to `PLAN.md` in the project root:

```javascript
writeFileSync("PLAN.md", planContent);
```

After writing, report back to the user with:

```
✓ Plan generated. Saved to: PLAN.md
  Phases: 4
  Tasks: 12
  Sources: ANALYSIS.md
  Priority items: 3
```

## Guidelines

### DO
- **Read the source first** — don't generate a plan without understanding the project
- **Be specific** — every task should name files, modules, or concrete outcomes
- **Respect dependencies** — order phases so each builds on the previous
- **Flag blockers** — explicitly call out items that block all downstream work
- **Include effort estimates** — help the user gauge scope at a glance
- **Timestamp the plan** — so freshness is always auditable
- **Keep it actionable** — tasks should be something an agent or human can start immediately

### DO NOT
- Generate a plan without a source document (unless doing a directory-scan fallback)
- Create tasks without clear deliverables
- Skip dependency analysis between phases
- Produce more than 20 tasks per phase (break into sub-phases)
- Assume priorities without seeing the analysis data
- Regenerate the plan without checking if it already exists (overwrite only on explicit `/plan`)

## When to Use

- User types `/plan`
- User asks to "create a project plan" or "break this down into phases"
- Before starting implementation — to get a roadmap
- After an analysis (`/analyze`) — to turn findings into action
- When taking over a project — to understand what needs to be done and in what order
- When a plan is outdated — regenerate from updated analysis

## When Not to Use

- When `ANALYSIS.md` exists but is clearly stale — suggest re-running `/analyze` first
- When the project is too simple (single file, trivial scaffold) — just give advice directly
- During an active `/go` session that already has a plan — use the existing one

## Updating an Existing Plan

If `PLAN.md` exists and the user runs `/plan` again:

1. Compare source document changes against the existing plan
2. **Overwrite** if:
   - The source document has changed significantly
   - The user explicitly asked for a new plan
   - The analysis is stale (older than the plan)
3. **Report** if the plan is still valid:

```
Plan in PLAN.md is still valid. No significant changes in source since last update.
```

## Example Workflow

```
User: /analyze
Agent:
  1. Orchestrator scans codebase directly (no delegation)
  2. Reads package.json, README, directory structure
  3. Detects tech stack, entry points, dependencies
  4. Produces ANALYSIS.md
  5. Reports: "✅ Analysis complete — 3 critical items, 2 medium"

User: /plan
Agent:
  1. Reads ANALYSIS.md
  2. Extracts: tech stack, debt items, test gaps, architecture
  3. Emits: 📋 Plan: Phase 1 of 4 — Environment Setup (in-progress)
  4. Emits: 📋 Plan: Phase 1 of 4 — complete
  5. Emits: 📋 Plan: Phase 2 of 4 — Architecture Foundation (in-progress)
  6. ...
  7. Emits: 📋 Plan: Project roadmap — complete (4 of 4, complete)
  8. Writes PLAN.md
  9. Reports: "✓ Plan generated. Saved to: PLAN.md — 4 phases, 15 tasks"

User: /analyze
Agent:
  1. Orchestrator re-scans codebase directly
  2. Detects changes since last scan
  3. Overwrites ANALYSIS.md with fresh findings
  4. Reports: "✓ Analysis updated — 2 new critical items found"

User: /plan
Agent:
  1. Reads updated ANALYSIS.md
  2. Detects significant changes from last plan
  3. Emits: 📋 Plan: Phase 1 of 5 — critical debt fix (in-progress)
  4. ...
  5. Emits: 📋 Plan: Project roadmap — complete (5 of 5, complete)
  6. Overwrites PLAN.md
  7. Reports: "✓ Plan updated. Saved to: PLAN.md — 5 phases, 18 tasks"
```
