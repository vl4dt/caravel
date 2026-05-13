# Parallel Execution Assessment

**Date**: 2026-05-12
**Status**: Assessment — not implemented

## Current State

Caravel executes tasks **sequentially** within each phase. Core loop is a `for...of` with `await` per task (`runPhaseInternal()`, line ~2126 in caravel.ts).

```js
for (const task of phase.tasks) {
  const result = await runSubagent(agentDef, task.description, ...);
}
```

## Benefits of Parallel Execution

| Benefit | When it matters |
|---|---|
| **Wall-clock speedup** | Independent tasks (e.g., designer + tech-lead working on different files) |
| **Cloud API parallelism** | With cloud providers, each agent streams independently without contending for one LLM context |
| **Fail-fast isolation** | If agent A crashes, B and C keep running — don't lose the whole phase |
| **Better UX** | Multiple panes alive, active tokens ticking — feels more "alive" |

## Drawbacks

| Drawback | Severity | Notes |
|---|---|---|
| **Context overflow** | HIGH | 2-3 concurrent agents each consuming context can blow past model limits |
| **Token cost** | HIGH | N parallel = N×API calls. A failing phase wastes all parallel payments |
| **Dependency ambiguity** | MEDIUM | Without explicit deps, Caravel can't know which tasks must wait |
| **Resource contention** | HIGH for local | Parallel spawns compete for RAM/VRAM on the same machine |
| **Output interleaving** | LOW | Follow mechanism captures per-agent buffers, user must actively switch |

## User's Constraints

```
Local LLM (1-2 context slots)  →  Cloud API (parallel OK)
       ↓                              ↓
  Parallelism helps very little     Parallelism helps a lot
```

With local LLMs, spawning more agents than the model can serve creates a queue of dead processes — they all spawn, try to connect, and the LLM picks one. Others time out or get garbage output.

With cloud providers, the bottleneck is API rate limit, not context. Parallelism gives real speedup.

## Recommended Approach: Hybrid

1. **Sequential by default** — safe for local LLMs, no overflow risk
2. **Explicit opt-in parallelism** per task via `dependsOn?: string[]` + `parallel: true` flag
3. **Per-agent model override** — each task declares model source (`local` or `cloud`). Caravel routes parallel tasks to cloud only
4. **Phases become dependency graphs** — topological sort runs tasks in batches, each batch is `Promise.all()` of independent tasks

### Benefits of this approach

- ✅ Safe local LLM usage (no parallelism by default)
- ✅ Cloud parallelism when you want it
- ✅ Explicit dependencies (no hidden ordering bugs)
- ✅ No context overflow (Caravel controls concurrency window)

## Data Model Sketch

### FleetPhase (extended)

```ts
interface FleetPhase {
  id: string;
  name: string;
  description: string;
  status: "idle" | "running" | "complete" | "failed" | "reviewing";
  tasks: FleetTask[];
  // New:
  parallelMode?: boolean;  // default: false — enables batch execution within this phase
}
```

### FleetTask (extended)

```ts
interface FleetTask {
  id: string;
  agentName: string;
  status: "todo" | "running" | "complete" | "needs_fix" | "failed" | "skipped" | "waiting";
  description: string;
  output?: string;
  stderr?: string;
  agentModel?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  messageCount?: number;
  codeReviewStatus?: string;
  designReviewStatus?: string;
  // New fields:
  dependsOn?: string[];      // task IDs that must complete before this starts
  parallel?: boolean;          // opt-in for this task (overrides phase parallelMode)
  modelSource?: "local" | "cloud"; // hint for which LLM backend to use
}
```

### Execution Algorithm

```
runPhase(phase):
  if parallelMode:
    // Build dependency graph
    graph = buildDAG(phase.tasks)
    batches = topologicalSort(graph)  // groups of mutually independent tasks
    
    for batch in batches:
      promises = batch.tasks.map(t => runTask(t))
      results = await Promise.allSettled(promises)  // don't fail fast
      
      for each result:
        updateTaskStatus(result)
        if any failed → mark dependent tasks as "waiting" or "failed"
        
  else:
    // Sequential (current behavior)
    for task in phase.tasks:
      result = await runTask(task)
      updateTaskStatus(result)

// DAG helpers
buildDAG(tasks):
  return Map<taskId, { task, dependencies: [taskId] }>

topologicalSort(graph):
  // Kahn's algorithm
  // Returns batches where each batch contains tasks with no unresolved deps
  batches = []
  ready = tasks with no dependencies
  while ready:
    batches.push(ready)
    nextReady = tasks whose all deps are in completed batches
    ready = nextReady
  return batches

runTask(task):
  // Resolve dependencies
  depStatus = checkDependsOn(task.dependsOn)
  if any dep failed:
    task.status = "failed"
    return { failed: true }
  if any dep waiting (pending parallel):
    task.status = "waiting"
    return waitForDep()
  // Execute
  result = await runSubagent(task.agentName, task.description, ...)
  task.status = result.exitCode === 0 ? "complete" : "failed"
  task.output = result.output
  task.stderr = result.stderr
  task.tokensUsed = result.tokens
  return result
```

### Key Design Decisions

1. **`Promise.allSettled` not `Promise.all`** — one failure shouldn't abort the whole batch
2. **`dependsOn` is explicit** — no implicit "run before next task in array" magic
3. **`modelSource` is advisory** — tells Caravel "prefer cloud for this" when parallel mode is on
4. **Batch-level failures cascade** — if T1 fails, T2 (depends on T1) becomes "failed" or "waiting" depending on whether the agent can handle missing upstream output

### UI Implications

- Task status `waiting` needs a visual indicator (e.g., `◷`)
- Phase status `running` during parallel batches should show batch progress: "Batch 2/3 — 3 agents running"
- Error messages for failed dependencies should list which upstream task failed

## Open Questions

- Should `dependsOn` support conditional deps (e.g., "run T2 only if T1 succeeded")?
- Should there be a max concurrency limit per phase (e.g., max 2 parallel regardless of DAG)?
- Should the widget show per-batch progress or per-task progress?
- Should task output from a parallel batch be merged or kept separate?
- How should review_task handle a parallel batch where only one task is "complete"?
