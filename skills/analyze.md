---
name: analyze
description: The /analyze command triggers the auditor agent to produce a saved ANALYSIS.md report in the project root. Use when the user types /analyze, asks to analyze a codebase, or wants a persistent audit report instead of just a chat response.
---

# /analyze Command

## Purpose

Run the auditor agent on the current project and **persist** its output to `ANALYSIS.md` in the project root. The report becomes a durable artifact that any agent on the fleet can read, reference, and update.

## Invocation

The user invokes this skill by typing `/analyze`. You may also trigger it programmatically:

```javascript
subagent("auditor", "Analyze the current codebase and save the report to ANALYSIS.md in the project root.")
```

## How It Works

### 1. Trigger the Auditor

Delegate to the auditor agent:

```javascript
subagent("auditor", "Analyze the current codebase and save the report to ANALYSIS.md in the project root.")
```

The auditor will:

1. **Scan structure** — `ls` and `find` the directory layout
2. **Read key files** — `package.json`, `README`, `docker-compose`, config files
3. **Map dependencies** — identify external packages and internal module relationships
4. **Check tests** — find test files, understand coverage status
5. **Identify debt** — look for outdated patterns, code smells, missing docs

### Progress Feedback

During execution, emit structured progress messages so the user always sees what's happening:

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

The auditor MUST write its output to `ANALYSIS.md` in the project root. Do **not** rely on chat-only output. The file is the artifact.

If `ANALYSIS.md` already exists:

- **Overwrite** if the user explicitly re-ran `/analyze`
- **Append** a "Last Updated" footer with a timestamp if the user only asked about the existing report

### 3. Generate Auto-Artifacts

After the auditor finishes its analysis, **two additional artifacts** are auto-generated:

#### `PROJECT-DESIGN.md` — Design Document (from analysis)
- Generated from the analysis phase output
- Contains architecture overview, tech stack, design patterns, and structural findings
- Serves as a durable design reference for all agents working on the project
- Saved to the project root

#### `PROJECT-PLAN.md` — Project Plan (from planning phase)
- Generated when `plan_project()` is invoked after analysis
- Contains phases, tasks, agent assignments, and implementation roadmap
- Serves as the implementation blueprint the fleet executes
- Saved to the project root

### 4. Confirm Completion

After the auditor finishes:

1. Verify `ANALYSIS.md` exists and is non-empty
2. Verify `PROJECT-DESIGN.md` was generated from the analysis
3. Report back to the user with:
   - Location of the reports: `ANALYSIS.md`, `PROJECT-DESIGN.md`
   - Summary of findings (e.g., "Found 3 critical debt items, 2 medium")
   - What the report covers

```
✓ Analysis complete. Reports saved to:
  - ANALYSIS.md (detailed audit)
  - PROJECT-DESIGN.md (architecture & design)
  Findings: 3 critical, 2 medium, 1 low
  Coverage: project structure, tech stack, architecture, dependencies, test gaps, technical debt
```

## Report Format (`ANALYSIS.md`)

The auditor should produce the report in this structure:

```markdown
# Codebase Analysis Report

> Generated: YYYY-MM-DD HH:MM UTC
> Auditor: auditor agent
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
