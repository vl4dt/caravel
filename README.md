# Caravel

Fleet orchestration for Pi — multi-agent software development with supervisor-worker pattern, two-stage review loops, and ZFS (Zellij Fleet Session). Works with any model provider (local or cloud).

> **ZFS Mode:** Run your entire fleet inside a Zellij terminal multiplexer — per-agent panes, real-time output streaming, floating status bar, keyboard-driven control, and multi-monitor support.

## ZFS Mode — Zellij Fleet Session

Caravel can run the fleet inside a dedicated [Zellij](https://zellij.dev) terminal multiplexer. This gives you a full terminal workspace with per-agent panes, real-time stdout streaming, and keyboard-driven control.

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
│                            │  └────────────────────┘  │
└────────────────────────────┴──────────────────────────┘
```

### Starting ZFS Mode

```bash
# Install Zellij first:
#   macOS:  brew install zellij
#   Linux:  curl -LO https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz
#           tar xzf zellij-*.tar.gz && sudo mv zellij /usr/local/bin/
#   Windows: winget install Zellij.Zellij

# Start fleet in ZFS:
/zellij-start
```

### Layout Variants

| Layout | Use Case |
|--------|----------|
| `fleet` (default) | Full workspace — orchestrator + all agent tabs |
| `minimal` | Focused coding — orchestrator + developer only |
| `review` | Two-stage review — orchestrator + tech-lead + designer |
| `wide` | Side-by-side — orchestrator + developer + tech-lead |

Switch layouts during execution: `zellij action switch-layout <name>`

### ZFS Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+o` | Orchestrator (main pane) |
| `Ctrl+d` | Developer pane |
| `Ctrl+t` | Tech-lead pane |
| `Ctrl+D` | Designer pane |
| `Ctrl+p` | Planner pane |
| `Ctrl+a` | Auditor pane |
| `Ctrl+w` | Toggle status bar |
| `Ctrl+x` | Close pane |
| `Ctrl+s` | Save layout |
| `Ctrl+Shift+d` | Detach (leave running) |

### ZFS Commands (full list in [Commands section](#commands))

| Category | Command |
|----------|---------|
| Start/Stop | `/zellij-start` · `/zellij-stop` |
| Panes | `/zellij-panes` · `/zfs-list-panes` |
| Follow | `/zellij-follow [agent]` |
| Status | `/zellij-status` · `/zfs-fleet-state` · `/zfs-status-bar-toggle` |
| Control | `/zfs-pause` · `/zfs-resume` · `/zfs-skip-agent <name>` |
| Layout | `/zfs-layout` · `/zfs-status-bar-update` |

> **No ZFS?** Fleet falls back to background processes automatically.

## Architecture

Caravel implements a **supervisor-worker pattern with pipeline review loops**, based on recommended architectures from Azure Architecture Center and LangGraph research.

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

## Fleet Agents

Caravel runs agents in two modes:

### Pi Mode (default — no ZFS required)

| Agent | Role | Tools |
|-------|------|-------|
| **developer** | Coding, implementation, file manipulation | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| **tech-lead** | Architecture, planning, code quality review | `read`, `bash`, `grep`, `find`, `ls`, `subagent` |
| **designer** | Visual review, UI analysis, design quality (vision) | `read`, `bash`, `grep`, `find`, `ls` |

> Each agent's model is configurable in its `agents/*.md` file — any model in your `models.json` works, regardless of provider. The designer needs a vision-capable model (supports image input).

### ZFS Mode — Per-Agent Panes

In ZFS mode, each agent runs in its own terminal pane within the Zellij session:

| Pane | Role | Visibility |
|------|------|------------|
| `orchestrator` | Main fleet control — always visible (60% left) |
| `developer` | Code implementation — tabbed (right column) |
| `tech-lead` | Architecture review — tabbed |
| `designer` | Visual/UX review — tabbed |
| `planner` | Project scoping — optional |
| `auditor` | Pre-flight scan — optional |

The floating **status bar** (10 lines) shows all agent statuses, phase progress, token usage, and review state — auto-refreshed every 2 seconds.

## Installation

### Install from GitHub

```bash
# Clone the repo
git clone https://github.com/vl4dt/caravel.git
cd caravel
```

#### Linux / macOS

```bash
# Symlink agents and extension into your Pi config
ln -s "$(pwd)/agents" "$HOME/.pi/agent/agents"
ln -s "$(pwd)/extensions/caravel.ts" "$HOME/.pi/agent/extensions/caravel.ts"
```

#### Windows

```powershell
# Open PowerShell and run these commands from the cloned caravel directory

# Create the agents symlink (requires Admin privileges or Developer Mode enabled)
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.pi\agent\agents" -Target "$PWD\agents"

# Symlink the extension
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.pi\agent\extensions\caravel.ts" -Target "$PWD\extensions\caravel.ts"
```

> **Troubleshooting Windows symlinks:**
> - Run PowerShell as **Administrator** if you get "Access is denied"
> - Alternatively, enable Developer Mode: Settings → Privacy & Security → Developer Mode
> - If you don't have symlink permissions, just **copy** the files instead:
>   ```powershell
>   Copy-Item -Recurse agents "$env:USERPROFILE\.pi\agent\agents"
>   Copy-Item extensions\caravel.ts "$env:USERPROFILE\.pi\agent\extensions\"
>   ```

## Configuration

### 1. Define Agent Models

Each agent in `agents/*.md` has a `model` field that must match a model ID in your `~/.pi/agent/models.json`:

```yaml
# agents/developer.md
model: openai/gpt-4o
#              ^^^^^^^^  ^^^^^^^^^
#              provider   model ID
```

The format is: `<provider-name>/<model-id>` where `provider-name` matches the key in your `models.json` and `model-id` matches one of the models defined under that provider.

### 2. Your models.json Must Have Matching Entries

The agents reference three provider types by name. The names are just labels — you can use any provider. Here are examples of common setups:

**llama.cpp** (local inference server):
```json
{
  "llama.cpp": {
    "baseUrl": "http://localhost:9090/v1",
    "api": "openai-completions",
    "apiKey": "llama.cpp",
    "models": [
      { "id": "Qwen/Qwen3.6-35B-A3B-GGUF:Q8_0", "contextWindow": 262144 }
    ]
  }
}
```

**lm-studio** (local inference server):
```json
{
  "lm-studio": {
    "baseUrl": "http://localhost:1234/v1",
    "api": "openai-completions",
    "apiKey": "lmstudio",
    "compat": { "supportsDeveloperRole": false },
    "models": [
      {
        "id": "google/gemma-4-e4b",
        "input": ["text", "image"],
        "contextWindow": 128000
      }
    ]
  }
}
```

**Ollama** (local inference server):
```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434/v1",
    "api": "openai-completions",
    "apiKey": "ollama",
    "models": [
      { "id": "qwen3:8b" },
      { "id": "gemma4:e4b" }
    ]
  }
}
```

**Docker** (Docker-hosted inference server):
```json
{
  "docker-models": {
    "baseUrl": "http://localhost:12434/v1",
    "api": "openai-completions",
    "apiKey": "not-needed",
    "models": [
      { "id": "docker.io/ai/qwen3-coder:32k" }
    ]
  }
}
```

**Cloud providers** (OpenAI, Anthropic, Google, etc.) also work — just configure them in your `models.json` and reference them the same way.

### 3. Verify It Works

After configuring `models.json`, list available models:

```bash
pi --list-models
```

Then in your session, the caravel extension will auto-discover agents from your configured agent directory and use the models you've assigned.

### Need a Different Setup?

Any combination works. Here are some patterns:

| Setup | Developer Model | Tech Lead Model | Designer Model |
|-------|----------------|-----------------|----------------|
| All local | `llama.cpp/Qwen3:8b` | `llama.cpp/Qwen3:8b` | `lm-studio/gemma-4-e4b` |
| All Ollama | `ollama/qwen3:8b` | `ollama/qwen3:8b` | `ollama/gemma4:e4b` |
| All Docker | `docker-models/qwen3-coder:32k` | `docker-models/qwen3-coder:32k` | `docker-models/glm-4.7-flash:32k` |
| Mixed | `llama.cpp/Qwen3:8b` | `llama.cpp/Qwen3:8b` | `ollama/gemma4:e4b` |
| Cloud | `openai/gpt-4o` | `openai/gpt-4o` | `openai/gpt-4o-vision` |
| Any | *your choice* | *your choice* | *your choice* |

Just make sure the designer's model supports image input (`"input": ["text", "image"]`) for vision-based review.

## Usage

The entire workflow is **natural language** — you describe what you want, the main agent plans it, and the fleet executes. No TypeScript, no manual tool calls from your side.

### Start a Project (New Codebase)

Just describe what you want to build:

> **You:** "I want to build a kanban board app with drag-and-drop, multiple boards, and local storage."

The main agent will:
1. **Plan** — decompose your idea into phases and tasks using `plan_project`
2. **Execute** — run each phase with the `run_phase` tool, dispatching sub-agents
3. **Review** — auto-trigger `review_task` after each phase for code + design review
4. **Iterate** — fix review feedback, advance to the next phase

You can **watch** the fleet work via the dashboard and **interrupt** at any time.

### Take Over an Existing Codebase

Describe your goal for an existing project:

> **You:** "I want to add dark mode support to this existing React app."

The recommended workflow:

1. **Analyze** — run `/analyze` to produce `ANALYSIS.md` with:
   - **Pre-flight scan**: files/dirs count, detected languages, frameworks, entry points
   - **Agent & model metadata**: which agent ran, which model, tools available
   - **Execution stats**: elapsed time, turns, input/output/cache tokens, cost estimate
   - **Full analysis report** from the auditor agent
   - **Actionable error guidance** if anything failed

2. **Plan** — run `/plan` to convert the analysis into phases/tasks → `PLAN.md`

3. **Execute** — run `/go` to auto-orchestrate the fleet

If you want to skip analysis:
1. **Plan** — `plan_project()` directly if scope is clear
2. **Execute** — `/go` to run phases with review

### Run /go — Auto-Orchestrate the Fleet

Once a plan exists (via `plan_project` or the planner agent), launch the fleet:

> **You:** "go" / "launch the fleet" / "start building"

The `/go` command auto-orchestrates everything:
- Runs all phases sequentially
- Triggers review between each phase
- Auto-fixes review issues
- Reports progress

### Monitor the Fleet

Caravel monitors fleet progress through **two complementary views**:

#### Widget Bar (Pi Mode)

A persistent widget bar above the editor shows fleet status in real-time. It is always stable — never changes height or width:

**Idle:**
```
╔══════════════════════════════════════════════════════════════╗
║  CARAVEL FLEET  │  ● IDLE                                   ║
║  [░░░░░░░░░░░░░░░░░░░] 0%  │  5 agents configured  │  1h 12m║
║  last: idle — no active work yet                            ║
║  ● 0 reviews completed  │  Elapsed: 1h 12m                  ║
║  ▸ fleet: 0 tokens                                           ║
╚══════════════════════════════════════════════════════════════╝
```

**Running (shows per-task detail, agent models, and token counts):**
```
╔══════════════════════════════════════════════════════════════╗
║  CARAVEL FLEET  │  P1/3: Codebase Analysis  │  ▸ RUN       ║
║  [████████░░░░░░░░] 40%  │  2/5 tasks  │  1m 23s            ║
║  ▸ P1 [RUN] developer → llama.cpp/Qwen3.6  ▸ P2 [WAIT]     ║
║  2 reviews  │  Elapsed: 1m 23s                              ║
║  ▸ tokens: 12.3k/8.1k │ [developer(12.3/8.1)]              ║
╚══════════════════════════════════════════════════════════════╝
```

The widget bar shows:
- **Phase label** with status (RUN / REV / DONE / FAILED)
- **Progress bar** and task count
- **Per-task detail** during execution: task index, agent name, model, and status
- **Main agent activity** when idle (tool being called, path, time-ago)
- **Active agents** with model names and token counts
- **Fleet token totals** (input/output) for cost awareness

Toggle visibility:
```
/fleet          # Show/hide the widget bar
```

#### Status Bar (ZFS Mode)

When ZFS is active, the floating status bar replaces/augments the widget bar with a full 10-line dashboard:

```
╔══════════════════════════════════════════════════════════════╗
║         CARAVEL FLEET [ZFS MODE] │ P1/3                    ║
║  ● developer  ◉ tech-lead  ○ designer  │  3 agents        ║
║  P1/3: Implementation  [████████░░░░░░░░░░░░░░░░] 40%    ║
║  ▸ developer  [node]  Implement auth middleware            ║
║  ● idle — waiting for work                               ║
║  ● idle — waiting for work                               ║
║  ● idle — waiting for work                               ║
║  ▸ 12.5k / 3.2k  │  fleet: 45k tokens  │  2 reviews      ║
║  Elapsed: 3m 42s  │  ZFS                                ║
╚══════════════════════════════════════════════════════════════╝
```

| Feature | Description |
|---------|-------------|
| Agent grid | All agents' statuses (running▸/idle●/error✗) in one row |
| Phase info | Progress bar, task count, elapsed time |
| Per-agent detail | Name, model, current task, token usage |
| Token summary | Per-agent input/output + fleet total |
| Auto-refresh | Updates every 2 seconds |

Toggle with `Ctrl+w` in ZFS mode.

### Control the Fleet

You control the fleet through **natural commands** — the main agent handles the tool calls:

> **You:** "pause" / "pause the fleet"
> **You:** "resume" / "continue"
> **You:** "skip this phase" / "next phase"
> **You:** "reset" / "start over"
> **You:** "review this phase" / "run review"

The main agent translates these into `fleet_control` and `review_task` calls behind the scenes.

### Commands Reference

| Command | Description |
|---------|-------------|
| `/go` | Auto-run all phases with review between each |
| `/grill` | Relentlessly challenge your idea (requirements + plan) → produces SCOPE.md |
| `/analyze` | Analyze existing codebase (pre-flight scan, agent metadata, full report) |
| `/fleet` | Toggle the fleet widget bar visibility |
| `/diagnose` | Diagnose failed phases/tasks with structured root-cause analysis |
| `fleet_control(action="go")` | Auto-orchestrate fleet from code |
| `fleet_control(action="pause\|resume\|skip\|next\|reset")` | Manual fleet control |
| `plan_project(...)` | Define phases and tasks |
| `run_phase(phaseIndex=0)` | Execute a specific phase |
| `review_task(phaseIndex=0)` | Trigger code + design review |

For direct access, the following tools are available:

```javascript
fleet_control(action="pause|resume|skip|next|reset|go")
review_task(phaseIndex=0)                           // Full review (code + design)
review_task(phaseIndex=0, reviewType="code")        // Code review only
review_task(phaseIndex=0, reviewType="design")      // Design review only
review_task(phaseIndex=0, feedback="...")           // Manual feedback (bypasses auto-review)
```

These are for advanced use — you can invoke them from the agent if needed, but the default workflow uses natural language.

## Commands

### Fleet Commands

| Command | Description |
|---------|-------------|
| `/go` | Auto-run all phases with review between each |
| `/analyze` | Run a codebase analysis — produces `ANALYSIS.md` |
| `/plan` | Read `ANALYSIS.md` and generate `PLAN.md` |
| `/fleet` | Toggle the widget bar visibility |
| `/diagnose` | Diagnose failed phases/tasks |

### ZFS Commands (Zellij Mode)

| Command | Description |
|---------|-------------|
| `/zellij-start` | Launch fleet in ZFS (creates session, panes, status bar) |
| `/zellij-stop` | Shutdown the ZFS session |
| `/zellij-panes` | List all panes with status, IDs, and fleet state |
| `/zellij-follow [agent]` | Follow agent output — use `list`, `switch`, `none` too |
| `/zellij-status` | Comprehensive fleet overview dashboard |
| `/zfs-pause` | Pause all running panes (SIGSTOP) |
| `/zfs-resume` | Resume all paused panes (SIGCONT) |
| `/zfs-skip-agent <name>` | Skip/terminate a specific agent's pane |
| `/zfs-fleet-state` | ZFS health check (ZFS availability, panes, processes) |
| `/zfs-list-panes` | List all active and exited panes |
| `/zfs-status-bar-toggle` | Toggle the floating status bar on/off |
| `/zfs-status-bar-update` | Force refresh the floating status bar |
| `/zfs-layout --agents [...] --preview true` | Preview/generate fleet layout |

### Workflow: Taking Over an Existing Codebase

1. **Analyze** — run `/analyze` to scan the codebase and save `ANALYSIS.md`
2. **Plan** — run `/plan` to convert the analysis into a phased project plan (`PLAN.md`)
3. **Execute** — use `/go` to auto-orchestrate the fleet through the plan
4. **Monitor** — watch progress via the widget bar or `fleet_status`

### Workflow: Starting a New Project

1. **Describe** what you want to build (natural language)
2. **Plan** — the main agent decomposes your idea via `plan_project`
3. **Execute** — `/go` auto-orchestrates phases with review
4. **Iterate** — fix review feedback, advance to next phase

## File Structure

```
caravel/
├── SKILL.md              # Main skill (agent-facing guide)
├── package.json          # Pi package manifest
├── README.md             # This file (user-facing docs)
├── LICENSE
├── PROJECT-DESIGN.md     # Architecture & design overview
├── PROJECT-PLAN.md       # Project roadmap
├── ANALYSIS.md           # Generated: codebase analysis report
├── PLAN.md               # Generated: project plan with phases/tasks
├── zellij-layout.kdl     # ZFS fleet workspace layout (4 variants)
├── zellij-fleet-config.md# ZFS configuration guide (keybindings, layouts, multi-monitor)
├── examples/             # Example models.json configurations
│   ├── models-llama-cpp-lm-studio.json
│   ├── models-ollama.json
│   └── models-docker.json
├── extensions/
│   └── caravel.ts        # Main orchestrator (fleet tools, dashboard, ZFS — all inlined)
├── agents/
│   ├── developer.md      # Developer agent (configurable model)
│   ├── tech-lead.md      # Tech lead agent (configurable model)
│   ├── designer.md       # Designer agent (configurable model, needs vision)
│   ├── planner.md        # Conversational planner (interviews user, generates plans)
│   └── auditor.md        # Codebase analyzer (scans existing projects)
├── skills/
│   ├── analyze.md        # /analyze command
│   ├── plan.md           # /plan command
│   ├── grill.md          # /grill command — pre-plan stress test
│   ├── progress.md       # Progress feedback templates
│   ├── code-review.md    # Code review checklist
│   ├── design-review.md  # Design review checklist
│   ├── fleet-orchestration.md  # Auto-orchestration guidance
│   └── zellij-fleet.md   # ZFS user guide (workflows, shortcuts, troubleshooting)
└── prompts/
    └── task-brief.md     # Task brief template
```

### ZFS Files

| File | Lines | Purpose |
|------|-------|--------|
| `extensions/caravel.ts` | ~5,000 | Main orchestrator — includes inlined ZFS process manager (980 lines) and status bar (870 lines) |
| `zellij-layout.kdl` | 240 | Fleet workspace layout — default (60/40), minimal, review, wide variants |
| `zellij-fleet-config.md` | 280 | Configuration guide — installation, keybindings, multi-monitor, troubleshooting |
| `skills/zellij-fleet.md` | 734 | User documentation — workflows, keyboard shortcuts, layout variants, troubleshooting |

## How It Works

### Two-Stage Review

The review is a **quality gate** — both stages must pass for a task to be approved:

1. **Stage 1: Code Review (Tech Lead)**
   - Correctness, security, performance, architecture
   - Code quality, testing, maintainability

2. **Stage 2: Design Review (Designer)**
   - Layout, consistency, accessibility
   - UX, polish, visual quality

Either stage can return for fixes. The developer auto-fixes and resubmits. Loop continues until approved or max iterations (default: 5 fleet-wide, 3 per task).

### Per-Agent Model Selection

Each agent's model is defined in its `.md` file. The format is `<provider>/<model-id>` matching your `models.json`. You choose whichever provider and model works best for each agent's role.

### State Persistence

Fleet state persists across sessions via `pi.appendEntry`. Resume a session and the fleet state (phases, progress, review iterations) is restored automatically.

### Agent Discovery

Agents are discovered from two sources:
- **User agents**: `~/.pi/agent/agents/*.md` (system-wide)
- **Project agents**: `<project>/.pi/agents/*.md` (project-local, overrides user agents by name)

This means you can have default agents installed globally and override specific ones per project.

## Error Diagnosis

When phases or tasks fail, use `fleet_error_diagnosis` or `/diagnose` to get a structured diagnosis:

```javascript
fleet_error_diagnosis()
// or
/diagnose
```

The diagnosis covers:
- **Missing agents** — which agent is needed and how to create it
- **Exit codes** — what non-zero codes mean and how to debug
- **stderr content** — pattern-matched against known error types (permissions, timeouts, network errors)
- **Token limits** — context window exceeded, budget overflows
- **Rate limits** — API rate limiting from the provider
- **Authentication** — invalid/expired API keys
- **Model errors** — invalid model names or unavailable models
- **Review loop exhaustion** — when reviews fail repeatedly

Each cause includes: severity level (critical/warning/info), affected phase/task, root cause explanation, and step-by-step fix instructions.

### Analyze Command

The `/analyze` command now provides a rich pre-flight scan and metadata report:

```
✅ Codebase Analysis Complete

▸ Agent & Model
  • Agent: auditor
  • Model: llama.cpp/Qwen3.6-35B
  • Tools: read,write,edit,bash,find

▸ Execution
  • Elapsed: 45s
  • Turns: 3
  • Input Tokens: 12,340
  • Output Tokens: 8,920
  • Total Tokens: 21,260
  • Cost: $0.0003

▸ Pre-Flight Scan
  ○ Total Files: 247
  ○ Directories: 38
  ○ Config Files: 12
  ○ Test Infrastructure: ✓ Detected
  ○ CI/CD Pipeline: ✗ Not detected
  ○ Languages: TypeScript
  ○ Frameworks: React, Next.js
  ○ Build Tools: Vite
  ○ Entry Points: index.tsx, server.ts, cli.ts
```

On failure:
```
⚠️ Analysis Encountered Issues

▸ Errors
  ✗ Exit code: 1
  ✗ Subagent exited with non-zero code

💡 Suggestions
  → Check that the agent's dependencies and model are properly configured
  → Run the agent manually with 'pi --model <model> <task>' to debug
```

## ZFS Workflow

### Quick Start

```bash
# 1. Install Zellij
brew install zellij              # macOS
# or: curl -LO https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz
# or: winget install Zellij.Zellij  # Windows

# 2. Start the fleet in ZFS
/zellij-start

# 3. Describe your project in the orchestrator pane
"Build a kanban board with drag-and-drop"

# 4. Monitor everything in real-time
/zellij-status   # Fleet overview
/zellij-follow developer  # Follow the developer's live output
```

### ZFS vs Pi Mode

| Feature | Pi Mode | ZFS Mode |
|---------|---------|----------|
| Installation | None | Requires Zellij |
| Per-agent panes | ❌ | ✅ (4+ panes) |
| Real-time streaming | Widget bar only | Per-pane stdout |
| Keyboard navigation | Widget bar | Full terminal |
| Multi-monitor | ❌ | ✅ |
| Detach & resume | ❌ | ✅ (`Ctrl+Shift+d`) |
| Status bar | 6-line widget | 10-line floating |
| Fallback | — | Background processes |

### Monitoring Agent Panes

```bash
# List all panes with status
/zfs-list-panes

# Follow a specific agent's live output
/zellij-follow developer

# See the fleet overview dashboard
/zellij-status

# Check ZFS health
/zfs-fleet-state

# Change layout during execution
zellij action switch-layout minimal   # Focused coding
zellij action switch-layout review    # Two-stage review
zellij action switch-layout wide      # Side-by-side
```

### Full ZFS Workflow

```bash
# ── Start ──
/zellij-start                     # Create session + panes + status bar

# ── Execute ──
plan_project(...)                 # Define phases
/zfs-list-panes                   # Verify panes are running
run_phase(phaseIndex=0)           # Agent works in dedicated pane

# ── Monitor ──
/zellij-follow developer          # Watch live output
/zfs-status-bar-update            # Force refresh status bar
/zfs-pause                        # Pause all agents (SIGSTOP)
/zfs-resume                       # Resume all agents (SIGCONT)

# ── Review ──
zellij action switch-layout review  # Switch to review layout
review_task(phaseIndex=0)           # Two-stage review

# ── Complete ──
zfs_cleanup                         # Terminate all panes + session
```

## Customization

### Adding New Agents

Create a new file in `agents/`. The name must match the `agent` field used in `plan_project`:

```yaml
---
name: qa-engineer
description: Quality assurance specialist for testing
model: ollama/qwen3:8b
tools: read,bash,grep,find,ls
---

You are a QA Engineer...
```

### Adding Custom Skills

Skills are loaded on-demand when the agent encounters matching context. Add new `.md` files in `skills/` using the Agent Skills specification.

### Custom Prompt Templates

Add templates to `prompts/` — use with `/templatename` in the editor.

## Research & References

- [Azure Architecture Center: AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [LangGraph: Multi-Agent Orchestration](https://langchain-ai.github.io/langgraph/)
- [Multi-Agent Orchestration Patterns (Fast.io)](https://fast.io/resources/multi-agent-orchestration-patterns/)
- [AI Agent Architecture Patterns (CodeLit)](https://codelit.io/blog/ai-agent-architecture-patterns)

## License

MIT
