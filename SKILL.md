---
name: caravel
description: Fleet orchestration system for multi-agent software development. Use when the user wants to build a complete application, break work into phases, delegate to specialized agents, or run iterative review loops. Supports planning, execution, design review with vision, and quality gates.
allowed-tools: plan_project,run_phase,review_task,fleet_control,fleet_status
---

# Caravel Fleet Orchestration

You are the captain of a fleet of specialized AI agents. Use caravel to build complete applications from start to finish.

## Architecture

Caravel uses a **supervisor-worker pattern with pipeline review loops** — the recommended architecture for software development (per Azure Architecture Center and LangGraph research).

```
         +--- [Tech Lead] --- plan ---+
         |                             |
Main Agent --> supervisor routing     |
         |                             v
         +--- [Developer] --- execute ---+
                                      |
                         +--- [Designer] -- review (vision) ---+
                         |                                       |
                    approved --> next phase              needs_fix --> fix loop
```

## Fleet Composition

| Agent | Role |
|-------|------|
| **developer** | Coding, implementation, file manipulation |
| **tech-lead** | Architecture, planning, code quality review |
| **designer** | Visual review, UI analysis, design quality |

Each agent's model is configurable in its `agents/*.md` file — works with any provider (local or cloud).

## How It Works

### Phase 1: Plan

Use `plan_project` to decompose the project into phases and tasks. Plan all phases up front so each agent has full context.

```
plan_project(
  name="Build a Kanban Board App",
  phases=[
    {
      name: "Project Setup",
      tasks: [
        {agent: "developer", task: "Initialize project with Next.js 14, TypeScript, TailwindCSS..."},
        {agent: "tech-lead", task: "Define component architecture and state management strategy..."},
      ]
    },
    {
      name: "Core Components",
      tasks: [
        {agent: "developer", task: "Create Board, Column, and Card components..."},
        {agent: "developer", task: "Implement drag-and-drop functionality..."},
      ]
    },
    {
      name: "Visual Review",
      tasks: [
        {agent: "designer", task: "Review Board and Column components for visual quality..."},
      ]
    },
  ]
)
```

### Phase 2: Execute

Use `run_phase(phaseIndex=N)` to execute each phase sequentially. Sub-agents run with their own model, tools, and context.

```
run_phase(phaseIndex=0)
```

Results include completion status and token usage.

### Phase 3: Review — Two-Stage Quality Gate

Use `review_task(phaseIndex=N)` to submit completed tasks for a **two-stage review process**:

**Stage 1: Code Review (Tech Lead)**
- Correctness: implementation matches spec, edge cases handled
- Security: no hardcoded secrets, proper input validation
- Performance: efficient algorithms, no unnecessary computation
- Architecture: well-structured, follows patterns, maintainable
- Code Quality: readable, no duplication, consistent naming
- Testing: tests created and cover key cases

**Stage 2: Design Review (Designer)**
- Layout & Structure: aligned, consistent spacing, clear hierarchy
- Visual Consistency: colors, typography, component styles
- Accessibility: color contrast, interactive states, readability
- User Experience: intuitive navigation, user feedback
- Polish: no glitches, proper edge states (empty, loading, error)

If EITHER stage fails:
- Developer automatically fixes the issues
- Both stages re-run (or only the failed stage, if using `reviewType`)
- Loop up to `maxReviewCount` (default: 3) times per task
- If max reached: task marked as FAILED, escalates to main agent

If BOTH stages pass: task APPROVED, move to next phase.

```
review_task(phaseIndex=0)              // Full code + design review
review_task(phaseIndex=0, reviewType="code")  // Code review only
review_task(phaseIndex=0, reviewType="design") // Design review only
```

### Phase 4: Iterate

Repeat phases until complete. Use `fleet_control` to pause, resume, skip, or jump between phases.

```
fleet_control(action="next")       // Move to next phase
fleet_control(action="skip")       // Skip current phase
fleet_control(action="pause")      // Pause execution
fleet_control(action="resume")     // Resume execution
fleet_control(action="reset")      // Reset fleet state
```

## When to Use Caravel

- Building a complete application from scratch
- Tasks that benefit from specialized roles (code + design review)
- Projects where iterative quality gates matter
- Any task where you want automated review loops

## When NOT to Use Caravel

- Simple one-off fixes (just do it directly)
- Research or web search tasks
- Tasks that don't involve code output

## Agent Selection Guide

- Use **developer** for: implementing features, writing code, fixing bugs, running tests/builds
- Use **tech-lead** for: architecture decisions, code review, breaking down complex tasks, planning
- Use **designer** for: reviewing UI screens, visual consistency, accessibility, design polish

## Task Description Best Practices

Be specific and actionable:
- Include file paths when possible
- Reference existing code patterns in the project
- Specify expected output format
- Include any constraints or requirements

### Good

```
{agent: "developer", task: "Create src/components/Button.tsx with primary/secondary variants, 
  supporting all Button props from ButtonProps interface. Follow the existing pattern in 
  src/components/Card.tsx for prop structure and styling."}
```

### Bad

```
{agent: "developer", task: "Make a button component"}
```

## Review Loop Details

The two-stage review is the quality gate of the fleet. Both stages must pass for a task to be approved.

```
Developer completes task
    |
    v
+---+ Stage 1: Code Review (Tech Lead) +---------+
| Correctness, Security, Performance,     |
| Architecture, Code Quality, Testing     |
+-----------------------------------------+
    |
    +--> APPROVED --> Stage 2
    |
    +--> NEEDS_FIX --> Developer fixes --> re-run Stage 1
    |
    +--> (if max iterations) CRITICAL -> escalate

    v (after code approved)

+---+ Stage 2: Design Review (Designer) +-------+
| Layout, Consistency, Accessibility,          |
| UX, Polish, Visual Quality                  |
+---------------------------------------------+
    |
    +--> APPROVED --> task COMPLETE, next phase
    |
    +--> NEEDS_FIX --> Developer fixes --> re-run Stage 2
    |
    +--> (if max iterations) CRITICAL -> escalate
```

Each task tracks: `codeReviewStatus` (approved/needs_fix) and `designReviewStatus` (approved/needs_fix).
Both must be approved for the task to be complete.

Dashboard review panel shows:
- Current iteration count and max
- Code review summary (approved vs needs fix)
- Design review summary (approved vs needs fix)
- Recent review feedback from both stages

## Fleet Dashboard

Open the fleet dashboard with `/fleet` to see:
- **TASKS panel**: all phases and their task status
- **AGENTS panel**: agent status and active assignments
- **REVIEW panel**: review flow visualization and history
- **TERMINAL panel**: recent agent output

Keyboard controls in the dashboard:
- Tab / Shift+Tab: switch panels
- Up/Down: navigate items
- Enter: select item
- Space: pause/resume fleet
- P: skip current phase
- R: trigger review
- Esc: close dashboard
