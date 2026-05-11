# Caravel

Fleet orchestration for Pi — multi-agent software development with local-only models.

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

| Agent | Model | Provider | Role |
|-------|-------|----------|------|
| **developer** | Qwen3.6-35B-A3B (Q8_0) | llama.cpp | Coding, implementation, file manipulation |
| **tech-lead** | Qwen3.6-35B-A3B (Q8_0) | llama.cpp | Architecture, planning, code review |
| **designer** | Gemma 4 | lm-studio | Visual review, UI analysis, design quality |

All models run locally. Zero cloud dependencies.

## Installation

```bash
# Project-local (recommended)
pi install -l git:github.com/your-user/pi-caravel

# Or clone and link
cd D:/Lab/caravel
pi install .
```

## Agent Configuration

After installation, the agent definition files (`.md` in `agents/`) are included in the package.

To use them, copy or symlink the agents to your project's agent directory:

```bash
# For a new project
cp -r agents/ .pi/agents/

# Or symlink (recommended for development)
ln -s ../../caravel/agents .pi/agents
```

Agents are discovered automatically by the caravel extension from `~/.pi/agents/` (global) or `.pi/agents/` (project-local).

## Usage

### Quick Start

```
plan_project(
  name="My App",
  phases=[
    {
      name: "Setup",
      tasks: [
        {agent: "developer", task: "Initialize the project..."},
      ]
    },
  ]
)

run_phase(phaseIndex=0)
review_task(phaseIndex=0)
```

### Fleet Dashboard

```
/fleet          # Open dashboard overlay
/fleet-toggle   # Toggle open/close
```

Dashboard panels:
- **TASKS**: phases, tasks, and progress
- **AGENTS**: agent status and assignments
- **REVIEW**: review flow and feedback
- **TERMINAL**: recent output

### Fleet Control

```
fleet_control(action="pause|resume|skip|next|reset")
```

## File Structure

```
caravel/
├── SKILL.md              # Main skill definition for the agent
├── package.json          # Pi package manifest
├── README.md             # This file
├── extensions/
│   └── caravel.ts        # Orchestrator extension (tools, dashboard, state)
├── agents/
│   ├── developer.md      # Developer agent definition
│   ├── tech-lead.md      # Tech lead agent definition
│   └── designer.md       # Designer/Vision agent definition
├── skills/
│   ├── code-review.md    # Structured code review checklist
│   └── design-review.md  # Visual design review checklist
└── prompts/
    └── task-brief.md     # Task brief template
```

## How It Works

### Supervisor Pattern

The main agent acts as supervisor — it plans projects, routes tasks to the right agent, and validates outputs. This is the recommended pattern for structured software development.

### Pipeline with Feedback Loops

Tasks flow through a pipeline:
1. Developer implements
2. Designer reviews (vision)
3. If issues: Developer fixes
4. Designer reviews again
5. Repeat until approved or max iterations

### Per-Agent Model Selection

Each agent has its own model defined in its `.md` file:
- Developer uses llama.cpp Qwen3.6-35B (coding power)
- Tech Lead uses llama.cpp Qwen3.6-35B (reasoning power)
- Designer uses lm-studio Gemma 4 (vision capability)

This lets you optimize: coding gets a large model, vision gets a vision model.

### State Persistence

Fleet state persists across sessions via `pi.appendEntry`. Resume a session and the fleet state is restored automatically.

## Customization

### Adding New Agents

Create a new file in `agents/`:

```yaml
---
name: qa-engineer
description: Quality assurance specialist for testing
model: llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q8_0
tools: read,bash,grep,find,ls
---

You are a QA Engineer...
```

### Custom Models

Edit `agents/*.md` to change the model per agent. Any model configured in your `models.json` works.

### Custom Skills

Skills are loaded on-demand when the agent encounters matching context. Edit or add new skills in the `skills/` directory.

## Research & References

- [Azure Architecture Center: AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [LangGraph: Multi-Agent Orchestration](https://langchain-ai.github.io/langgraph/)
- [Multi-Agent Orchestration Patterns (Fast.io)](https://fast.io/resources/multi-agent-orchestration-patterns/)
- [AI Agent Architecture Patterns (CodeLit)](https://codelit.io/blog/ai-agent-architecture-patterns)

## License

MIT
