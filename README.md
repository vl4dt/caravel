# Caravel

Fleet orchestration for Pi — multi-agent software development with supervisor-worker pattern, two-stage review loops, and a non-blocking fleet dashboard. Works with any model provider (local or cloud).

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

The main agent will:
1. **Analyze** — scan the existing codebase structure, tech stack, and dependencies
2. **Plan** — create incremental phases that build on what exists
3. **Execute** — run phases with the fleet, reviewing at each step

Or manually run `/analyze` to get a detailed codebase analysis report first.

### Run /go — Auto-Orchestrate the Fleet

Once a plan exists (via `plan_project` or the planner agent), launch the fleet:

> **You:** "go" / "launch the fleet" / "start building"

The `/go` command auto-orchestrates everything:
- Runs all phases sequentially
- Triggers review between each phase
- Auto-fixes review issues
- Reports progress

### Monitor the Dashboard

Open the fleet dashboard to watch progress in real-time:

```
/fleet          # Toggle fleet dashboard
```

The dashboard has two layers:
- **Widget bar**: Always-visible compact progress bar above the editor (updates every 3 seconds)
- **Overlay**: Rich detail panel (bottom-right, non-capturing) with tabs for TASKS, AGENTS, REVIEW, TERMINAL

Keyboard shortcuts in the overlay:
- **Tab / Shift+Tab**: switch panels
- **Up/Down**: navigate items
- **Space**: pause/resume fleet
- **P**: skip current phase
- **Esc**: close overlay

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
| `/analyze` | Analyze existing codebase (structure, tech stack, dependencies) |
| `/fleet` | Toggle the fleet dashboard |
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

## File Structure

```
caravel/
├── SKILL.md              # Main skill for the main agent (agent-facing guide)
├── package.json          # Pi package manifest
├── README.md             # This file (user-facing documentation)
├── LICENSE
├── PROJECT-DESIGN.md     # Dashboard design architecture doc
├── PROJECT-PLAN.md       # Project roadmap and assessment
├── examples/             # Example models.json configurations
│   ├── models-llama-cpp-lm-studio.json
│   ├── models-ollama.json
│   └── models-docker.json
├── extensions/
│   └── caravel.ts        # Orchestrator (5 tools, non-blocking dashboard, subagent spawning)
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
