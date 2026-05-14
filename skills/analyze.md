---
name: analyze
description: The /analyze command performs a direct codebase scan (no delegation) and produces a saved ANALYSIS.md report in the project root. Use when the user types /analyze, asks to analyze a codebase, or wants a persistent audit report instead of just a chat response.
---

# /analyze Command

## Purpose

Perform a direct codebase scan in the orchestrator and **persist** its output to `ANALYSIS.md` in the project root. The report becomes a durable artifact that any agent on the fleet can read, reference, and update.

The orchestrator scans the codebase itself using `scanCodebase()`, `ls`, and `find` — no subagent delegation. This ensures:
- Full visibility at all times (no silent failures from crashed subagents)
- Guaranteed output (the orchestrator controls the scan end-to-end)
- Error resilience (partial scans saved on failure)

## Invocation

The user invokes this skill by typing `/analyze`. The orchestrator handles the scan directly.

Programmatic invocation (for agent use):
```javascript
// The /analyze command runs in the orchestrator automatically
// No subagent delegation needed
```

## How It Works

### 1. Direct Codebase Scan

The `/analyze` command performs the scan **directly in the orchestrator** — no delegation to a subagent. This ensures:

1. **Full visibility** — the orchestrator maintains awareness at all times, even if a subagent crashes
2. **Reliable output** — `ANALYSIS.md` is always produced because the orchestrator reads the files itself
3. **Error resilience** — no silent failures from a crashed subagent with empty output

The scan performs:

1. **Structure scan** — `ls` and `find` the directory layout, file counts, directory counts
2. **Key file reads** — `package.json`, `README.md`, `docker-compose`, config files
3. **Dependency mapping** — identify external packages and internal module relationships
4. **Test detection** — find test files, test framework, coverage indicators
5. **Debt identification** — look for outdated patterns, code smells, missing docs
6. **Language/framework detection** — auto-detect from package.json, config files, and source patterns

### Progress Feedback

The orchestrator emits structured progress during the scan:

```
🔍 Analyze: Scanning directory structure...
🔍 Analyze: Reading key files (package.json, README, configs)...
🔍 Analyze: Mapping dependencies...
🔍 Analyze: Detecting test infrastructure...
🔍 Analyze: Identifying technical debt...
```

### Error Handling

The orchestrator has built-in error recovery:

- **Process crashes** — detected via exit code -1 (signal termination), reported as CRITICAL
- **Empty output** — exit code 0 with no output is caught and logged as a warning
- **Non-zero exit** — captured in stderr, reported with full context
- **Silent failures** — all agents are responsible for self-recovery (see `agents/*.md`)
- **Error context injection** — on retry, agents receive their previous stderr, review feedback, and output to enable self-correction

### Output

After the scan completes, the orchestrator produces:

1. **ANALYSIS.md** — the full analysis report
2. **PROJECT-DESIGN.md** — architecture overview and design patterns (generated from scan results)
3. **Fleet metadata** — agent used, model, tools, tokens, elapsed time, cost estimate

If any step fails, the report includes:

- **Errors** section listing what failed
- **Suggestions** section with actionable next steps
- **Partial output** from whatever the scan could complete

```
🔍 Analyze: Codebase audit
  Scope: project structure, dependencies, architecture, test gaps
  Status: in-progress
  Detail: Scanning directory layout and key files...
```

```
🔍 Analyze: Dependency audit
  Scope: production & dev dependencies
  Status: complete
  Detail: Found 42 packages — 3 out of date, 2 with known vulnerabilities
```

```
🔍 Analyze: Codebase audit — complete
  Scope: project structure, dependencies, architecture, test gaps
  Status: complete
  Result: 3 critical, 5 important, 2 low-priority debt items found
  Artifact: ANALYSIS.md
```

### 2. Persist the Report

The orchestrator writes `ANALYSIS.md` to the project root. Do **not** rely on chat-only output. The file is the artifact.

If `ANALYSIS.md` already exists:

- **Overwrite** if the user explicitly re-ran `/analyze`
- **Append** a "Last Updated" footer with a timestamp if the user only asked about the existing report

### 3. Artifact Generation

After the scan completes, the orchestrator automatically generates:

#### `ANALYSIS.md` — Full Analysis Report
- Project overview, structure, tech stack
- Architecture patterns and design decisions
- Entry points and dependencies
- Test coverage and technical debt findings
- Security findings and recommendations

#### `PROJECT-DESIGN.md` — Design Document
- Architecture overview from the scan
- Tech stack summary
- Design patterns detected
- Links to the full analysis and plan

#### `PROJECT-PLAN.md` — Project Plan
- Generated when `plan_project()` is invoked after analysis
- Contains phases, tasks, agent assignments, and implementation roadmap
- Serves as the implementation blueprint the fleet executes
- Saved to the project root

### 4. Confirm Completion

After analysis:

1. Verify `ANALYSIS.md` exists and is non-empty
2. Report back to the user with:
   - Agent & model used
   - Execution stats (elapsed time, turns, token counts, cost estimate)
   - Pre-flight scan summary (files, directories, languages, frameworks, entry points)
   - Key findings (critical, important, low-priority items)
   - Coverage areas (project structure, tech stack, architecture, dependencies, test gaps, technical debt)

## Output Format (`ANALYSIS.md`)

The orchestrator produces the report in this structure:

```markdown
# Codebase Analysis Report

> Generated: YYYY-MM-DD HH:MM UTC
> Orchestrator (direct scan — no subagent delegation)
> Project: <project name>

## 1. Project Overview
[Language, framework, purpose, version]

## 2. Directory Structure
- src/ — main source code
- tests/ — test files
- [key directories]

## 3. Tech Stack
- Language: ...
- Framework: ...
- Build: ...
- Package Manager: ...
- Testing: ...

## 4. Architecture
[Design patterns, architectural style, module boundaries]

## 5. Entry Points
- path/to/file — purpose

## 6. Dependencies
### Production
- package@version — purpose

### Development
- package@version — purpose

## 7. Test Coverage
- Framework: ...
- Coverage: ~N% (estimated)
- Gaps: ...
- Files: ...

## 8. Configuration
- file — purpose

## 9. Findings

### Critical
- Issue description → file/path:line → impact

### Important
- Issue description → file/path:line → impact

### Low Priority
- Issue description → file/path:line → impact

## 10. Recommendations
1. [Priority] Action — why + which files
2. [Priority] Action — why + which files
3. ...

## 11. Next Steps
1. [Immediate] Short-term action
2. [Short-term] Next priority
3. [Long-term] Strategic improvement
```

## Guidelines

- **Always persist** — chat output is never the final deliverable. `ANALYSIS.md` is.
- **Be thorough but focused** — cover what matters for planning, not every line of code
- **Distinguish facts from estimates** — label uncertain metrics clearly
- **Highlight blockers** — anything that would prevent new development
- **Suggest concrete next steps** — not just "fix debt", but which files, which order, why
- **Include file paths** — every finding should reference a location
- **Timestamp every run** — so the report's freshness is auditable

## When to Use

- User types `/analyze`
- User asks to "analyze this codebase" or "audit this project"
- Before planning a new feature — to understand the existing landscape
- When taking over a project — to get an overview quickly
- When a phase fails and you need root cause analysis

## When Not to Use

- During active review loops (`/go` in progress) — use the built-in review instead
- When a more targeted skill applies (e.g., `code-review.md` for PR review)
- On brand-new scaffolds with no code yet

## Updating an Existing Report

If `ANALYSIS.md` exists and the user asks again:

1. Compare the new findings against the existing report
2. Overwrite if the scope changed (different project, fresh look)
3. Append a changelog footer if the project hasn't materially changed but the user wants the latest data

```markdown
---
## Changelog
- YYYY-MM-DD: Initial analysis
- YYYY-MM-DD: Updated — new dependencies added, debt items reassessed
```
