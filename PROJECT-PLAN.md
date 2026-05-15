# Phase P2: Health Monitoring & Stuck Detection - Project Plan

> Generated: 2026-05-15 from project planning phase
> Phases: 1
> Total Tasks: 10

---

## Phases

### ⏳ Phase 1: Phase P2: Health Monitoring & Stuck Detection

**Status**: pending

#### Tasks

- [○] **T1**: P2T1: Create extensions/caravel-health.ts with getHealthState(): returns persisted HealthState from .caravel/health.json
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: P2T1 Review: Verify extensions/caravel-health.ts exists with 4 exported functions, .caravel/health.json created as valid
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T3**: P2T2: Append detectStuckAgents(agents, thresholds?): StuckAgent[] to extensions/caravel-health.ts. Defaults: stuck=120s,
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: P2T2 Review: Verify extensions/caravel-health.ts has detectStuckAgents exported with correct signature and defaults (stu
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T5**: P2T3: Append nudgeAgent(agentIdentity, checkpoint): { context: string, nudgeCount: number, escalated: boolean } to exten
  - **Agent**: developer
  - **Review**: code + design
- [○] **T6**: P2T3 Review: Verify nudgeAgent exported, returns {context, nudgeCount, escalated}, nudge count increments, escalation=tr
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T7**: P2T4: Create buildHealthBar(healthState): string in extensions/caravel-health.ts. Format: '[agents: developer✓ tech-lead
  - **Agent**: developer
  - **Review**: code + design
- [○] **T8**: P2T4 Review: Verify buildHealthBar exported with correct icon format (✓/⚠/✗), widget bar integration in caravel.ts condi
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T9**: P2T5: Append startHealthChecks(thresholds?): number, stopHealthChecks(): void to extensions/caravel-health.ts. Defaults:
  - **Agent**: developer
  - **Review**: code + design
- [○] **T10**: P2T5 Review: Verify startHealthChecks/stopHealthChecks exported, 30s default, detectStuckAgents called each interval, au
  - **Agent**: tech-lead
  - **Review**: code + design

## Summary

- **Completed**: 0 tasks
- **Failed**: 0 tasks
- **Remaining**: 10 tasks

## Next Steps

1. Run `plan_project()` with more specific tasks if needed
2. Run `/go` to execute the fleet
3. Monitor progress in the widget bar

---

> Architecture reference: [PROJECT-DESIGN.md](./PROJECT-DESIGN.md)
> Full analysis: [ANALYSIS.md](./ANALYSIS.md)
