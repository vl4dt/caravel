# Caravel Test Battery

> Comprehensive test battery for validating all Caravel capabilities, comparing models, and learning the platform through guided projects.

## Quick Start

```bash
# List all scenarios
npx ts-node tests/test-runner.ts --list

# Read a scenario guide (shows phases, tasks, acceptance criteria)
npx ts-node tests/test-runner.ts --guide S1

# Run a single scenario
npx ts-node tests/test-runner.ts S1

# Run all scenarios
npx ts-node tests/test-runner.ts
```

## Scenario Categories

### Tier 1 — Foundational (Beginner)

| ID | Scenario | Complexity | Purpose |
|----|----------|------------|---------|
| S1 | Basic Fleet Orchestration | ★☆☆☆☆ | Core pipeline: plan → execute → review → complete |
| S2 | Design Review Pipeline | ★★☆☆☆ | UI-focused: design tokens, responsive, accessibility |
| S3 | Logic Error Detection | ★★☆☆☆ | Backend: catch bugs, missing imports, stubs, type errors |
| S4 | Documentation Generator | ★☆☆☆☆ | Documenter agent: write, maintain, audit docs |

### Tier 2 — Intermediate

| ID | Scenario | Complexity | Purpose |
|----|----------|------------|---------|
| S5 | Full-Stack Application | ★★★★★ | ALL features: all agents, reviews, metrics, integrations |
| S6 | Metrics & Integrations | ★★★☆☆ | Metrics collection, Telegram/Linear/Plane integrations |
| S7 | Documentation-Heavy Project | ★★★☆☆ | Docs-centric: OpenAPI parser, static site, audit |

### Tier 3 — Advanced (Benchmarking)

| ID | Scenario | Complexity | Purpose |
|----|----------|------------|---------|
| S8 | State Persistence | ★★★★☆ | Pause/resume, state serialization, recovery |
| S9a | Benchmark: Code Generation | ★★★★★ | Compare models on code quality |
| S9b | Benchmark: Code Review | ★★★★★ | Compare models on bug detection |
| S9c | Benchmark: Design Review | ★★★★★ | Compare models on design analysis |
| S10 | ZFS Migration | ★★★★☆ | Background mode, ZFS migration |

## Feature Coverage

```
Feature                  │ S1 │ S2 │ S3 │ S4 │ S5 │ S6 │ S7 │ S8 │ S9a │ S9b │ S9c │ S10
─────────────────────────┼────┼────┼────┼────┼────┼────┼────┼────┼─────┼─────┼─────┼─────
Basic Fleet              │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Two-Stage Review         │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Code Review (Logic)      │    │    │ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │     │ ███
Design Review            │    │ ███│ ███│    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Metrics Collection       │    │    │    │    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Telegram Integration     │    │    │    │    │    │ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Documenter Agent         │    │    │    │ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Pause/Resume             │    │    │    │    │    │    │    │ ███│ ███ │ ███ │ ███ │ ███
Cross-Model Benchmark    │    │    │    │    │    │    │    │    │ ███ │ ███ │ ███ │
Testability Enforcement  │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Gate Checks              │ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Logic Error Detection    │    │    │ ███│ ███│ ███│ ███│ ███│ ███│ ███ │ ███ │     │ ███
Design Token Checks      │    │ ███│    │    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
Responsive Verification  │    │ ███│    │    │ ███│ ███│ ███│ ███│ ███ │ ███ │ ███ │ ███
```

## Running Benchmarks

To compare models:

1. **Set model in agent config** (`agents/developer.md`, `agents/tech-lead.md`, `agents/designer.md`):
   ```markdown
   model: docker-models/docker.io/ai/qwen3-coder:32k
   ```

2. **Run the benchmark scenario**:
   ```bash
   npx ts-node tests/test-runner.ts S9a   # Code Generation
   npx ts-node tests/test-runner.ts S9b   # Code Review
   npx ts-node tests/test-runner.ts S9c   # Design Review
   ```

3. **Change the model** and rerun to compare scores.

4. **Review results** in `tests/RESULTS.md`.

## Testability Criteria

Every scenario enforces the three testability criteria:

1. **Test files or verification commands** — explicit test steps
2. **Acceptance criteria** — clear "Done when..." conditions
3. **Measurable outcome** — quantifiable success metrics

## How to Use as Tutorials

Each scenario in `SCENARIOS.md` is a complete tutorial:

1. **Copy** the `plan_project()` call from the scenario
2. **Paste** it into the Pi chat
3. **Run** `fleet_control(action = "go")`
4. **Watch** the fleet execute
5. **Verify** the acceptance criteria

## Adding New Scenarios

1. Add the scenario to `SCENARIOS.md` with full details
2. Add the scenario to `SCENARIOS` object in `test-runner.ts`
3. Run `npx ts-node tests/test-runner.ts --list` to verify

## Requirements

- **Docker** — for running docker-models
- **Node.js 18+** — for running the test runner
- **Pi v0.74+** — with caravel.ts extension installed
