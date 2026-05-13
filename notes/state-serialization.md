# Fleet State Serialization — Design Decisions

## Overview

Caravel persists the entire fleet state (phases, tasks, progress, tokens, review status) to a JSON file on disk after every meaningful operation. This enables:

1. **Pause/Resume**: `fleet_control(action="pause")` saves state → `fleet_control(action="resume")` loads state and continues from exact point.
2. **Crash Survival**: If pi crashes or a blackout occurs, the next `run_phase` call loads the last saved state from disk.
3. **Background Mode**: Fleet can be launched as a detached background process that survives closing the terminal.

## State File

- **Location**: `.caravel/state.json` (relative to project root)
- **Format**: JSON with `version`, `timestamp`, and `state` fields
- **Schema Version**: `STATE_VERSION` — auto-incremented when schema changes; older files are rejected with a warning
- **Atomic Writes**: Uses temp file + `fs.rename` to prevent corruption from mid-write crashes

## State Contents

The saved `fleetState` includes:
- `phases`: All project phases with tasks, statuses, review results
- `currentPhaseIndex`: Currently executing phase
- `paused`: Whether execution is blocked
- `startTime`: Fleet start time
- `reviewIterations`: Current review cycle count
- `totalFleetTokens`: Total tokens consumed across all agents
- `activeAgents`: Currently active agent instances
- `mainAgentActivity`: Last known agent activity

## Loading State

- `loadState(ctx)` reads the JSON file, validates schema version, and restores `fleetState`
- Returns `true` if valid state was loaded, `false` otherwise
- Called automatically at extension startup via `fleetControl` initialization
- If no state file exists, fleet starts fresh

## Pause/Resume Workflow

1. `fleet_control(action="pause")` → calls `saveState()` then sets `fleetState.paused = true`
2. While paused, `run_phase` checks `fleetState.paused` and blocks execution
3. `fleet_control(action="resume")` → calls `loadState(ctx)` then sets `fleetState.paused = false`
4. Execution continues from the exact task that was active when paused

## Surviving Interruptions

- **Process Restart**: State is saved before every task starts. On restart, `loadState()` restores progress.
- **Blackout**: If the system loses power, the last `saveState()` call (using atomic rename) is the recovery point.
- **Background Mode**: Fleet can be exported to a background process that runs independently of the terminal session.
