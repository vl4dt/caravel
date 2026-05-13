# Caravel — Project Plan

> Generated: 2026-05-13 from project planning phase
> Phases: 5
> Total Tasks: 16

---

## Phases

### ✅ Phase 0: UI Output Fixes (Quick Wins)

**Status**: complete

#### Tasks

- [✓] **T1**: Fix run_phase execution output — remove garbage tokens from agent name display; added `○`/`WAIT` status for pending tasks; output format: `▸ T2 [RUN] developer → ... (model) [72k tokens] | 16m`
- [✓] **T2**: Fix widget bar reviews line — replaced "○ pending" with "○ 0 approved ○ 0 pending"; removed confusing "●" prefix and " reviews" suffix
- [✓] **T3**: Fix tokens line — clarified "fleet total" vs "per-agent" distinction; updated legend to show `fleet total │ per-agent: N i / N o`

### ✅ Phase 1: Core Foundations

**Status**: complete

#### Tasks

- [✓] **T4**: Fleet state serialization — `saveState()`/`loadState()` with atomic writes documented in `notes/state-serialization.md`
- [✓] **T5**: Fleet pause/resume with state persistence — `fleet_control(action="pause"/"resume")` documented alongside T4
- [✓] **T6**: Background process management with ZFS migration — `exportToBackground()`, `--bg-mode` documented in `notes/zfs-migration.md`
- [✓] **T7**: Enforce testability criteria on every task — `testability-enforcement.ts` with full test suite

### ✅ Phase 2: Agent Updates

**Status**: complete

#### Tasks

- [✓] **T8**: Created `agents/documenter.md` — new Documenter agent with write/keep documentation responsibilities, tools (read/write/edit/grep), model config, output format spec
- [✓] **T9**: Updated `agents/designer.md` — added UI/UX guidelines, design system creation, UI asset building responsibilities; added design tokens, component library, style guides
- [✓] **T10**: Updated review skill chain (code-review.md, design-review.md) — added gate check verifying deliverables match task spec before next task starts; checklist blocks completion until all files exist, no TODOs/placeholders, imports valid, no stub implementations

### ✅ Phase 3: Review Quality Improvement

**Status**: complete

#### Tasks

- [✓] **T11**: Implemented logic error detection in code-review — added checks for: missing imports, missing definitions, stub/placeholder code, unreachable branches, type mismatches, missing error handling; updated code-review.md with new detection rules
- [✓] **T12**: Implemented design review quality improvements — added checks for: missing responsive behavior, design token consistency, accessibility violations, component prop type mismatches; updated design-review.md

### ✅ Phase 4: Integration & Metrics

**Status**: complete

#### Tasks

- [✓] **T13**: Implemented metrics collection system — `extensions/metrics.ts` collecting task duration, review cycle count, tokens per agent, pass/fail rates, phase duration; exports JSON/CSV; `notes/metrics-spec.md` documents all metrics and formulas
- [✓] **T14**: Implemented Telegram notification integration — `extensions/integrations/telegram.ts` with task start/complete/failure messages, user input relay, monitoring mode; config schema for webhook/bot token
- [✓] **T15**: Implemented Linear integration — `extensions/integrations/linear.ts` with create/update issues from tasks, sync status, webhook; API auth config
- [✓] **T16**: Implemented Plane integration — `extensions/integrations/plane.ts` with create/update issues, sync status, webhook; same pattern as Linear adapted to Plane API

---

## Summary

- **Completed**: 16/16 tasks (100%)
- **Failed**: 0 tasks
- **Remaining**: 0 tasks

## New Features Delivered

| Category | Features |
|----------|----------|
| UI Output | Clean task progress format, fixed review counts, clarified token display |
| State Mgmt | Persistent state, pause/resume, background mode, ZFS migration |
| Agents | New Documenter agent, enhanced Designer with design system responsibilities |
| Reviews | Logic error detection, gate checks, design token consistency, responsive verification |
| Metrics | Task duration, review cycles, tokens, pass/fail rates (JSON/CSV export) |
| Integrations | Telegram notifications, Linear sync, Plane sync |

## Agent Models

All agents use local Docker models (no external dependencies):

| Agent | Model |
|-------|-------|
| developer | `docker-models/docker.io/ai/qwen3-coder:32k` |
| tech-lead | `docker-models/docker.io/ai/qwen3-coder:32k` |
| designer | `docker-models/docker.io/ai/glm-4.7-flash:32k` |
| documenter | `docker-models/docker.io/ai/qwen3-coder:32k` |
| planner | `docker-models/docker.io/ai/qwen3-coder:32k` |
| auditor | `docker-models/docker.io/ai/qwen3-coder:32k` |

## Documentation

| Document | Path |
|----------|------|
| Fleet State Serialization | `notes/state-serialization.md` |
| ZFS Migration Decisions | `notes/zfs-migration.md` |
| Metrics Specification | `notes/metrics-spec.md` |
| Main Skill | `SKILL.md` |
| Project Design | `PROJECT-DESIGN.md` |
| Analysis | `ANALYSIS.md` |

## Next Steps

1. Test fleet execution with `plan_project()` + `/caravel-go`
2. Configure Telegram bot token in `integrations/telegram.ts` when ready
3. Configure Linear API key in `integrations/linear.ts` when ready
4. Test Plane integration with mock server
