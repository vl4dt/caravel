# Caravel

Fleet orchestration for Pi — multi-agent software development with supervisor-worker pattern and two-stage review loops.

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

| Agent | Role |
|-------|------|
| **developer** | Coding, implementation, file manipulation |
| **tech-lead** | Architecture, planning, code review |
| **designer** | Visual review, UI analysis, design quality |

> Each agent's model is configurable — any model in your `models.json` works, regardless of provider.

## Installation

```bash
# Project-local (recommended)
pi install -l git:github.com/vl4dt/caravel

# Or clone and symlink
git clone https://github.com/vl4dt/caravel.git
ln -s ./caravel/agents .pi/agents
ln -s ./caravel/extensions/caravel.ts .pi/extensions/caravel.ts
```

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
    "baseUrl": "http://10.0.0.1:9090/v1",
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
    "baseUrl": "http://10.0.0.2:1234/v1",
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
    "baseUrl": "http://10.0.0.1:11434/v1",
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

Then in your session, the caravel extension will auto-discover agents from `.pi/agents/` and use the models you've assigned.

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
- **TASKS**: phases, tasks, and progress (with review status indicators)
- **AGENTS**: agent roster, models, and current assignments
- **REVIEW**: two-stage review flow, code/design summaries, iteration tracking
- **TERMINAL**: recent agent output (live terminal)

### Fleet Control

```
fleet_control(action="pause|resume|skip|next|reset")
```

## File Structure

```
caravel/
├── SKILL.md              # Main skill for the main agent
├── package.json          # Pi package manifest
├── README.md             # This file
├── LICENSE
├── examples/             # Example models.json configurations
│   ├── models-llama-cpp-lm-studio.json
│   ├── models-ollama-only.json
│   └── models-docker-only.json
├── extensions/
│   └── caravel.ts        # Orchestrator (5 tools, dashboard, subagent spawning)
├── agents/
│   ├── developer.md      # Developer agent (configurable model)
│   ├── tech-lead.md      # Tech lead agent (configurable model)
│   └── designer.md       # Designer agent (configurable model, needs vision)
├── skills/
│   ├── code-review.md    # Code review checklist
│   └── design-review.md  # Design review checklist
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

Either stage can return for fixes. The developer auto-fixes and resubmits. Loop continues until approved or max iterations (default: 3 per task).

### Per-Agent Model Selection

Each agent's model is defined in its `.md` file. The format is `<provider>/<model-id>` matching your `models.json`. You choose whichever provider and model works best for each agent's role.

### State Persistence

Fleet state persists across sessions via `pi.appendEntry`. Resume a session and the fleet state (phases, progress, review iterations) is restored automatically.

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
