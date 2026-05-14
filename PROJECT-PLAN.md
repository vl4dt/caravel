# caravel - Project Plan

> Generated: 2026-05-14 from project architecture
> Scope: fleet orchestration, multi-agent review, error resilience

---

## Architecture Overview

Caravel is a **fleet orchestration system** for Pi coding agents. It implements:

- **Supervisor-worker pattern** with pipeline review loops
- **Two-stage review** (code + design) before task completion
- **Error resilience** with signal detection, empty output catching, and error context injection
- **Direct scanning** — the orchestrator scans codebases itself, never delegates to subagents
- **ZFS mode** — Zellij-based per-agent pane workspace

## Error Recovery Architecture

### Silent Failure Prevention

| Failure Mode | Detection | Recovery |
|-------------|-----------|----------|
| Process crash (OOM/KILL) | Exit code -1 | CRITICAL alert + stderr logged |
| Empty output | exitCode === 0 && no output | WARNING logged, task marked failed |
| Non-zero exit | exitCode !== 0 | stderr captured, error context injected |
| Silent failures | Agent error recovery prompts | Agents instructed to self-correct |

### Retry Flow

```
Task fails → Orchestrator injects error context → Agent retries with full context
```

Error context includes:
- Previous stderr
- Review feedback (code + design)
- Previous output (what the agent tried)
- Original task description

## Fleet Agents

| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| **developer** | Implementation | read, write, edit, bash, grep, find, ls | Configurable |
| **tech-lead** | Architecture, code review | read, bash, grep, find, ls, subagent | Configurable |
| **designer** | Visual/UX review | read, bash, grep, find, ls | Vision-capable |
| **planner** | Project scoping | read, write, edit, bash, grep, find, ls | Configurable |
| **auditor** | Codebase analysis | read, write, edit, bash, grep, find, ls | Configurable |
| **documenter** | Documentation | read, write, edit, grep | Configurable |

Each agent's model is defined in `agents/<name>.md` — any model in your `models.json` works.

## Workflow

### New Project
1. Describe what you want to build (natural language)
2. `plan_project()` decomposes into phases/tasks
3. `/go` auto-orchestrates with review between phases
4. Review feedback auto-fixed, phases advance

### Existing Codebase
1. `/analyze` — direct scan → `ANALYSIS.md`
2. `plan_project()` or `/plan` → `PLAN.md`
3. `/go` — execute the plan
4. Monitor via widget bar or ZFS mode

## File Structure

```
caravel/
├── extensions/
│   └── caravel.ts          # Main orchestrator (~5,000 lines)
├── agents/
│   ├── developer.md        # Developer agent
│   ├── tech-lead.md        # Tech lead agent
│   ├── designer.md         # Designer agent
│   ├── planner.md          # Planner agent
│   ├── auditor.md          # Auditor agent
│   └── documenter.md       # Documenter agent
├── skills/
│   ├── analyze.md          # /analyze command
│   ├── plan.md             # /plan command
│   ├── grill.md            # /grill command
│   ├── progress.md         # Progress templates
│   ├── code-review.md      # Code review checklist
│   ├── design-review.md    # Design review checklist
│   ├── fleet-orchestration.md
│   └── zellij-fleet.md     # ZFS user guide
├── prompts/
│   └── task-brief.md       # Task brief template
├── zellij-layout.kdl       # ZFS workspace layout
├── zellij-fleet-config.md  # ZFS configuration guide
├── ANALYSIS.md             # Generated: codebase analysis
├── PROJECT-DESIGN.md       # Generated: architecture & design
├── PROJECT-PLAN.md         # Generated: implementation plan
├── PLAN.md                 # Generated: project phases/tasks
├── README.md               # User documentation
├── package.json            # Pi package manifest
└── SKILL.md                # Main skill (agent-facing)
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `/go` | Auto-run all phases with review |
| `/analyze` | Direct codebase scan → `ANALYSIS.md` |
| `/plan` | Generate project plan from analysis |
| `/fleet` | Toggle widget bar visibility |
| `/diagnose` | Structured error diagnosis |
| `/zellij-start` | Start ZFS mode |
| `/zellij-stop` | Stop ZFS mode |

## Configuration

1. Define agent models in `agents/*.md` (format: `<provider>/<model-id>`)
2. Ensure matching entries in `models.json`
3. Verify with `pi --list-models`
4. Start building with natural language or `/analyze`

---

> Design reference: [PROJECT-DESIGN.md](./PROJECT-DESIGN.md)
> Full analysis: [ANALYSIS.md](./ANALYSIS.md)
