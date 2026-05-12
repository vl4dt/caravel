# Caravel — Legacy Design Documentation

> **⚠️ OUTDATED — Overlay removed in 2026-05-12**
> This document describes the overlay dashboard architecture that was removed.
> All fleet status is now shown in a **persistent 6-line widget bar** only.
> See `README.md` and `SKILL.md` for current documentation.
>
> Kept for reference only. Do not use as implementation guidance.

## Architecture Notes (Historical)

The original design attempted a two-layer approach:
1. Widget bar (always visible)
2. Non-capturing overlay panel (bottom-right)

The overlay was removed because it caused UI glitches, size instability, and was a poor UX pattern. All fleet status now lives in the stable widget bar.

## Widget Bar Design (Current)

### Always Exactly 6 Lines

```
╔══════════════════════════════════════════════════════════════╗
║  CARAVEL FLEET  │  P1/3: Setup  │  ▸ RUN                   ║
║  [████████░░░░░░░░] 40%  │  2/5 tasks  │  1m 23s            ║
║  ▸ running: bash → npm install                              ║
║  0 reviews  │  Elapsed: 1m 23s                              ║
╚══════════════════════════════════════════════════════════════╝
```

- Fixed content width of 62 chars per line
- No terminal-width-dependent rendering
- Same height in idle and active states
- Border chars: `║`, `╔`, `╗`, `╚`, `╝`, `═`

### Idle State Layout

```
╔══════════════════════════════════════════════════════════════╗
║  CARAVEL FLEET  │  ● IDLE                                   ║
║  [░░░░░░░░░░░░░░░░░░░] 0%  │  5 agents configured  │  1h 12m║
║  ▸ last: bash → npm install  (5m ago)                       ║
║  ● 0 reviews completed  │  Elapsed: 1h 12m                  ║
╚══════════════════════════════════════════════════════════════╝
```

### Active State Layout

```
╔══════════════════════════════════════════════════════════════╗
║  CARAVEL FLEET  │  P1/3: Codebase Analysis  │  ▸ RUN        ║
║  [████████░░░░░░░░] 40%  │  2/5 tasks  │  1m 23s            ║
║  ▸ running: bash → npm install                              ║
║  0 reviews  │  Elapsed: 1m 23s                              ║
╚══════════════════════════════════════════════════════════════╝
```

## Implementation Reference

### `buildWidgetLines(ctx)` — Core Widget Renderer

Returns exactly `string[]` of 6 lines. Never changes.

Key design decisions:
- Uses `ctx.ui.theme.fg()` for consistent color theming
- Uses `padEnd(62)` to fill content area
- Progress bar always 20 chars wide (█ filled, ░ empty)
- Duration format: `1h 23m`, `45s`, `3m 12s`
- Time ago: `<60s` → `"42s ago"`, `<60m` → `"5m ago"`, else `"1h 23m ago"`

### `refreshWidget(ctx)` — Widget Updater

Updates the persistent widget in place via `ctx.ui.setWidget("caravel-fleet", lines)`.

Updates on:
- `agent_end` events
- `tool_call` events
- Fleet state changes (phase start/complete, review start/complete)

### Widget Visibility Control

`setWidgetVisibility(ctx, visible)` — toggles widget bar on/off.
