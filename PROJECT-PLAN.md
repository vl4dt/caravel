# Caravel-Zellij Fleet Integration — Project Plan

> Generated: 2026-05-12 from project planning phase
> Phases: 3
> Total Tasks: 10

---

## Phases

### ✅ Phase 1: Core Architecture & Zellij Layout Engine

**Status**: pending

#### Tasks

- [○] **T1**: Create zellij-layout.kdl — a fleet workspace layout with main orchestrator pane, per-agent panes (max 3 visible), and a 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Create extensions/zellij-fleet.ts — the Zellij process manager. Key responsibilities: (1) Generate and launch Zellij ses
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Create skills/zellij-fleet.md — the skill documentation describing how users interact with Zellij fleet mode. Include: s
  - **Agent**: developer
  - **Review**: code + design

### ✅ Phase 2: Real-time Monitoring & Follow System

**Status**: pending

#### Tasks

- [○] **T1**: Implement the follow/unfollow system: when the user follows an agent, show its live output in the main pane. Support swi
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Implement the Zellij status bar — a persistent summary showing all agents' status (running/idle/error), progress, and to
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Add new Pi commands: /zellij-start (launch fleet in Zellij), /zellij-stop (shutdown Zellij session), /zellij-follow (fol
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: Add the Zellij fleet orchestrator tool `zellij_fleet` — a single tool that replaces multiple individual agent spawns wit
  - **Agent**: developer
  - **Review**: code + design

### ⏳ Phase 3: User Interaction & Professional Orchestration

**Status**: pending

#### Tasks

- [○] **T1**: Implement the 'user follow mode' — when the user follows an agent, allow them to type commands into that agent's pane. T
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Create zellij-fleet-config.md — configuration guide for users. Covers Zellij installation, recommended keybindings, layo
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Update SKILL.md with Zellij fleet mode documentation — new workflow section showing how to use Zellij mode for fleet orc
  - **Agent**: developer
  - **Review**: code + design

## Summary

- **Completed**: 4 tasks
- **Failed**: 0 tasks
- **Remaining**: 6 tasks

## ZFS Status Bar — Implementation Notes

The ZFS status bar (Phase 2, Task 2) is implemented in `extensions/zfs_status_bar.ts`:

- **10-line floating pane** showing agent statuses, phase progress, token usage
- **Auto-refreshes** every 2 seconds when ZFS mode is active
- **Tools**: `zfs_status_bar_info`, `zfs_status_bar_update`, `zfs_status_bar_render`, `zfs_status_bar_toggle`
- **Layout**: All layout variants updated with `height: 10` for the status bar pane
- **Fallback**: Shows inline status bar text when ZFS is not available

## Next Steps

1. Run `plan_project()` with more specific tasks if needed
2. Run `/go` to execute the fleet
3. Monitor progress in the widget bar

---

> Architecture reference: [PROJECT-DESIGN.md](./PROJECT-DESIGN.md)
> Full analysis: [ANALYSIS.md](./ANALYSIS.md)
