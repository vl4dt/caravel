# Caravel — Project Assessment & Roadmap

## Current State Assessment

### What Caravel Is
A fleet orchestration system for Pi with supervisor-worker pattern, two-stage review loops, 3 agents (developer, tech-lead, designer), 5 tools, and a persistent widget bar.

### What Works Well
- Clean supervisor-worker architecture with configurable models
- Two-stage review (code + design) with auto-fix loops
- Agent discovery from user+project directories
- State persistence across sessions
- Widget bar already provides non-blocking progress

### What Doesn't Work Well

#### 1. Dashboard is a Blocking Dialog
The `/fleet` command opens a **full-screen TUI overlay** (`ctx.ui.custom() + { overlay: true }`) that blocks ALL user input. You cannot type while watching the fleet evolve.

#### 2. "Usage" Workflow is Anti-Pattern
Users are expected to write TypeScript function calls with structured phases:
```typescript
plan_project(name="My App", phases=[{ name: "Setup", tasks: [...] }])
```
This requires knowing the API signatures and structuring work in advance. Nobody starts by writing TypeScript — they start by describing a project.

---

## Roadmap

### Phase 1: Dashboard Panel (Non-Blocking) — IN PROGRESS
**Goal**: Replace blocking overlay with persistent non-blocking dashboard

**Architecture**:
- **Widget bar** (always visible): Enhanced `ctx.ui.setWidget()` with render function, showing progress, active tasks, status
- **Non-capturing overlay** (persistent): `ctx.ui.custom() + { overlay: true, nonCapturing: true }` positioned bottom-right, showing rich detail dashboard with tabs
- `/fleet` toggles visibility of both

**Key APIs**:
- `ctx.ui.setWidget()` — persistent, non-blocking, proven by plan-mode extension
- `nonCapturing: true` — undocumented but real (used in overlay-qa-tests.ts)
- `onHandle(handle)` — access to `OverlayHandle.setHidden()` for visibility toggle

**Risk**: `nonCapturing: true` is undocumented. Fallback: enhanced widget bar only.

### Phase 2: Conversational Planner Agent
**Goal**: Grill-me-style agent that interviews user and generates `plan_project()` call

**How it works**:
1. User describes project in natural language
2. Planner agent asks questions ONE AT A TIME:
   - "What's the project about?" → "Build a kanban board app"
   - "Tech stack?" → "React + TailwindCSS (recommended)"
   - "Features?" → "Drag-and-drop, multiple boards"
   - Each question has 2-3 recommended answers
3. Planner generates `plan_project()` call with proper phases
4. User approves → main agent calls `run_phase()` and `review_task()`

### Phase 3: Auto-Orchestration
**Goal**: One command (`go`) launches entire fleet

**What `go` does**:
- Runs each phase via `run_phase()`
- After each phase, triggers `review_task()`
- Handles review fix loops
- Reports progress to dashboard
- Allows `fleet_control` interrupts

---

## Technical Architecture

### Dashboard Component Map

| Component | API | Blocking? | Persistent? | Purpose |
|-----------|-----|-----------|-------------|---------|
| Widget bar | `ctx.ui.setWidget()` | No | Yes | Always-visible progress bar |
| Detail overlay | `ctx.ui.custom() + { overlay: true, nonCapturing: true }` | No | Yes | Rich dashboard with tabs |
| `/fleet` command | Toggles both widget bar + overlay | N/A | N/A | Visibility control |

### Event System

Dashboard updates on:
- `agent_end` → refresh widget + overlay
- `phase_start` → show new phase active
- `phase_complete` → mark phase complete
- `session_shutdown` → persist state

### Planner Agent Integration

```
User: "I want to build a kanban board"
    │
    ▼
Main Agent: "Let me plan this with the Planner agent"
    │
    ▼
Planner Agent (agents/planner.md):
  - Interviews user about project scope, tech stack, features
  - Generates plan_project() call
    │
    ▼
Main Agent executes:
  plan_project(name="Kanban Board", phases=[...])
  run_phase(phaseIndex=0)
  review_task(phaseIndex=0)
```

The planner agent is a `.md` file in `agents/` directory. It gets discovered by the caravel extension (same as developer, tech-lead, designer).

---

## Implementation Order

1. Remove blocking overlay code from caravel.ts
2. Implement enhanced widget bar (always visible)
3. Implement non-capturing detail overlay
4. Wire up `/fleet` toggle
5. Add event-driven updates
6. Create agents/planner.md
7. Test end-to-end

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `nonCapturing: true` undocumented | High | Enhanced widget bar fallback |
| Planner agent produces bad plans | Medium | Careful prompt design with examples |
| Auto-orchestration runs too long | Medium | Always allow `fleet_control` interrupts |
| New panel layout breaks on narrow terminals | Low | Use existing responsive techniques |

## Success Criteria

1. **Dashboard**: You can watch the fleet while typing — no blocking
2. **Planning**: Describe a project → get structured plan in <5 min conversation
3. **Execution**: One command launches the entire fleet through all phases
4. **Transparency**: Real-time visibility into agent activity
