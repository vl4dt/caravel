# ZFS Fleet Migration — Design Decisions

## Overview

Caravel supports three execution modes that can be migrated between at any time:

1. **Foreground** — Fleet runs in the current pi process (default)
2. **Background** — Fleet runs as a detached subprocess (survives terminal close)
3. **ZFS (Zellij Fleet Session)** — Fleet runs in Zellij panes (full visibility/interactivity)

## Migration Paths

### Foreground → Background
- Use `/bg-launch` command or `fleet_control` integration
- Saves current state → spawns detached `caravel.ts --bg-mode` process
- State file preserved → can be monitored via `/bg-status`
- **Decision**: Use when you need to step away but want fleet to keep running

### Foreground → ZFS
- Use `/zellij-start` command
- Saves state → opens Zellij session with panes for each agent
- State file preserved → can switch back to background at any time
- **Decision**: Use when you want real-time visibility and interactivity

### ZFS → Background
- Use `/bg-export` (via `exportToBackground()`)
- Stops ZFS session (preserves fleet state in `state.json`)
- Spawns detached `caravel.ts --bg-mode` process
- **Decision**: Use when you want to close Zellij but keep fleet running

### ZFS → Foreground
- Not directly supported (ZFS panes are persistent)
- Use `/bg-export` first to convert to background, then close ZFS

### Background → Foreground
- Not directly supported (background is a separate process)
- Monitor via `/bg-status`, use `fleet_control(action="resume")` to reconnect

### Background → ZFS
- Use `/zellij-start` while in background mode
- Loads saved state → opens ZFS session with existing fleet state

## Decision Matrix

| Scenario | Recommended Mode | Migration Path |
|----------|-----------------|----------------|
| Start new fleet | Foreground or ZFS | Direct |
| Need real-time monitoring | ZFS | Foreground → ZFS |
| Stepping away from terminal | Background | Foreground/ZFS → Background |
| Want to close ZFS but keep running | ZFS → Background | exportToBackground() |
| Need to reconnect to running fleet | Background → Foreground | Monitor state.json |

## State Preservation

All migrations preserve state via `state.json`:
- Save happens automatically before each migration
- Resume loads the exact same fleet state (same phases, tasks, progress)
- No data loss between mode switches

## Implementation Notes

- Background mode uses `spawn()` with `--bg-mode` flag
- Background process reads `state.json` on startup and auto-resumes
- ZFS mode uses Zellij's pane management API
- All modes share the same `fleetState` structure
