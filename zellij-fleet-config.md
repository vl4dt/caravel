# Caravel-ZFS Configuration Guide

## Installing Zellij

### Linux

```bash
# Arch Linux
sudo pacman -S zellij

# Debian/Ubuntu (via package)
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | tar zxf - -C /usr/local/bin/

# Or via cargo
cargo install zellij --locked
```

### macOS

```bash
brew install zellij
```

### Windows

```powershell
winget install Zellij.Zellij
# Or download from https://github.com/zellij-org/zellij/releases
```

### Verify

```bash
zellij --version
# Should show: zellij vX.Y.Z
```

---

## Recommended Keybindings

Add these to your `~/.config/zellij/config.kdl` or `~/.zellij/config.kdl`:

```kdl
// Caravel Fleet keybindings
keybinds {
    // Pane navigation — switch between fleet panes
    normal {
        // Switch to orchestrator (main pane)
        bind "Ctrl+o" { SwitchPaneForward; }
        bind "Ctrl+p" { SwitchPaneBackward; }

        // Cycle right-column panes
        bind "Ctrl+Right" { SwitchPaneForward; }
        bind "Ctrl+Left" { SwitchPaneBackward; }

        // Status bar toggle
        bind "Ctrl+w" { ToggleFloatingPanes; }

        // Close current pane
        bind "Ctrl+x" { ClosePane; }

        // Split panes
        bind "Ctrl+h" { SplitHorizontal; }
        bind "Ctrl+v" { SplitVertical; }

        // Resize focused pane
        bind "Ctrl+Shift+Up" { Resize Up; }
        bind "Ctrl+Shift+Down" { Resize Down; }
        bind "Ctrl+Shift+Left" { Resize Left; }
        bind "Ctrl+Shift+Right" { Resize Right; }
    }

    // Session management
    normal {
        bind "Ctrl+s" { Save; }
        bind "Ctrl+Shift+s" { SwitchToNextSession; }
    }
}
```

---

## Layout Configuration

### Fleet Layout (default)

The default fleet layout in `zellij-layout.kdl` uses a **60/40 split**:

```
┌────────────────────────────┬───────────────────────────────┐
│                            │  ┌─────────────────────────┐  │
│     orchestrator           │  │                         │  │
│    (60%, left)             │  │  agent panes            │  │
│                            │  │  (40%, right)           │  │
│    Main fleet workspace    │  │                         │  │
│                            │  └─────────────────────────┘  │
├────────────────────────────┤                               │
│                            │  ┌─────────────────────────┐  │
│                            │  │   status bar            │  │
│                            │  └─────────────────────────┘  │
└────────────────────────────┴───────────────────────────────┘
```

### Layout Variants

Switch layouts with `zellij action switch-layout <name>`:

| Layout | Use Case |
|--------|----------|
| `fleet` (default) | Full workspace — orchestrator + developer + tech-lead + designer |
| `minimal` | Focused coding — orchestrator + developer only |
| `review` | Two-stage review — orchestrator + tech-lead + designer |
| `wide` | Side-by-side — orchestrator + developer + tech-lead |

### Customizing Pane Sizes

Edit `zellij-layout.kdl` and adjust `size:` values. The orchestrator pane takes `size: <N>` for the left column, and agent panes take the remainder.

```kdl
// Make orchestrator wider (70%)
pane {
    type: "main"
    align: "left"
    size: 70        // ← changed from 60 to 70
    name: "orchestrator"
    focus: true
}

// Agent panes will automatically get 30% each
```

### Pane Positions

Zellij supports flexible pane placement. You can rearrange panes manually:

1. `Ctrl+Shift+arrow` to move a pane
2. `Ctrl+Shift+o` to cycle through floating panes
3. `Ctrl+Shift+d` to detach the current session (keeps it running)

---

## Multi-Monitor Setup

### Option 1: Status bar on second monitor

Move the floating status bar to a separate window:

```kdl
floating {
    name: "status-bar"
    y: "bottom"        # Position on screen
    x: "right"
    max_width: 80
    height: 6
}
```

Then use Zellij's window management to move it:
1. `Ctrl+Shift+o` to cycle windows
2. Drag the floating window to your second monitor

### Option 2: Orchestrator on primary, agents on secondary

```kdl
window {
    // Primary monitor: orchestrator (wider)
    pane {
        type: "main"
        align: "left"
        size: 75
        name: "orchestrator"
        focus: true
    }

    // Secondary monitor: agent panes
    pane {
        align: "right"
        size: 25
        name: "developer"
    }

    pane {
        align: "right"
        size: 25
        name: "tech-lead"
    }
}
```

---

## Troubleshooting

### Zellij not found

Caravel will fall back to background processes. To install:

```bash
# Check if zellij is installed
zellij --version

# If not found, install using the commands above
```

### Session already exists

```bash
# List existing sessions
zellij list-sessions

# Switch to existing session
zellij action switch-to-session caravel

# Kill and restart
zellij kill-session caravel
```

### Agent panes not spawning

1. Verify ZFS is available: `/zfs_fleet_state`
2. Check that `zellij-layout.kdl` is valid
3. Regenerate: `/zfs_layout --agents [...] --preview true`

### Can't type in panes

You're in normal mode. Press `Ctrl+[` then `i` to enter input mode.

### Pane shows "exited" with non-zero code

Check the agent's stderr output in the orchestrator pane. Use:
- `/zfs_list_panes` to confirm the pane ID and exit code
- `/zellij-follow <agent>` to follow that agent's output

---

## Environment Variables

Caravel sets these environment variables for all ZFS agent processes:

| Variable | Value | Purpose |
|----------|-------|---------|
| `CARAVEL_FLEET` | `true` | Identifies fleet-managed processes |
| `TERM` | `xterm-256color` | Enables 256-color output in panes |
| `CARRAVEL_PANE_ID` | `caravel-pid-<agent>-<ts>` | Unique pane identifier |

You can override these in your `~/.config/zellij/config.kdl` if needed.

---

## Performance Tips

1. **Use `minimal` layout** during active implementation — fewer panes = less memory
2. **Detach** (`Ctrl+Shift+d`) during long-running tasks — frees your terminal
3. **Close unused panes** — each pane consumes resources
4. **Use `review` layout** during two-stage review — both reviewers visible at once

---

## Keyboard Shortcuts Reference

| Shortcut | Action |
|----------|--------|
| `Ctrl+o` | Switch to orchestrator (main pane) |
| `Ctrl+d` | Switch to developer pane |
| `Ctrl+t` | Switch to tech-lead pane |
| `Ctrl+D` | Switch to designer pane |
| `Ctrl+p` | Switch to planner pane |
| `Ctrl+a` | Switch to auditor pane |
| `Ctrl+s` | Save layout |
| `Ctrl+Shift+s` | Switch to next session |
| `Ctrl+w` | Toggle status bar on/off |
| `Ctrl+x` | Close current pane |
| `Ctrl+h/v` | Split pane horizontally/vertically |
| `Ctrl+Shift+arrow` | Resize focused pane |
| `Ctrl+Shift+o` | Cycle floating panes |
| `Ctrl+Shift+d` | Detach current session |
| `q` then `q` | Quit Zellij (confirm with second `q`) |

> **Note:** These assume the default Zellij keybinds. If you've customized your keybinds, substitute accordingly.
