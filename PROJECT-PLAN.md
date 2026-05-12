# Caravel — Project Assessment & Current State

## Current State Assessment

### What Caravel Is
A fleet orchestration system for Pi with supervisor-worker pattern, two-stage review loops, and a persistent widget bar.

### What Works Well
- Clean supervisor-worker architecture with configurable models
- Two-stage review (code + design) with auto-fix loops
- Agent discovery from user+project directories
- State persistence across sessions
- **Stable widget bar** — always exactly 6 lines, never changes height or width
- **Robust error handling** — all agent functions report actionable errors when agents are missing or fail
- `/analyze` actually runs agents and reports results/errors clearly

### Agent Function Error Handling (Current)

| Function | Error Cases | How Errors Are Handled |
|----------|-------------|------------------------|
| `runAnalysisPhase` | No analyzer agent, subagent failure | Returns `{tasks, report, errors}` with actionable "add agent" guidance |
| `runCodeReview` | No tech-lead agent, subagent failure | Returns `{approved, error: "tech-lead"}` with available agents list |
| `runDesignReview` | No designer agent, subagent failure | Returns `{approved, error: "designer"}` with available agents list |
| `runDeveloperFix` | No developer agent, no task output | Returns `{success, error: "..."}` with actionable guidance |
| `runReviewInternal` | Any upstream error | Checks `error` field first, aborts with clear message |
| `review_task` tool | Any upstream error | Early-returns with actionable message including available agents |

### `/analyze` Command (Current)
- Actually executes the analyzer agent via `runSubagent()`
- Returns `✅` with report on success
- Returns `⚠️` with errors and actionable guidance on failure
- If no analyzer agent: shows "add an auditor/developer agent" guidance
- If subagent fails: shows exit code, stderr, and specific fix instructions

## Current Architecture

### Widget Bar Only (No Overlay)

| Component | API | Purpose |
|-----------|-----|---------|
| Widget bar | `ctx.ui.setWidget()` | Always-visible 6-line progress bar |
| `/fleet` command | Toggles widget | Show/hide widget bar |

The overlay dashboard was removed because it caused UI glitches, size instability, and poor UX.

### Widget Bar Layout

Always exactly 6 lines, fixed 62-char content width:

```
╔══════════════════════════════════════════════════════════════╗
║  CARAVEL FLEET  │  P1/3: Setup  │  ▸ RUN                   ║
║  [████████░░░░░░░░] 40%  │  2/5 tasks  │  1m 23s            ║
║  ▸ running: bash → npm install                              ║
║  0 reviews  │  Elapsed: 1m 23s                              ║
╚══════════════════════════════════════════════════════════════╝
```

### Event System

Updates on:
- `agent_end` → refresh widget bar
- `tool_call` → refresh widget bar
- Fleet state changes → refresh widget bar

## Current Implementation Status

### ✅ Completed
1. Persistent widget bar (always stable, never changes size)
2. Overlay dashboard removal
3. Widget bar idle/active state consistency (both 6 lines)
4. Agent function error handling (runCodeReview, runDesignReview, runDeveloperFix)
5. `/analyze` command proper error reporting
6. `runAnalysisPhase` consolidation (single analyzer path)
7. Documentation updates (README, SKILL.md, PROJECT-DESIGN.md, PROJECT-PLAN.md)
8. `fleet_error_diagnosis` tool — structured diagnosis of fleet failures (missing agents, exit codes, stderr, token limits, rate limits, auth errors)
9. `/diagnose` command — CLI entry point for error diagnosis

### Remaining Work (Future)
- Planner agent conversation flow (natural language planning)
- Additional agent types (qa-engineer, etc.)
- Widget bar visual refinements (color themes, compact mode)

## Success Criteria (Current)

1. **Stable UI**: Widget bar never changes height or width, always visible
2. **Clear errors**: Every agent function reports actionable errors
3. **/analyze works**: Actually runs agents, reports results and errors
4. **Natural language workflow**: User describes project, fleet handles orchestration

## File Structure

```
caravel/
├── SKILL.md              # Main skill for the main agent (agent-facing guide)
├── package.json          # Pi package manifest
├── README.md             # This file (user-facing documentation)
├── LICENSE
├── PROJECT-DESIGN.md     # Widget bar design reference (current)
├── PROJECT-PLAN.md       # Project roadmap (this file)
├── extensions/
│   └── caravel.ts        # Orchestrator (5 tools, widget bar, subagent spawning)
├── agents/
│   ├── developer.md      # Developer agent (configurable model)
│   ├── tech-lead.md      # Tech lead agent (configurable model)
│   ├── designer.md       # Designer agent (configurable model, needs vision)
│   ├── planner.md        # Conversational planner (interviews user, generates plans)
│   └── auditor.md        # Codebase analyzer (scans existing projects)
├── skills/
│   ├── code-review.md    # Code review checklist for tech-lead
│   ├── design-review.md  # Design review checklist for designer
│   └── fleet-orchestration.md  # Auto-orchestration guidance for the main agent
└── prompts/
    └── task-brief.md     # Task brief template
```

## License

MIT
