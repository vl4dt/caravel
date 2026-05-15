# ZFS (Zellij Fleet Session) — Audit Report

**Date:** 2026-05-15  
**Scope:** All ZFS-related code in `extensions/caravel.ts` and `zellij-layout.kdl`  
**Source:** Zellij v0.41+ official documentation (zellij.dev)

---

## Critical Issues

### 1. `zellij session create` — Command Does Not Exist
**Location:** `ZFS.createSession()` line ~1160  
**Code:** `zellij session create -s <name> --layout <file>`  
**Problem:** Zellij has **no** `session create` subcommand.  
**Fix:** Use `zellij -s <name> --layout <file>` to start a new session with a layout.

---

### 2. `-d floating` is Invalid for `new-pane`
**Location:** `ZFS.spawnPane()` line ~1322  
**Code:** `zellij action new-pane -n <name> -d floating`  
**Problem:** `-d` accepts `right|left|up|down` (direction), NOT `floating`.  
**Fix:** Use `-f` or `--floating` flag: `zellij action new-pane -n <name> -f`

---

### 3. `resize increase` is Invalid
**Location:** `ZFS.resizePane()` line ~1375  
**Code:** `zellij action resize increase -s <session> -n <pane>`  
**Problem:** Valid directions are `right|left|up|down|+|-`. `increase` is not valid.  
**Fix:** Use `zellij action resize + -p <pane_id>` to increase size.

---

### 4. `send-keys` Cannot Send Signals
**Location:** `ZFS.sendSignalToPane()` line ~1477  
**Code:** `zellij action send-key -s <session> -n <pane> SIGTERM`  
**Problem:** `send-keys` accepts key names like "Enter", "Ctrl a", "F1" — NOT Unix signals.  
**Fix:** Use `process.kill(pid, "SIGTERM")` on the actual PID for signals. The pane's PID is available via `pane.process.pid`.

---

### 5. `switch-to-session` → `switch-session`
**Location:** `ZFS.switchToSession()` line ~1213  
**Code:** `zellij action switch-to-session <name>`  
**Problem:** The correct action is `switch-session` (no hyphen).  
**Fix:** `zellij action switch-session <name>`

---

### 6. `getLastRendered()` Method Doesn't Exist
**Location:** `zfs_status_bar_render` tool line ~1653  
**Code:** `self.statusBarManager?.getLastRendered()`  
**Problem:** `ZFSStatusBarManager` has no `getLastRendered()` method.  
**Fix:** Add a `getLastRendered()` method to `ZFSStatusBarManager` that stores the last rendered content, or remove this tool.

---

## Moderate Issues

### 7. `kill-session` (singular) → `kill-sessions` (plural)
**Location:** `ZFS.killSession()` line ~1202  
**Code:** `zellij kill-session <name>`  
**Problem:** The top-level subcommand is `kill-sessions` (plural).  
**Fix:** `zellij k <name>` or `zellij kill-sessions <name>`

### 8. `list-sessions` Output Parsing
**Location:** `ZFS.listSessions()` line ~1244  
**Code:** Parses output as `parts[0] = name, parts[1] = layout`  
**Problem:** The actual `zellij list-sessions` output format may have changed. Modern output is:
```
caravel (2 panes, 1 window)
```
or with `--json`. The old space-delimited format may be broken.  
**Fix:** Use `zellij list-sessions --json` and parse the JSON output.

### 9. `close-pane` Uses `-s` for Session
**Location:** `ZFS.stopPane()` line ~1357  
**Code:** `zellij action close-pane -s <session>`  
**Problem:** `close-pane` uses `--pane-id` not `-s` for session targeting. The `-s` flag is a top-level option, not an action option.  
**Fix:** Use `zellij -s <session> action close-pane` (session flag at top level).

### 10. `write-chars` Clears Before Writing
**Location:** `ZFSStatusBarManager.updatePane()` line ~846  
**Code:** Calls `clear` then writes each line with `write-chars` + `send-keys Enter`  
**Problem:** `clear` clears the **focused** pane, not the target pane (missing `-p`). Also, the approach of writing line-by-line with newlines causes cursor issues.  
**Fix:** Use `zellij -s <session> action clear -p <pane_id>`, then write the full content at once with `write-chars -p <pane_id>`.

### 11. `detach` as Action vs Top-Level
**Location:** `ZFS.detachSession()` line ~1296  
**Code:** `zellij action detach`  
**Problem:** `detach` is a top-level subcommand (`zellij detach`), not an action.  
**Fix:** `zellij detach` (top-level).

### 12. `switchToFleetLayout` Hardcodes "fleet"
**Location:** `ZFS.switchToFleetLayout()` line ~1224  
**Code:** `zellij action switch-layout fleet`  
**Problem:** Hardcoded `"fleet"` — if the layout file uses a different name, this fails.  
**Fix:** Read the layout name from the KDL file or accept it as a parameter.

### 13. `paneId` Detection from `new-pane` Output is Fragile
**Location:** `ZFSStatusBarManager.createFloatingPane()` line ~820  
**Code:** `stdout.trim().match(/^(terminal_\d+)$/m)?.[1]`  
**Problem:** The pane creation output format may vary. The pane ID might not match this regex.  
**Fix:** Use `--json` flag or `zellij action list-panes --json` to reliably get pane IDs.

---

## Minor Issues

### 14. `resizePane` Ignores `height` Parameter
**Location:** `ZFS.resizePane()` line ~1373  
**Code:** `resizePane(paneId, width, height)` but only calls `resize increase`  
**Fix:** Accept that Zellij CLI doesn't support setting exact dimensions via CLI (only relative resize).

### 15. `zfs_layout` Tool Creates Files But Never Verifies
**Location:** `zfs_layout` tool line ~7003  
**Code:** Writes KDL to file but doesn't verify the result.  
**Fix:** Add a `--validate` option to check the KDL syntax.

### 16. `listPanes()` Only Tracks ZFS-Created Panes
**Location:** `ZFS.listPanes()` line ~1368  
**Problem:** Only returns panes tracked in the internal `this.panes` Map. Misses any panes created externally.  
**Fix:** Use `zellij action list-panes --all --json` for complete listing.

### 17. `spawnPane` Pane Name Collision
**Location:** `ZFS.spawnPane()` line ~1305  
**Code:** Uses `-n <agentName>` for pane name  
**Problem:** If two agents have the same name or panes from different sessions collide.  
**Fix:** Use unique pane names or rely on auto-generated pane IDs.

### 18. `clear` Without `-p` Clears Focused Pane
**Location:** `ZFSStatusBarManager.updatePane()` line ~846  
**Code:** `zellij action clear -s <session>`  
**Problem:** `clear` without `-p` targets the **focused** pane, not the status-bar pane.  
**Fix:** Use `zellij -s <session> action clear -p <pane_id>`.

---

## Layout File Issues

### 19. `zellij` Placeholder in Pane Commands
**Location:** `zellij-layout.kdl` all panes  
**Code:** `command: "zellij"  args: ["--help"]`  
**Problem:** All panes have `zellij --help` as their command — this is a placeholder, not functional.  
**Fix:** The layout file is auto-generated by `generateFleetLayout()`, which also sets `command: "zellij"` and `args: ["--help"]`. These should be dynamic or documented as placeholders.

### 20. `floating` Status Bar Pane Has No Command
**Location:** `zellij-layout.kdl` line ~177  
**Code:** `floating { name: "status-bar" ... }`  
**Problem:** The floating pane is created by the layout but has no command. The status bar content is written by `ZFSStatusBarManager` via `write-chars`. If the layout doesn't specify a command, the pane shows an empty shell.  
**Fix:** Add `command: "cat"` to the floating pane so it's ready for `write-chars`.

---

## Summary

| Severity | Count | Issues |
|----------|-------|--------|
| Critical | 6 | #1, #2, #3, #4, #5, #6 |
| Moderate | 8 | #7, #8, #9, #10, #11, #12, #13, #18 |
| Minor | 6 | #14, #15, #16, #17, #19, #20 |

**Priority fixes:** #1, #2, #3, #4 are the most likely to break ZFS functionality entirely. The session creation (#1) and floating pane creation (#2) are the most critical.
