---
name: caravel
description: Fleet orchestration system for multi-agent software development. Use when the user wants to build a complete application, break work into phases, delegate to specialized agents, or run iterative review loops. Supports planning, execution, design review with vision, and quality gates.
allowed-tools: plan_project,run_phase,review_task,fleet_control,fleet_status,fleet_error_diagnosis
---

# Caravel Fleet Orchestration

## Available Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| `analyze.md` | `/analyze` | Run codebase analysis → produces `ANALYSIS.md` |
| `plan.md` | `/plan` | Read `ANALYSIS.md` or `PROJECT-DESIGN.md` → produce `PLAN.md` |
| `progress.md` | — | Progress feedback templates for all phase types |
| `fleet-orchestration.md` | — | Auto-orchestration guidance for the main agent |
| `code-review.md` | — | Code review checklist with logic error detection + gate checks for the tech-lead agent |
| `design-review.md` | — | Design review checklist with design token consistency checks for the designer agent |
| `zellij-fleet.md` | `/zellij-*` | ZFS user guide — workspace layout, keyboard shortcuts, follow mode, monitoring, and troubleshooting |

## Complete Workflow

### Scenario 1: Take Over an Existing Codebase

```
analyze   →  /analyze  →  ANALYSIS.md  →  /plan  →  PLAN.md  →  /go  →  execute
```

1. **Analyze** — run `/analyze` to produce `ANALYSIS.md`
2. **Plan** — run `/plan` to convert analysis into phases/tasks → `PLAN.md`
3. **Execute** — run `/go` to auto-orchestrate the fleet
4. **Monitor** — watch via widget bar or `fleet_status`

### Scenario 2: Start a New Project

1. **Describe** what you want in natural language
2. **Plan** — `plan_project()` to decompose into phases
3. **Execute** — `/go` auto-orchestrates phases with review
4. **Iterate** — fix review feedback, advance to next phase

### Scenario 3: ZFS Mode (Terminal Fleet)

1. **Install Zellij** (once): `brew install zellij` / `winget install Zellij.Zellij`
2. **Start ZFS**: `/zellij-start` — creates session, panes, floating status bar
3. **Describe** your project in the orchestrator pane
4. **Monitor** panes in real-time: `/zellij-follow <agent>`, `/zfs-list-panes`
5. **Control** the fleet: `/zfs-pause`, `/zfs-resume`, `/zfs-skip-agent <name>`
6. **Detach** during long runs: `Ctrl+Shift+d` in ZFS, resume later with `/zellij-panes`

## Key Files

| File | Generated? | Description |
|------|-----------|-------------|
| `ANALYSIS.md` | Yes (from `/analyze`) | Codebase analysis report |
| `PLAN.md` | Yes (from `/plan`) | Project plan with phases and tasks |
| `PROJECT-DESIGN.md` | Yes (from `/analyze`) | Architecture/design overview |
| `SKILL.md` | No | Main skill definition (this file) |

---

You are the captain of a fleet of specialized AI agents. Use caravel to build complete applications from start to finish — entirely through natural language, no TypeScript needed from the user.

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
| **documenter** | Documentation specialist — write, maintain, and update all project docs |
| **planner** | Project planning, requirement gathering, task decomposition |

Each agent's model is configurable in its `agents/*.md` file — works with any provider (local or cloud). The designer needs a vision-capable model (supports image input).

## Natural Language Workflow

The user describes what they want in **plain English**. You handle all the orchestration internally — the user never types TypeScript.

### Two Main Scenarios

#### Scenario 1: New Project

```
User: "I want to build a kanban board app with drag-and-drop"
```

You respond:
1. **If scope is clear** — Plan the project yourself using `plan_project`, then run `/go`:
   ```javascript
   plan_project({ name: "...", phases: [...] })
   fleet_control(action = "go")  // auto-runs all phases with review between each
   ```

#### Scenario 2: Taking Over Existing Codebase

```
User: "I want to add dark mode to this existing React app"
```

You respond:
1. **Analyze** — run `/analyze` to produce `ANALYSIS.md` with full codebase scan
2. **Plan** — run `/plan` to convert analysis into phases/tasks → `PLAN.md`
3. **Execute** — run `/go` to auto-orchestrate the fleet
4. **Monitor** — watch progress via the widget bar or `fleet_status`

If the user wants to jump straight to planning:
1. **Plan** — `plan_project()` directly if scope is clear
2. **Execute** — `/go` to run phases with review

### The /go Command

The `/go` command is your workhorse — it auto-orchestrates the fleet:
- Runs all phases sequentially
- Triggers review between each phase
- Auto-fixes review issues
- Reports progress
- Handles interruptions (pause/resume/skip)

You can invoke it with:
```javascript
fleet_control(action = "go")
```

### Monitoring

The widget bar above the editor shows fleet status in real-time. It is always stable — fixed 6 lines, never changes height or width.

- Report phase completions and review results
- If a review fails, explain what needs fixing

### Error Diagnosis

When phases or tasks fail, use `fleet_error_diagnosis` or `/diagnose` to get a structured diagnosis:

```javascript
fleet_error_diagnosis()
// or
/diagnose
```

The diagnosis covers:
- **Missing agents** — which agent is needed and how to create it
- **Exit codes** — what non-zero codes mean and how to debug
- **stderr content** — pattern-matched against known error types
- **Token limits** — context window exceeded, budget overflows
- **Rate limits** — API rate limiting from the provider
- **Authentication** — invalid/expired API keys
- **Model errors** — invalid model names or unavailable models
- **Review loop exhaustion** — when reviews fail repeatedly

Each cause includes: severity level, affected phase/task, root cause explanation, and step-by-step fix instructions.

## Fleet State Management

### Pause / Resume

```javascript
fleet_control(action = "pause")   // Saves state to disk, blocks execution
fleet_control(action = "resume")  // Loads saved state, unblocks execution
```

State survives process termination, system restart, and blackouts. On next `run_phase()` or `/go`, the saved state is auto-loaded.

### Background Mode

Launch the fleet as a detached background process that survives closing the terminal:

```javascript
fleet_control(action = "go")    // Start fleet in foreground
// ...
fleet_control(action = "pause") // Pause
// Close terminal — fleet keeps running in background
// Reopen terminal, run:
fleet_control(action = "resume") // Reconnect
```

### ZFS Migration

Fleet can migrate between modes at any time:
- **Foreground → ZFS**: `/zellij-start`
- **ZFS → Background**: `/bg-export`
- **Background → ZFS**: `/zellij-start`

All migrations preserve state via `state.json`.

## How It Works

### Phase 1: Plan

Use `plan_project` to decompose the project into phases and tasks.

```javascript
plan_project({
  name: "Build a Kanban Board App",
  phases: [
    {
      name: "Project Setup",
      tasks: [
        { agent: "developer", task: "Initialize project with Next.js 14, TypeScript, TailwindCSS..." },
        { agent: "tech-lead", task: "Define component architecture and state management strategy..." },
      ]
    },
    {
      name: "Core Components",
      tasks: [
        { agent: "developer", task: "Create Board, Column, and Card components..." },
        { agent: "developer", task: "Implement drag-and-drop functionality..." },
      ]
    },
    {
      name: "Visual Review",
      tasks: [
        { agent: "designer", task: "Review Board and Column components for visual quality..." },
      ]
    },
  ]
})
```

### Phase 2: Execute

Use `run_phase(phaseIndex=N)` to execute each phase sequentially. Sub-agents run with their own model, tools, and context.

```javascript
run_phase(phaseIndex = 0)
```

Results include completion status and token usage.

### Phase 3: Review — Two-Stage Quality Gate

Use `review_task(phaseIndex=N)` to submit completed tasks for a **two-stage review process**:

**Stage 1: Code Review (Tech Lead)**
- Correctness: implementation matches spec, edge cases handled
- **Logic Error Detection**: missing imports, missing definitions, stub/placeholder code, unreachable branches, type mismatches, missing error handling
- **Gate Check**: verifies all files exist, no TODOs/placeholders, imports valid, no stub implementations
- Security: no hardcoded secrets, proper input validation
- Performance: efficient algorithms, no unnecessary computation
- Architecture: well-structured, follows patterns, maintainable
- Code Quality: readable, no duplication, consistent naming
- Testing: tests created and cover key cases

**Stage 2: Design Review (Designer)**
- Layout & Structure: aligned, consistent spacing, clear hierarchy
- **Design Token Consistency**: no hardcoded values, all tokens used correctly
- **Responsive Verification**: checked at mobile/tablet/desktop breakpoints
- Accessibility: color contrast, interactive states, readability
- UX: intuitive navigation, user feedback
- Polish: no glitches, proper edge states (empty, loading, error)

If EITHER stage fails:
- Developer automatically fixes the issues
- Both stages re-run (or only the failed stage, if using `reviewType`)
- Loop up to `maxReviewCount` (default: 3 per task, 5 fleet-wide) times
- If max reached: task marked as FAILED, escalates to main agent

If BOTH stages pass: task APPROVED, move to next phase.

```javascript
review_task(phaseIndex = 0)              // Full code + design review
review_task(phaseIndex = 0, reviewType = "code")     // Code review only
review_task(phaseIndex = 0, reviewType = "design")   // Design review only
review_task(phaseIndex = 0, feedback = "...")        // Manual feedback (bypasses auto-review)
```

### Phase 4: Iterate

Repeat phases until complete. Use `fleet_control` to pause, resume, skip, or jump between phases.

```javascript
fleet_control(action = "next")       // Move to next phase
fleet_control(action = "skip")       // Skip current phase
fleet_control(action = "pause")      // Pause execution
fleet_control(action = "resume")     // Resume execution
fleet_control(action = "reset")      // Reset fleet state
fleet_control(action = "go")         // Auto-run all remaining phases with review
```

## Agent Selection Guide

- Use **developer** for: implementing features, writing code, fixing bugs, running tests/builds
- Use **tech-lead** for: architecture decisions, code review, breaking down complex tasks, planning
- Use **designer** for: reviewing UI screens, visual consistency, accessibility, design polish
- Use **documenter** for: writing/updating documentation, maintaining README/DESIGN/PLAN accuracy
- Use **planner** for: requirement gathering, task decomposition, project planning

## Task Description Best Practices

Be specific and actionable:
- Include file paths when possible
- Reference existing code patterns in the project
- Specify expected output format
- Include any constraints or requirements
- **Include testability criteria** (required by fleet enforcement — see T7 below)

### Good

```javascript
{ agent: "developer", task: "Create src/components/Button.tsx with primary/secondary variants, 
  supporting all Button props from ButtonProps interface. Follow the existing pattern in 
  src/components/Card.tsx for prop structure and styling." }
```

### Bad

```javascript
{ agent: "developer", task: "Make a button component" }
```

---

### T7: Testability Enforcement

Every task in `plan_project()` MUST satisfy three testability criteria:

1. **Test files or verification commands** — e.g. `"Create src/Button.test.ts"`, `"Run npm test"`
2. **Acceptance criteria** — e.g. `"Done when: renders primary color"`, `"Acceptance: handles props A, B"`
3. **Measurable outcome** — e.g. `"Function returns boolean"`, `"Output: 200 status"`, `"File X is created"`

If any criterion is missing, `plan_project()` is **blocked** with a structured error and suggestions for how to fix it. Help the user add the missing criteria before retrying.

## Review Loop Details

The two-stage review is the quality gate of the fleet. Both stages must pass for a task to be approved.

```
Developer completes task
    |
    v
+---+ Stage 1: Code Review (Tech Lead) +---------+
| Correctness, Security, Performance,     |
| Architecture, Code Quality, Testing     |
| + Logic Error Detection (critical)      |
| + Gate Check (files, imports, stubs)    |
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
| + Design Token Consistency                  |
| + Responsive Verification                   |
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
## ZFS Mode — Zellij Fleet Session

Caravel can run the fleet inside a dedicated [Zellij](https://zellij.dev) terminal multiplexer for a full terminal-based fleet workspace.

```
┌────────────────────────────┬──────────────────────────┐
│    orchestrator (60%)      │  agent panes (40%)       │
│    Fleet command-and-      │  developer / tech-lead / │
│    control centre          │  designer / planner      │
├────────────────────────────┤                          │
│                            │  ┌────────────────────┐  │
│                            │  │  status bar        │  │
│                            │  │  (10-line float)   │  │
│                            │  │  agent grid        │  │
│                            │  │  phase progress    │  │
│                            │  │  token tracking    │  │
│                            │  │  review status     │  │
│                            │  └────────────────────┘  │
└────────────────────────────┴──────────────────────────┘
```

### Starting ZFS

```bash
# 1. Install Zellij (if you haven't)
#    macOS:  brew install zellij
#    Linux:  curl -LO https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz
#    Windows: winget install Zellij.Zellij

# 2. Start the fleet
/zellij-start
```

### Layout Variants

| Layout | Use Case |
|--------|----------|
| `fleet` (default) | Full workspace — orchestrator + all agent tabs |
| `minimal` | Focused coding — orchestrator + developer |
| `review` | Two-stage review — orchestrator + tech-lead + designer |
| `wide` | Side-by-side — orchestrator + developer + tech-lead |

Switch during execution: `zellij action switch-layout <name>`

### ZFS Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+o` | Orchestrator |
| `Ctrl+d` | Developer |
| `Ctrl+t` | Tech-lead |
| `Ctrl+D` | Designer |
| `Ctrl+w` | Toggle status bar |
| `Ctrl+s` | Save layout |
| `Ctrl+Shift+d` | Detach (leave running) |

### ZFS Monitoring

```bash
/zfs-fleet-state    # ZFS health check
/zfs-list-panes     # List all panes
/zfs-status-bar-update  # Force refresh
/zfs-pause          # Pause all panes (SIGSTOP)
/zfs-resume         # Resume all panes (SIGCONT)
/zfs-skip-agent developer  # Skip agent
```

> **No ZFS installed?** Fleet falls back to background processes automatically.

---

Toggle visibility with `/fleet`. The widget bar shows:
- **Line 1**: Top border `╔...╗`
- **Line 2**: `CARAVEL FLEET` header + current status (IDLE/RUNNING/PAUSED/DONE/FAILED)
- **Line 3**: Current phase + progress bar (e.g. `[████████░░░░░░░░] 40%`] + task count + elapsed time
- **Line 4**: Active agent action (e.g. `▸ running: bash → npm install`) or idle status
- **Line 5**: Review count (✓ approved / ○ pending) + Review time
- **Line 6**: Bottom border `╚...╝`

When idle (no phases):
- Shows agent count, review count, elapsed time
- Shows last agent action with time ago
- Always exactly the same 6 lines, same height, same width

## ZFS Mode — Zellij Status Bar

When ZFS (Zellij Fleet Session) is active, the **floating status bar** replaces/augments the pi widget bar. It shows:

```
╔══════════════════════════════════════════════════════════════╗
║          CARAVEL FLEET [ZFS MODE] │ P1/3                   ║
║  ● developer  ◉ tech-lead  ○ designer  │  3 agents        ║
║  P1/3: Implementation  [████████░░░░░░░░░░░░░░░░] 40%  2/5 tasks  3m 42s  ▸  ║
║  ▸ developer  [node]  Implement auth middleware  │ 12.5k  ║
║  ● idle — waiting for work                               ║
║  ● idle — waiting for work                               ║
║  ● idle — waiting for work                               ║
║  ▸ fleet total: 45k tokens  │  per-agent: 12.5k i / 3.2k o  │  2 ✓ 0 ○  ║
║  Review time: 3m 42s  │  ZFS                                ║
╚══════════════════════════════════════════════════════════════╝
```

### Status Bar Features

- **Agent grid**: All agents' statuses (running▸/idle●/error✗) in a compact row
- **Phase info**: Progress bar, task count, elapsed time
- **Per-agent detail**: Name, model, current task, token usage
- **Token summary**: Fleet total + per-agent input/output breakdown
- **Review status**: ✓ approved / ○ pending per phase
- **Auto-refresh**: Updates every 2 seconds

### ZFS Tools

| Tool | Purpose |
|------|--------|
| `zfs_status_bar_info` | Query status bar state |
| `zfs_status_bar_update` | Force refresh the floating pane |
| `zfs_status_bar_render` | Render status bar as text |
| `zfs_status_bar_toggle` | Enable/disable the status bar |

### Layouts

All layout variants include the status bar floating pane:
- **default**: Full fleet workspace (60/40 split + 3 agent tabs)
- **minimal**: Orchestrator + 1 agent + status bar
- **review**: Orchestrator + tech-lead + designer + status bar
- **wide**: Orchestrator + developer + tech-lead + status bar
