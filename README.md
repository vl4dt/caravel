# Caravel

Fleet orchestration for Pi — multi-agent software development with supervisor-worker pattern and two-stage review loops. Works with any model provider (local or cloud).

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

| Agent | Role | Tools |
|-------|------|-------|
| **developer** | Coding, implementation, file manipulation | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| **tech-lead** | Architecture, planning, code quality review | `read`, `bash`, `grep`, `find`, `ls`, `subagent` |
| **designer** | Visual review, UI analysis, design quality (vision) | `read`, `bash`, `grep`, `find`, `ls` |

> Each agent's model is configurable in its `agents/*.md` file — any model in your `models.json` works, regardless of provider. The designer needs a vision-capable model (supports image input).

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

### Monitor the Widget Bar

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

| Command | Description |
|---------|-------------|
| `/analyze` | Run a codebase analysis — produces `ANALYSIS.md` with pre-flight scan, tech stack, dependencies, architecture, technical debt, and recommendations |
| `/plan` | Read `ANALYSIS.md` (or `PROJECT-DESIGN.md`) and generate `PLAN.md` with phases and tasks |
| `/go` | Auto-run all phases with review between each |
| `/fleet` | Toggle the fleet widget bar visibility |
| `/diagnose` | Diagnose failed phases/tasks with structured root-cause analysis |

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
├── SKILL.md              # Main skill for the main agent (agent-facing guide)
├── package.json          # Pi package manifest
├── README.md             # This file (user-facing documentation)
├── LICENSE
├── PROJECT-DESIGN.md     # Dashboard design architecture doc
├── PROJECT-PLAN.md       # Project roadmap and assessment
├── ANALYSIS.md           # Generated: codebase analysis report (from /analyze)
├── PLAN.md               # Generated: project plan with phases and tasks (from /plan)
├── examples/             # Example models.json configurations
│   ├── models-llama-cpp-lm-studio.json
│   ├── models-ollama.json
│   └── models-docker.json
├── extensions/
│   └── caravel.ts        # Orchestrator (7 tools, rich dashboard, subagent spawning, error diagnosis)
├── agents/
│   ├── developer.md      # Developer agent (configurable model)
│   ├── tech-lead.md      # Tech lead agent (configurable model)
│   ├── designer.md       # Designer agent (configurable model, needs vision)
│   ├── planner.md        # Conversational planner (interviews user, generates plans)
│   └── auditor.md        # Codebase analyzer (scans existing projects)
├── skills/
│   ├── analyze.md        # /analyze command — run codebase analysis, produce ANALYSIS.md
│   ├── plan.md           # /plan command — read analysis/design docs, produce PLAN.md
│   ├── progress.md       # Progress feedback templates for all phase types
│   ├── code-review.md    # Code review checklist for tech-lead
│   ├── design-review.md  # Design review checklist for designer
│   └── fleet-orchestration.md  # Auto-orchestration guidance for the main agent
└── prompts/
    └── task-brief.md     # Task brief template
```

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
