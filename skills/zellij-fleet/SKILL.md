---
name: zellij-fleet
description: User-facing documentation for interacting with Caravel fleet mode in Zellij. Covers starting the fleet session, monitoring agent panes, following agents, sending commands to agents directly, and the full workflow from start to finish. Use when the user asks about fleet mode, how to work with Zellij, how to monitor or control agents, or needs the Zellij keyboard shortcuts and pane management guide.
---

# Zellij Fleet Mode — User Guide

Caravel's fleet mode runs all agents inside a dedicated [Zellij](https://zellij.dev) session.
You get a full terminal multiplexer with panes for every agent, real-time output streaming,
and keyboard-driven control — no browser, no web UI, just your terminal.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Workspace Layout](#workspace-layout)
3. [Starting the Fleet](#starting-the-fleet)
4. [ZFS Session Commands](#zfs-session-commands)
5. [Monitoring Agent Panes](#monitoring-agent-panes)
6. [Following Agents](#following-agents)
7. [Interacting with Agents Directly](#interacting-with-agents-directly)
8. [Pane Lifecycle](#pane-lifecycle)
9. [Keyboard Shortcuts](#keyboard-shortcuts)
10. [Layout Variants](#layout-variants)
11. [Full Workflow](#full-workflow)
12. [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
# 1. Install Zellij (if you haven't)
# https://zellij.dev/tutorials/installation/

# 2. Tell Caravel to start the fleet
#    (via pi commands below, or use the tools directly)
/fleet

# 3. You're in a Zellij session with the orchestrator pane
#    focused. Agent panes are cycling in the right column.
```

That's it. The fleet is now running and agents are working.

---

## ZFS Session Commands

Caravel provides five `/zellij-*` commands for managing your fleet session:

| Command | Description |
|---------|-------------|
| `/zellij-start` | Launch the fleet in Zellij (session, panes, status bar) |
| `/zellij-stop` | Shutdown the ZFS session, terminate all panes |
| `/zellij-panes` | List all panes with status, IDs, and fleet state |
| `/zellij-follow [agent]` | Follow an agent's live output (list/switch/none too) |
| `/zellij-status` | Comprehensive fleet overview dashboard |

### `/zellij-start` — Launch fleet

Starts a new ZFS fleet session. If a session is already running, it shows the current state instead.

**Output includes:**
- Session name and layout source
- Number of agent panes
- Platform and shell info
- Agent pane list with descriptions
- Keyboard shortcut reference

**Example:**
```
✅ ZFS fleet session "caravel" started.

Session: caravel
Layout: custom (./zellij-layout.kdl)
Agent panes: 3
Platform: linux (bash)

Agent panes:
  ▸ developer        — Code implementation agent
  ▸ tech-lead        — Architecture review agent
  ▸ designer         — Visual review agent

Navigation:
  <leader>+o  →  Orchestrator   |  <leader>+d  →  Developer
  <leader>+t  →  Tech Lead      |  <leader>+D  →  Designer
  <leader>+s  →  Status bar     |  <leader>+w  →  Toggle status bar
  <leader>+1-5  →  Cycle panes  |  /zellij-panes  →  List panes
```

### `/zellij-stop` — Shutdown fleet

Terminates the ZFS session. Shows what was terminated.

**Example:**
```
ZFS session "caravel" stopped.

Terminated:
  Panes:  3
  Processes: 2
  Session: caravel
  Platform: linux (bash)
```

### `/zellij-panes` — List panes

Shows a detailed table of all ZFS panes and fleet state:

- **Running panes** with IDs (prefix `caravel-pid-<agent>-<timestamp>`)
- **Exited panes** with exit codes
- **Fleet state**: phases, progress, tasks, reviews, tokens, elapsed time
- **Navigation commands**

**Example output:**
```
╔═══════════════════════════════════════════════════════════╗
║  ZFS PANES                                               ║
╠═══════════════════════════════════════════════════════════╣
║  Session: caravel                              ║
║  ZFS: ✓ caravel                                   ║
║  Platform: linux (bash)                           ║
║
║  ▸ Running:                                               ║
║    ▸ developer (caravel-pid-developer-1716...) [running]║
║    ▸ tech-lead (caravel-pid-tech-lead-1716...) [running]║
║
║  Fleet State:                                             ║
║    Phases: 2/5  │  Progress: 40%    │  Elapsed: 5m 32s║
║    Tasks: 8/20  │  Reviews: 3     │  Tokens: 12.4k    ║
║
║  Commands:                                                ║
║    /zellij-panes  — This list                            ║
║    /zellij-follow <name>  — Follow an agent              ║
║    /zellij-status   — Fleet overview                     ║
║    /zellij-start    — Start fleet session                ║
║    /zellij-stop     — Stop fleet session                 ║
╚═══════════════════════════════════════════════════════════╝
```

### `/zellij-follow [agent]` — Follow agent output

Follow a specific agent's live output in the main pane.

**Sub-commands:**
| Command | Description |
|---------|-------------|
| `/zellij-follow list` | Show available agents and follow targets |
| `/zellij-follow <name>` | Follow a specific agent |
| `/zellij-follow switch` | Cycle to next running agent |
| `/zellij-follow none` | Stop following |

**Example:**
```
> Now following developer's output.
```

### `/zellij-status` — Fleet overview

Shows a comprehensive dashboard including:
- **ZFS Session**: availability, session name, platform
- **Fleet State**: current phase, progress, tasks, reviews, tokens, elapsed time
- **Phases Detail**: each phase with completion status
- **Active Agents**: status, model, task, token usage
- **Quick Actions**: all available fleet commands

**Example output:**
```
╔═══════════════════════════════════════════════════════════╗
║  CARAVEL FLEET OVERVIEW                                  ║
╠═══════════════════════════════════════════════════════════╣
║  ── ZFS Session ──                                      ║
║    ZFS: ✓ caravel                                   ║
║    Platform: linux (bash)                             ║
║    Shell: bash                               ║
║    Panes: 2 active / 1 exited  │  Processes: 3         ║
║
║  ── Fleet State ──                                      ║
║    ▸ RUN P2/5: Implementation                    ║
║    Progress: 40%  │  Tasks: 8/20  │  Elapsed: 5m 32s   ║
║    Reviews: 3  │  Tokens: 12.4k                         ║
║
║  ── Phases ──                                           ║
║    ✓ P1: Planning (3/3 tasks)                         ║
║    ▸ P2: Implementation (2/5 tasks) ← current          ║
║    ○ P3: Code Review (0/4 tasks)                      ║
║    ○ P4: Testing (0/3 tasks)                          ║
║    ○ P5: Deployment (0/2 tasks)                       ║
║
║  ── Active Agents ──                                    ║
║    ▸ developer        gpt-4o   Implement auth flow     ║
║    ▸ tech-lead        claude-  Review phase 1 output   ║
║
║  ── Quick Actions ──                                    ║
║    /zellij-start    — Start ZFS fleet                  ║
║    /zellij-stop     — Stop ZFS fleet                   ║
║    /zellij-panes    — List all panes                    ║
║    /zellij-follow   — Follow agent output               ║
║    /zellij-status   — This overview                     ║
║    /follow <agent>  — Follow agent (general)            ║
║    /fleet           — Toggle widget bar                  ║
║    /go              — Auto-orchestrate all phases        ║
║    /diagnose        — Diagnose errors                    ║
╚═══════════════════════════════════════════════════════════╝
```

## Workspace Layout

```
┌──────────────────────────────────┬───────────────────────────────┐
│                                  │  ┌─────────────────────────┐  │
│                                  │  │                         │  │
│         orchestrator             │  │    agent pane (1/3)     │  │
│    (left 60%, command-and-       │  │                         │  │
│     control centre)              │  │  ←  tab cycle →         │  │
│                                  │  │                         │  │
│                                  │  │    agent pane (2/3)     │  │
│                                  │  │                         │  │
│                                  │  │    agent pane (3/3)     │  │
│                                  │  └─────────────────────────┘  │
└──────────────────────────────────┤                               │
                                   │  ┌─────────────────────────┐  │
                                   │  │    status bar (6 lines) │  │
                                   │  └─────────────────────────┘  │
                                   └───────────────────────────────┘
```

**Three zones:**

| Zone | Pane | Purpose |
|------|------|---------|
| Left (60%) | `orchestrator` | The primary agent — plans, phases, and drives the fleet. This is your command-and-control centre. |
| Right (40%) | Agent panes | Tabbed view of individual agents: `developer`, `tech-lead`, `designer`. Cycle through them with `<leader>+1-5`. |
| Bottom-right | `status-bar` | Floating 6-line widget bar showing fleet progress. Toggle with `<leader>+w`. |

**Pane roles:**

| Pane | Role | When active |
|------|------|-------------|
| orchestrator | Main agent | Always — always your primary workspace |
| developer | Code implementation | During `run_phase` and active coding |
| tech-lead | Architecture review & planning | During `review_task` and planning phases |
| designer | Visual & UX review | During design review & UI-related tasks |
| planner | Project scoping | When project scope is unclear, interviewed via |
| auditor | Pre-flight scan | At project start, analyzes codebase |

---

## Starting the Fleet

### Automatic start (recommended)

The fleet starts automatically when you ask Caravel to work on a project:

```
/fleet
```

Or when you describe a project:

```
"I want to build a kanban board app with drag-and-drop"
```

Caravel will:

1. Detect Zellij is installed (or warn if it isn't)
2. Create a Zellij session named `caravel`
3. Load the fleet layout from `zellij-layout.kdl`
4. Spawn the orchestrator pane and any agent panes needed
5. Begin the planning phase

### Manual start

If you need to start the fleet manually, use the `/zellij-start` command:

```
/zellij-start
```

This will:
1. Check if Zellij is installed
2. Check if a session already exists (if running, shows current state)
3. Discover available agents and create a new session with the fleet layout
4. Initialize the floating status bar
5. Display a launch summary with navigation hints

### Stopping the ZFS session

To shut down the ZFS fleet session:

```
/zellij-stop
```

This terminates all agent panes, stops background processes, and kills the Zellij session. Fleet state is preserved for resumption.

### Checking fleet status

Use the fleet state tool to see what's running:

```
/zfs_fleet_state
```

Output shows:
- Whether Zellij is available
- Current session name
- Number of active/exited panes
- Platform and shell info

Or get a full fleet overview with:

```
/zellij-status
```

This shows a comprehensive dashboard: ZFS session status, fleet state (phases, tasks, progress), active agents with token usage, and quick action commands.

---

## Monitoring Agent Panes

### List all panes

```
/zfs_list_panes
```

Shows every pane with its status:

```
Active panes:
  ▸ developer (caravel-pid-developer-1716234567) [running]
  ▸ tech-lead (caravel-pid-tech-lead-1716234568) [running]
  ✗ designer (caravel-pid-designer-1716234569) [exited:0]
```

- `▸` = still running
- `✗` = exited (exit code shown)

### Real-time monitoring

The orchestrator pane streams agent output in real-time. Agent stdout is piped back to the orchestrator so you can watch progress without switching panes.

### Status bar

The floating status bar at the bottom-right shows:
- Current phase number
- Active agents
- Review pass/fail status
- Fleet health (Zellij availability, process counts)

Toggle it on/off with `<leader>+w`.

---

## Following Agents

### Following an agent's output

When you want to focus on one agent's work:

1. **Switch to the agent's pane** using the keyboard shortcuts below (e.g., `<leader>+d` for developer)
2. **Use the follow tool** to subscribe to that agent's stdout from the orchestrator:

```
/zfs_follow_pane --pane-id <pane_id>
```

### ZFS follow (main pane)

For a simpler follow experience, use `/zellij-follow`:

```
/zellij-follow list          # See available agents
/zellij-follow developer     # Follow the developer agent
/zellij-follow switch        # Cycle to next agent
/zellij-follow none          # Stop following
```

This follows the agent's live output in your main pane, with real-time streaming and the fleet widget showing the follow indicator.

### Stopping follow

```
/zfs_unfollow_pane --pane-id <pane_id>
```

### Finding an agent's pane ID

```
/zfs_list_panes
```

The pane ID is the unique identifier in parentheses. It follows the pattern:

```
caravel-pid-<agent-name>-<timestamp>
```

---

## Interacting with Agents Directly

### Sending commands to agents

You can send instructions to any running agent through the orchestrator. The orchestrator routes your command to the target agent's pane:

```
// Send a command to the developer agent
subagent("developer", "Add pagination to the kanban board")

// Send to tech-lead for review
subagent("tech-lead", "Review the architecture for phase 2")
```

### Pausing all agents

```
/zfs_pause
```

Sends SIGSTOP to all running panes. Agents freeze in place. Use during review or when you need to inspect state.

### Resuming all agents

```
/zfs_resume
```

Restarts all paused panes.

### Skipping an agent

If an agent's output is unhelpful or you want to stop it:

```
/zfs_skip_agent --agent-name developer
```

This terminates the agent's pane and frees resources.

### Stopping a specific pane

```
/zfs_stop_pane --pane-id <pane_id>
```

More precise than skipping by agent name — use when you know the exact pane ID.

---

## Pane Lifecycle

### Creating a session

```
/zfs_create_session --agents [{"name":"developer","description":"Implement features"}, {"name":"tech-lead","description":"Review architecture"}]
```

Generates and loads a Zellij layout with the specified agents.

### Spawning a new agent pane

```
/zfs_spawn_pane --agent-name "auditor" --task-description "Scan the codebase for security issues" --model "gpt-4"
```

- `--agent-name`: Unique name for the agent
- `--task-description`: The prompt/task for the agent
- `--model`: Optional model override (falls back to default)
- `--cwd`: Optional working directory

The agent runs in an isolated floating pane.

### Cleaning up

```
/zfs_cleanup
```

Terminates all panes, aborts background processes, and kills the Zellij session.

---

## Keyboard Shortcuts

The Zellij fleet session uses the following conventions:

### Pane Navigation

| Shortcut | Action |
|----------|--------|
| `<leader> + d` | Switch to developer pane |
| `<leader> + t` | Switch to tech-lead pane |
| `<leader> + D` | Switch to designer pane |
| `<leader> + p` | Switch to planner pane |
| `<leader> + a` | Switch to auditor pane |
| `<leader> + s` | Switch to status bar |
| `<leader> + o` | Return to orchestrator (main pane) |
| `<leader> + 1-5` | Cycle tab within right column |

### Pane Management

| Shortcut | Action |
|----------|--------|
| `<leader> + w` | Toggle floating status bar on/off |
| `<leader> + x` | Close current pane |
| `<leader> + h` | Split pane horizontally |
| `<leader> + v` | Split pane vertically |
| `Ctrl + arrow` | Resize focused pane |
| `Ctrl + Shift + arrow` | Move pane position |

### Session Management

| Shortcut | Action |
|----------|--------|
| `Ctrl + s` | Save layout |
| `Ctrl + Shift + s` | Switch to next session |
| `q` | Quit Zellij (confirm with `q` again) |

### Input Mode

| Shortcut | Action |
|----------|--------|
| `Ctrl + [` | Enter normal mode |
| `Ctrl + [` then `i` | Enter input mode |
| `Escape` | Return to normal mode |

> **Note:** The `<leader>` key defaults to `Ctrl` in Caravel's Zellij config. If you have a different leader key configured, substitute accordingly.

---

## Layout Variants

Caravel ships with four layout variants stored in `zellij-layout.kdl`:

### `fleet` (default)

Full 3-tab layout: orchestrator + developer + tech-lead + designer + status bar. Use for full project work.

```bash
zellij action switch-layout fleet
```

### `minimal`

Orchestrator + developer + status bar. Use during focused implementation.

```bash
zellij action switch-layout minimal
```

### `review`

Orchestrator + tech-lead (top) + designer (bottom), side-by-side. Use during the two-stage review gate.

```bash
zellij action switch-layout review
```

### `wide`

Orchestrator + developer + tech-lead side-by-side (equal thirds). Use during active development with both review agents visible.

```bash
zellij action switch-layout wide
```

### Custom layouts

You can edit `zellij-layout.kdl` directly to customize pane sizes, positions, and the number of agent panes. The layout is regenerated from this file when you create a new fleet session.

Use the layout tool to regenerate:

```
/zfs_layout --agents [...] --customWidth 70 --preview true
```

---

## Full Workflow

Here's the complete flow from project description to shipped code:

### Phase 1: Planning

```
User: "I want to build a kanban board app"
```

1. Caravel launches the fleet in Zellij (if not already running)
2. The `planner` agent interviews you about requirements
3. Planner produces a `plan_project` call with phases and tasks
4. Layout is generated for the agents that will participate

### Phase 2: Execution (repeated per phase)

```
run_phase(phaseIndex=0)
```

1. Agent panes are spawned for this phase (developer, tech-lead, etc.)
2. Each agent works in its own Zellij pane with real-time stdout streaming
3. You can:
   - Watch progress in the orchestrator pane
   - Switch to an agent's pane with `<leader>+d` to inspect work
   - Monitor the status bar for phase progress
   - Send commands to agents via `subagent()` calls
4. Status bar updates with phase number, active agents, and review status

### Phase 3: Review Gate (after each phase)

```
review_task(phaseIndex=0)
```

1. `tech-lead` reviews architecture and implementation
2. `designer` reviews visual/UX quality
3. If review passes → move to next phase
4. If review fails → you get a report on what needs fixing, the agent resumes with feedback

### Phase 4: Completion

All phases complete → fleet reports progress summary:

```
Phase 0: ✓ Planning (developer)
Phase 1: ✓ Implementation (developer, tech-lead)
Phase 2: ✓ Code review (tech-lead, designer)
Phase 3: ✓ Testing (developer)

All phases complete. 47 files changed, 1283 lines added.
```

### During execution — your options

| Action | How |
|--------|-----|
| Watch progress | Look at orchestrator pane or status bar |
| Inspect an agent's work | `<leader>+d` to switch to that pane |
| Pause all agents | `/zfs_pause` |
| Resume agents | `/zfs_resume` |
| Skip a failing agent | `/zfs_skip_agent --agent-name <name>` |
| Change layout | `zellij action switch-layout <variant>` |
| Check fleet state | `/zfs_fleet_state` |
| See all panes | `/zfs_list_panes` |
| Detach (leave running) | `Ctrl+Shift+d` in Zellij |
| Stop everything | `/zfs_cleanup` |

---

## Troubleshooting

### Zellij not found

Caravel will fall back to background processes. To get the full fleet experience:

```bash
# Linux/macOS
curl -LO https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz
tar xzf zellij-*.tar.gz && sudo mv zellij /usr/local/bin/

# macOS (Homebrew)
brew install zellij

# Windows (winget)
winget install Zellij.Zellij
```

Then restart Caravel.

### Session already exists

If `zellij action new-session -s caravel` fails because a session exists:

```bash
# Switch to existing session
zellij action switch-to-session caravel

# Or kill and restart
zellij kill-session caravel
```

### Agent panes not spawning

1. Check fleet state: `/zfs_fleet_state`
2. Verify Zellij is available (should show "✓ available")
3. Check the project's `zellij-layout.kdl` is valid KDL
4. Regenerate the layout: `/zfs_layout --agents [...] --preview true`

### Losing focus / can't type

You're in normal mode. Press `<Ctrl+Shift+i>` or `<Ctrl+[>i` to enter input mode, then type.

### Pane shows "exited" with a non-zero code

The agent encountered an error. Check:
- The orchestrator's logged output for error messages
- The agent's pane (`<leader>+<num>`) for stderr output
- Use `/zfs_list_panes` to confirm the pane ID and exit code
- You can restart the agent with `/zfs_spawn_pane`

### Status bar not visible

Toggle with `<leader>+w`. The floating pane may also be hidden behind another pane — cycle windows with `<Ctrl+Shift+o>` or switch to a different window.

---

## Reference: Fleet Tool Summary

| Tool | Description |
|------|-------------|
| `zfs_create_session` | Create a Zellij session with fleet layout |
| `zfs_spawn_pane` | Spawn an agent in a dedicated pane |
| `zfs_stop_pane` | Terminate a specific pane |
| `zfs_fleet_state` | Query fleet health and status |
| `zfs_pause` | Pause all running panes |
| `zfs_resume` | Resume all paused panes |
| `zfs_skip_agent` | Skip (terminate) a specific agent |
| `zfs_list_panes` | List all panes and their status |
| `zfs_layout` | Generate or preview fleet layout |

---

## Architecture Notes

- **Session name**: `caravel` (defined in `caravel.ts`)
- **Layout file**: `zellij-layout.kdl` in the project root
- **Pane ID format**: `caravel-pid-<agent-name>-<timestamp>`
- **Cross-platform**: The ZFS extension handles Windows/macOS/Linux differences in shell detection and process management
- **Fallback**: When Zellij is unavailable, agents run as background processes with stdout streamed back to the orchestrator
- **Environment**: All agent processes receive `CARRAVEL_FLEET=true` and `TERM=xterm-256color`
