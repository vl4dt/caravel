# Process Management Design: Foreground vs Background vs ZFS

**Date**: 2026-05-13
**Status**: Implemented
**Related**: T6 — Background process management with ZFS migration

---

## Decision Matrix

| Mode | Persistent | Monitorable | Attune-able | Survives pi crash | Requires Zellij | Complexity |
|---|---|---|---|---|---|---|
| **Foreground** (default) | ❌ (in-memory) | ✓ (widget bar) | ✓ (follow) | ❌ | ❌ | Low |
| **Background** | ✓ (state.json) | ✓ (fleet_status) | ✓ (follow) | ✓ | ❌ | Medium |
| **ZFS** | ✓ (state.json) | ✓ (floating pane) | ✓ (follow pane) | ✓ | ✓ | High |

---

## Decision: Three-Tier Model

Fleet execution now supports three modes, each appropriate for different scenarios:

### 1. Foreground (Default — Current Behavior)

Fleet runs **inline** within the pi process. This is the current default and works well for:
- Short execution plans (< 30 min wall-clock)
- Local development iteration
- Debugging and development

**Limitation**: When pi crashes or exits, all in-memory state is lost (except what was saved at checkpoints).

### 2. Background (New — `fleet_control(action="bg_start")`)

Fleet runs as a **detached child process**. This enables:
- Long-running execution (hours)
- pi can exit and fleet continues
- State persists to `state.json` across restarts
- Can migrate to ZFS later for monitoring

**How it works**:
1. Fleet state is saved to `state.json`
2. A **fork** of the current caravel process is spawned with `--bg-mode` flag
3. The child process loads saved state and continues execution
4. The parent pi process detaches; the user can close pi
5. Fleet state is polled from disk by any subsequent pi session

### 3. ZFS (Existing — `/zellij-start`)

Fleet runs inside a **Zellij session** with dedicated agent panes and a floating status bar. This is the richest experience:
- Real-time pane-level monitoring
- Agent output streaming per-pane
- Floating status bar with live progress
- Navigation between panes

**Limitation**: Requires Zellij installed and running.

---

## Migration Paths

### Background → ZFS (Migrate Running Fleet to ZFS)

When a fleet is running in background mode and you want to monitor it via ZFS:

```
fleet_control(action="migrate_to_zfs")
```

**What happens**:
1. Fleet state is saved to `state.json` (checkpoint)
2. A ZFS session is created with the fleet layout
3. An orchestrator pane is spawned running the fleet
4. Agent panes are spawned for each active task
5. The background process is gracefully stopped
6. Fleet state is transferred to ZFS tracking
7. Status bar is initialized

**Constraints**:
- Requires Zellij to be installed and running
- Active agent processes are terminated (they will be re-spawned in ZFS panes)
- The next agent will start from the saved checkpoint (minor token cost)

### Foreground → ZFS (Start Fleet in ZFS)

```
/zellij-start
```

This creates a ZFS session and starts the fleet inside it from the beginning (or resumes from saved state).

### ZFS → Background (Export ZFS to Background)

When monitoring via ZFS and you want to stop ZFS but keep the fleet running:

```
fleet_control(action="bg_export")
```

**What happens**:
1. Fleet state is checkpointed to `state.json`
2. ZFS session is stopped (panes terminated)
3. A new background process is spawned to continue from the checkpoint
4. Fleet runs as a background process

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    pi (Parent Process)                      │
│                                                             │
│  ┌──────────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Foreground Mode  │  │  bg_manager  │  │  zfs_manager│ │
│  │  (inline exec)    │  │              │  │             │ │
│  └──────────────────┘  └──────┬───────┘  └──────┬──────┘ │
│                               │                    │       │
│                    ┌──────────┼────────┐    ┌─────┼───┐  │
│                    │          │        │    │     │   │  │
│              ┌─────▼────┐ ┌──▼───┐  ┌──▼───┐ ┌─▼──┐ ┌▼──┐│
│              │bg_proc_1 │ │ZFS_1 │  │ZFS_2 │ │ZFS_3│ │ZFS││
│              │(fleet)   │ │agent │  │agent │ │agent│ │bar││
│              └──────────┘ └──────┘  └──────┘ └────┘ └───┘│
│                                                            │
│              state.json (shared checkpoint)                │
└─────────────────────────────────────────────────────────────┘
```

### Process Manager State Machine

```
                    ┌─────────┐
                    │  START  │
                    └────┬────┘
                         │
                    ┌────▼─────┐
              ┌─────│ BACKGROUND │─────┐
              │     └────┬─────┘      │
              │          │             │
         ┌────▼──┐  ┌───▼────┐  ┌────▼─────┐
         │ FG    │  │ MIGRATE│  │ ZFS      │
         │ MODE  │  │ TO ZFS │  │ MODE     │
         └────┬──┘  └───┬────┘  └────┬─────┘
              │          │             │
         ┌────▼──────────▼─────────────▼─────┐
         │       ZFS_EXPORT / BG_STOP         │
         └─────────────────────┬──────────────┘
                               │
                        ┌──────▼──────┐
                        │ BACKGROUND  │
                        │ (detached)  │
                        └─────────────┘
```

---

## Data Model

### BackgroundProcessManager State

```typescript
interface BackgroundProcessState {
  // Whether the fleet is currently running in background mode
  running: boolean;

  // PID of the background process (null if not running)
  pid: number | null;

  // Path to the state file for this background run
  stateFile: string;

  // The mode of the background fleet
  mode: "background" | "zfs_exported";

  // When the background process was started
  startedAt: number;

  // ZFS session info if migrated to ZFS
  zfsSession?: {
    sessionName: string;
    layoutPath: string;
    agentPanes: string[];
    statusBarActive: boolean;
  };
}
```

### Migration State Transfer

When migrating between modes, the following state is transferred:

1. **FleetState** (phases, tasks, currentPhaseIndex, activeAgents, etc.)
2. **FleetTask** status (complete, running, pending, etc.)
3. **FleetPhase** status (running, complete, reviewing, etc.)
4. **Follow state** (which agent is being followed)
5. **Output buffers** (per-agent stdout/stderr capture)

State is serialized to `state.json` (shared checkpoint) and loaded by the target mode.

---

## Implementation Notes

### Background Process Spawning

The background process is spawned using `node:child_process.spawn()` with the `detached` option:

```typescript
const bgProc = spawn(
  process.execPath,
  [process.argv[1], '--bg-mode'],
  { detached: true, stdio: 'ignore' }
);
bgProc.unref();  // Allow parent to exit
```

The `--bg-mode` flag is detected by the caravel extension to load state from disk and begin execution without the interactive TUI.

### Migration to ZFS

Migration uses the existing ZFS process manager (ZFS class) to:
1. Create a ZFS session with the fleet layout
2. Spawn agent panes for each active task
3. Initialize the floating status bar
4. Transfer fleet state to ZFS tracking

### State Persistence

All state transitions save to `state.json` before the transition. This ensures:
- No state loss during mode changes
- Resume from any point after crash/restart
- Cross-session fleet continuation

---

## Future Enhancements

1. **Heartbeat**: Background process periodically writes heartbeat to disk; parent can detect dead processes
2. **Log streaming**: Background process log file can be streamed via `fleet_control(action="bg_log")`
3. **Auto-migration**: Detect long execution and auto-migrate to background/ZFS
4. **Cross-platform background**: Improve Windows support for detached processes (currently uses `wmic`/`taskkill`)
5. **ZFS multi-session**: Support multiple fleet sessions in separate ZFS sessions
