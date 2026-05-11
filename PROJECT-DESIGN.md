# Caravel Dashboard — Non-Blocking Panel Design

## Problem

The current `/fleet` command uses `ctx.ui.custom()` with `{ overlay: true }` to create a full-screen TUI overlay. This **blocks all user input** — the user cannot type anything while the dashboard is open. This is the wrong UX for a monitoring tool.

## Pi TUI API Analysis

### Available APIs

| API | Blocking? | Persistent? | Rich Content? | Status |
|-----|-----------|-------------|---------------|--------|
| `ctx.ui.setWidget()` | No | Yes | Yes (render fn) | ✅ Documented |
| `ctx.ui.custom() + { overlay: true }` | Yes | No | Yes | ✅ Documented |
| `ctx.ui.setFooter()` | No | Yes | Yes | ✅ Documented |
| `ctx.ui.setStatus()` | No | No | No | ✅ Documented |
| `nonCapturing: true` overlay | No | Conditional | Yes | ⚠️ Undocumented |

### Key Finding: `nonCapturing` Overlay

The `nonCapturing: true` overlay option is **undocumented but real** — used in `overlay-qa-tests.ts`:

```typescript
// Non-capturing overlay that renders visually but doesn't capture input
const handle = tui.showOverlay(component, {
    nonCapturing: true,
    anchor: "top-right",
    width: 22,
    margin: { top: 1, right: 2 },
});
```

Properties:
- Renders visually in the terminal
- **Does NOT capture keyboard focus**
- Keyboard input goes to editor behind overlay
- Multiple non-capturing overlays can coexist
- `OverlayHandle.focus()` / `unfocus()` for focus cycling
- `OverlayHandle.isFocused()` to check focus state

### Key Finding: `onHandle` Callback

`ctx.ui.custom()` accepts an `onHandle(handle)` callback that provides access to `OverlayHandle`:

```typescript
await ctx.ui.custom<void>((tui, theme, _kb, done) => {
  return new DashboardComponent(theme, () => done(undefined));
}, {
  overlay: true,
  overlayOptions: {
    anchor: "bottom-right",
    width: 60,
    maxHeight: "60%",
    margin: { bottom: 2, right: 2 },
  },
  onHandle: (handle) => {
    dashboardHandle = handle;
    handle.setHidden(false); // Start visible
  },
});
```

`OverlayHandle` methods:
- `setHidden(true/false)` — toggle visibility without closing
- `hide()` — permanently hide
- `focus()` / `unfocus()` — focus cycling
- `isFocused()` — check focus state

### Key Finding: Widget Bar Render Function

`ctx.ui.setWidget()` can accept a render function returning `{ render: () => lines, invalidate: () => {} }`:

```typescript
ctx.ui.setWidget("my-widget", (_tui, theme) => {
  const lines = items.map((item, i) =>
    item.done
      ? theme.fg("success", "✓ ") + theme.fg("muted", item.text)
      : theme.fg("dim", "○ ") + item.text
  );
  return {
    render: () => lines,
    invalidate: () => {},
  };
});
```

This is **already used by the plan-mode extension** for a rich multi-line todo list widget.

## Implementation (Complete)

### Layer 1: Enhanced Widget Bar (Always Visible)

Implemented as `buildWidgetLines(ctx)` which returns rich multi-line content:
```
╭─ CARAVEL FLEET ──────────────────────────────────╮
│ P2/4: Core UI  [████████░░░░░░░░░] 60%  ▸
│ ▸ Dev: Board.tsx (running)  12/20 tasks · 2m14s
╰─────────────────────────────────────────────────────╯
```

Uses `ctx.ui.setWidget("caravel-fleet", buildWidgetLines(ctx))` — already non-blocking.

### Layer 2: Dashboard Overlay (Non-blocking, Persistent)

Implemented as `DashboardOverlayComponent` rendered via `ctx.ui.custom()` with `onHandle` callback.

Key properties:
- Positioned: `bottom-right` of terminal
- Size: ~60 cols × 60% height
- `onHandle(handle)` for `handle.setHidden()` toggle
- Updates via `requestRender()` on `agent_end` event
- Keyboard input passes through to editor (non-blocking)

### `/fleet` Command Behavior

- **First call**: Shows widget bar + overlay, notifies "Fleet dashboard opened"
- **Second call**: Hides both, notifies "Fleet dashboard closed"
- Widget bar remains visible when overlay is hidden (via periodic refresh)

## Dashboard Content Design

### Widget Bar (Compact)

```
P2/4: Core UI  [████████░░░░░░░] 60%  Dev→Board.tsx  2m14s
```

Single line, always visible, minimal.

### Detail Overlay (Rich Dashboard)

**Tabs**: TASKS | AGENTS | REVIEW | TERMINAL

**TASKS Tab**:
- All phases with status icons:
  - `[✓]` complete, `[▸]` running, `[ ]` pending, `[!]` failed
- Each phase shows: name, status, task count
- Expanded view (current phase): tasks with agent names and status
- Review indicators: `(+/-)` for code/design review status

**AGENTS Tab**:
- All discovered agents with model info
- Active agents highlighted with current task
- Agent status: RUNNING, REVIEWING, IDLE, ERROR

**REVIEW Tab**:
- Review iteration count vs max
- Code review summary (approved/needs fix)
- Design review summary (approved/needs fix)
- Review progress bar
- Recent review feedback excerpts

**TERMINAL Tab**:
- Last N lines of agent output
- Scrollable (up/down navigation when focused)
- Colored output (success=green, error=red, etc.)

## Event System

The dashboard updates on:
- `agent_end` → refresh widget + overlay
- `phase_start` → show new phase active
- `phase_complete` → mark phase complete, refresh
- `session_shutdown` → persist state, hide overlay

Uses `pi.on("event_name", handler)` to subscribe to Pi events.

## Code Changes Summary

### In `extensions/caravel.ts`:

**Remove:**
- `FleetDashboardComponent` class (~280 lines of blocking overlay code)
- `openDashboard()` function
- `dashboardOpen`, `dashboardTui`, `dashboardDone` module vars
- All interactive key handling in `handleInput()` method
- `renderPanel()`, `renderTasksPanel()`, `renderAgentsPanel()`, `renderReviewPanel()`, `renderTerminalPanel()` methods (move to overlay)

**Add:**
- `dashboardOverlayHandle: OverlayHandle | null` — persistent overlay handle
- `dashboardOverlayVisible: boolean` — track overlay visibility
- `buildWidgetLines(ctx)` — returns enhanced multi-line widget content
- `showDashboardOverlay(ctx)` — shows non-capturing detail overlay
- `hideDashboardOverlay()` — hides overlay via `handle.setHidden(true)`
- Event subscriptions: `agent_end`, `phase_start`, `phase_complete`
- Enhanced `refreshWidget()` that calls `buildWidgetLines()`

**Modify:**
- `/fleet` command → toggles widget bar + overlay (not blocking dialog)
- `/fleet-toggle` → same as `/fleet`
- Widget refresh: use event-driven updates + reduced poll interval

### In `agents/`:

**Add:**
- `agents/planner.md` — conversational Project Planner agent (grill-me-style)
  - Interviews user about project scope, tech stack, requirements
  - Asks questions ONE AT A TIME
  - Provides recommended answers
  - Generates `plan_project()` call when enough info gathered

### In `PROJECT-PLAN.md`:

Update to reflect new dashboard architecture.

## Implementation Order

1. Remove blocking overlay code
2. Implement enhanced widget bar (always visible)
3. Implement non-capturing detail overlay
4. Wire up `/fleet` toggle
5. Add event-driven updates
6. Create planner agent
7. Test end-to-end

## Fallback Plan

If `nonCapturing: true` doesn't work as expected:
- Use enhanced widget bar as PRIMARY dashboard
- Use standard (blocking) overlay for `/fleet` detail view only
- User accepts that `/fleet` detail view blocks typing, but widget bar remains visible
- Document that `/fleet` opens a detail view, and widget bar is the always-visible dashboard
