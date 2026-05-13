# Fleet Metrics Specification

## Overview

This document defines all metrics collected by the Caravel fleet metrics system (`metrics.ts`).

## Core Metrics

### Task Metrics

| Metric Name | Unit | Description | Labels |
|-------------|------|-------------|--------|
| `task_duration` | ms | Time from task start to completion | `phase`, `agent`, `status` |
| `task_tokens` | tokens | Total tokens used by agent for this task | `phase`, `agent`, `status` |
| `task_input_tokens` | tokens | Input tokens consumed | `phase`, `agent`, `status` |
| `task_output_tokens` | tokens | Output tokens produced | `phase`, `agent`, `status` |
| `review_count` | count | Number of review cycles for this task | `phase`, `agent`, `status` |
| `code_review_result` | binary | 1=approved, 0=rejected | `phase`, `agent`, `status` |
| `design_review_result` | binary | 1=approved, 0=rejected | `phase`, `agent`, `status` |

### Phase Metrics

| Metric Name | Unit | Description | Labels |
|-------------|------|-------------|--------|
| `phase_duration` | ms | Time from first task start to last task complete | `phase`, `phaseName`, `status` |
| `completed_phases` | phases | Count of completed phases | `scope=fleet` |
| `failed_phases` | phases | Count of failed phases | `scope=fleet` |

### Fleet Metrics

| Metric Name | Unit | Description | Labels |
|-------------|------|-------------|--------|
| `total_fleet_tokens` | tokens | Total tokens across all agents and tasks | `scope=fleet` |
| `review_iterations` | iterations | Total review cycles | `scope=fleet` |
| `completed_tasks` | tasks | Count of completed tasks | `scope=fleet` |
| `pending_tasks` | tasks | Count of pending/remaining tasks | `scope=fleet` |

## Formulas

### Average Task Duration
```
avg_task_duration = sum(task_duration) / count(task_duration)
```

### Task Duration by Agent
```
avg_by_agent[agent] = sum(task_duration where agent=X) / count(task_duration where agent=X)
```

### Pass Rate
```
code_review_pass_rate = sum(code_review_result) / count(code_review_result)
design_review_pass_rate = sum(design_review_result) / count(design_review_result)
overall_pass_rate = (code_pass + design_pass) / (code_total + design_total)
```

### Cost Estimation
```
token_cost = total_fleet_tokens * cost_per_token
task_cost = sum(task_tokens) * cost_per_token
```

### Velocity
```
tasks_per_phase = completed_tasks / count(completed_phases)
tokens_per_task = total_fleet_tokens / completed_tasks
```

## Output Formats

### JSON
Structured output with summaries, per-label breakdowns, and all data points:
```json
{
  "startedAt": "2026-05-13T10:00:00.000Z",
  "now": "2026-05-13T12:00:00.000Z",
  "elapsed": 7200000,
  "elapsedFormatted": "2h 0m",
  "summaries": [...],
  "totalPoints": 150,
  "metrics": [...]
}
```

### CSV
Spreadsheet-compatible format with headers:
```
name,value,unit,timestamp,labels
task_duration,37200,ms,2026-05-13T10:05:00.000Z,{"phase":"P1","agent":"developer","status":"complete"}
task_tokens,127000,tokens,2026-05-13T10:05:00.000Z,{"phase":"P1","agent":"developer","status":"complete"}
```

## Usage

```typescript
import { createFleetMetrics, collectMetric } from "./metrics";

// Collect individual metrics
collectMetric("task_duration", 37200, "ms", {
  phase: "P1",
  agent: "developer",
  task: "t1",
  status: "complete",
});

// Generate aggregate metrics
const metrics = createFleetMetrics(fleetState, startTime);
await metrics.saveToFile(process.cwd());
```

## Export

Metrics are saved to `.caravel/metrics-{timestamp}.json` and `.caravel/metrics-{timestamp}.csv` automatically when `saveToFile()` is called.
