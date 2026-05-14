# caravel - Design Document

> Generated: 2026-05-14 from project architecture
> Source: orchestrator direct scan (no subagent delegation)
> Scope: architecture, tech stack, design patterns, structural analysis

---

## Architecture

Caravel implements a **supervisor-worker pattern with pipeline review loops** for multi-agent fleet orchestration.

### Core Pattern

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

### Key Design Decisions

1. **Orchestrator does its own scanning** — `/analyze` performs codebase scan directly via `scanCodebase()`, never delegates to a subagent that could crash silently
2. **Strict success criteria** — task completion requires `exitCode === 0` AND non-empty output; silent crashes and empty outputs are explicitly caught
3. **Signal termination handling** — processes killed by signals (OOM/KILL) produce exit code -1, not 0; killed processes cannot masquerade as successful
4. **Error context injection** — on retry, agents receive their previous stderr, review feedback, and output to enable self-correction
5. **Agent error recovery** — every agent has explicit "Error Recovery" instructions in its prompt (`agents/*.md`)

### Agent Architecture

| Agent | Responsibility | Error Recovery |
|-------|---------------|----------------|
| **developer** | Coding, implementation, file manipulation | Fix build/test failures, verify imports, handle runtime errors |
| **tech-lead** | Architecture, planning, code review | Work from structure if files unavailable, clarify feedback |
| **designer** | Visual/UX review, design quality | Describe expectations if vision fails, adapt to existing code |
| **planner** | Conversational scoping, plan generation | Discover via `ls`/`find`, mark assumptions, produce best-effort |
| **auditor** | Codebase analysis, pre-flight scan | Retry reads, partial reports, never submit empty output |
| **documenter** | Documentation writing and maintenance | Verify paths exist, reconcile conflicts, don't include unverifiable refs |

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js (Pi agent framework)
- **Framework**: Pi coding agent extensions
- **Build**: TypeScript (tsc)
- **Package Manager**: npm

## Project Structure

- **Total Files**: 359
- **Total Directories**: 192
- **Config Files**: 359
- **Test Infrastructure**: ✓ Detected
- **CI/CD Pipeline**: ✗ Not detected

---

> Full analysis report: [ANALYSIS.md](./ANALYSIS.md)
> Implementation plan: [PROJECT-PLAN.md](./PROJECT-PLAN.md)
