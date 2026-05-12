---
name: progress
description: Emit structured status messages during every phase of fleet execution. Each phase type (analyze, plan, build, review) has a feedback template so users always see progress, never silence. Use when running /analyze, /plan, /go, code-review, or any multi-step operation.
---

# Progress Feedback Skill

## Purpose

Ensure every fleet operation produces **visible, structured progress updates** so the user never wonders what's happening. This skill defines a feedback template for each phase type and a convention for when to emit each message.

## Phase Types & Feedback Templates

### 1. `analyze` — Scanning & Audit Phase

Use when the fleet is examining the codebase, architecture, or existing state.

**Emitted at:**

- Before scanning starts
- After each major scan step completes
- When the analysis is complete

**Template:**

```
🔍 Analyze: <short description>
  Scope: <what is being scanned — e.g., "project structure", "tech stack", "test coverage">
  Status: <pending | in-progress | complete>
  Detail: <1-line summary — e.g., "Found 14 modules, 3 critical debt items">
```

**Example — start:**

```
🔍 Analyze: Codebase audit
  Scope: project structure, dependencies, architecture, test gaps
  Status: in-progress
  Detail: Scanning directory layout and key files...
```

**Example — step complete:**

```
🔍 Analyze: Dependency audit
  Scope: production & dev dependencies
  Status: complete
  Detail: Found 42 packages — 3 out of date, 2 with known vulnerabilities
```

**Example — final:**

```
🔍 Analyze: Codebase audit — complete
  Scope: project structure, dependencies, architecture, test gaps
  Status: complete
  Result: 3 critical, 5 important, 2 low-priority debt items found
  Artifact: ANALYSIS.md
```

---

### 2. `plan` — Planning & Structuring Phase

Use when the fleet is creating a project plan, breaking work into phases and tasks.

**Emitted at:**

- Before reading source documents
- After each phase is derived
- When the plan is finalized

**Template:**

```
📋 Plan: <short description>
  Phase: <N / total — e.g., "Phase 2 of 4">
  Status: <pending | in-progress | complete>
  Detail: <1-line summary — e.g., "Defined 6 tasks, 2 dependencies">
```

**Example — start:**

```
📋 Plan: Project roadmap generation
  Phase: 0 of 0
  Status: in-progress
  Detail: Reading ANALYSIS.md and PROJECT-DESIGN.md...
```

**Example — each phase:**

```
📋 Plan: Phase 1 — Environment Setup
  Phase: 1 of 4
  Status: complete
  Detail: 3 tasks defined — install deps, configure linting, set up tests
```

**Example — final:**

```
📋 Plan: Project roadmap — complete
  Phase: 4 of 4
  Status: complete
  Result: 4 phases, 18 tasks, 3 blockers identified
  Artifact: PLAN.md
```

---

### 3. `build` — Implementation Phase

Use when the fleet is writing code, creating files, or implementing features.

**Emitted at:**

- Before starting implementation of a task
- After each file is created or modified
- When the task is complete (or fails)

**Template:**

```
🔨 Build: <task or feature name>
  Task: <task index / total — e.g., "T3 of 6">
  File: <affected file path, or "—" if no file yet>
  Status: <pending | in-progress | complete | failed>
  Detail: <1-line summary — e.g., "Created service layer with 4 methods">
```

**Example — task start:**

```
🔨 Build: Authentication service
  Task: T3 of 6
  File: —
  Status: in-progress
  Detail: Starting implementation...
```

**Example — each file:**

```
🔨 Build: Authentication service
  Task: T3 of 6
  File: src/auth/service.ts
  Status: in-progress
  Detail: Created with 4 methods: login, logout, refresh, validate
```

**Example — task complete:**

```
🔨 Build: Authentication service — complete
  Task: T3 of 6
  Files: src/auth/service.ts, src/auth/controller.ts, src/auth/middleware.ts
  Status: complete
  Result: 3 files, ~240 lines, 8 methods, 12 unit tests
```

**Example — task failed:**

```
🔨 Build: Authentication service — failed
  Task: T3 of 6
  File: src/auth/service.ts
  Status: failed
  Detail: Build error — missing dependency @types/jwt (see error log)
```

---

### 4. `review` — Quality Gate Phase

Use when the fleet is reviewing implementation for correctness, security, performance, or maintainability.

**Emitted at:**

- Before starting the review
- After each checklist category is checked
- When the review is finalized (approved, needs revision, or critical)

**Template:**

```
🧐 Review: <what is being reviewed>
  Category: <checklist category — e.g., "correctness", "security", "performance">
  Status: <pending | in-progress | complete>
  Detail: <1-line summary — e.g., "Found 2 issues, 1 critical">
```

**Example — start:**

```
🧐 Review: Authentication service implementation
  Category: all
  Status: in-progress
  Detail: Checking correctness, security, performance, maintainability...
```

**Example — each category:**

```
🧐 Review: Authentication service — correctness
  Category: correctness
  Status: complete
  Result: All edge cases covered, error handling verified
```

```
🧐 Review: Authentication service — security
  Category: security
  Status: complete
  Result: 2 issues — missing rate limiting (important), token expiry OK (ok)
```

**Example — final:**

```
🧐 Review: Authentication service — complete
  Category: all
  Status: complete
  Result: APPROVED
  Issues: 0 critical, 2 important, 0 nice-to-have
  Summary: Good implementation. Address rate limiting before merge.
```

**Example — needs revision:**

```
🧐 Review: Authentication service — needs revision
  Category: all
  Status: complete
  Result: NEEDS_REVISION
  Critical issues: 1 — missing input validation on login endpoint
  Action: Developer must fix critical issues before resubmit
```

**Example — critical:**

```
🧐 Review: Authentication service — critical
  Category: all
  Status: complete
  Result: CRITICAL
  Critical issues: 2 — SQL injection in user lookup, no CSRF protection
  Action: Block — developer must address both before any merge
```

---

## Progress Reporting Convention

### When to Emit Messages

| Phase Type | Emit At | Frequency |
|---|---|---|
| analyze | start, each step, completion | 1 + steps + 1 |
| plan | start, each phase, completion | 1 + phases + 1 |
| build | start, each file, task complete/fail | 1 + files + 1 |
| review | start, each category, completion | 1 + categories + 1 |

### Message Order in a Multi-Phase Operation

When executing a full project through the fleet, messages should appear in this interleaved order:

```
📋 Plan: Phase 1 of 4 — complete
🔍 Analyze: Phase 2 scope — in-progress
🔍 Analyze: Phase 2 scope — complete
🔨 Build: Task 1 of 6 — in-progress
🔨 Build: Task 1 of 6 — complete
🧐 Review: Task 1 — needs revision
🔨 Build: Task 1 of 6 — in-progress (retry)
🔨 Build: Task 1 of 6 — complete
🧐 Review: Task 1 — approved
🔨 Build: Task 2 of 6 — in-progress
...
📋 Plan: Phase 2 of 4 — complete
...
```

### Status Values

| Status | Meaning |
|---|---|
| `pending` | Has not started yet |
| `in-progress` | Currently executing |
| `complete` | Successfully finished |
| `failed` | Hit an error or failure |
| `needs_revision` | Review found issues that must be fixed |

### Emoji Legend

| Emoji | Phase Type |
|---|---|
| 🔍 | analyze |
| 📋 | plan |
| 🔨 | build |
| 🧐 | review |

---

## Integration Notes

- These templates are for **human-facing progress output** — use them when reporting to the user or writing to logs
- During automated execution, the minimum viable message is: the emoji prefix, the phase type, and the status
- For verbose mode (default), include all fields: scope/category, status, detail
- For quiet mode, emit only: `emoji phase_type: status` (e.g., `🔨 Build: Task 3 of 6 — complete`)

## When to Use

- Every `/analyze` invocation
- Every `/plan` invocation
- Every phase of `/go` (build phases)
- Every code-review or design-review operation
- Any multi-step fleet operation that spans more than 3 actions

## When to Skip

- Single-step operations (one command, one result) — no progress needed
- Internal housekeeping that the user doesn't need to see
- During a tight review loop where messages would spam the log
