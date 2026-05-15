# Phase P4: Predecessor Context Recovery - Project Plan

> Generated: 2026-05-15 from project planning phase
> Phases: 1
> Total Tasks: 8

---

## Phases

### ⏳ Phase 1: Phase P4: Predecessor Context Recovery

**Status**: pending

#### Tasks

- [○] **T1**: P4T1: Create extensions/caravel-seance.ts with recordTerminatedAgent(agentIdentity, taskId, phase, reason, checkpoint?),
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: P4T1 Review: Verify extensions/caravel-seance.ts exists with 4 exported functions, .caravel/seances.json created as vali
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T3**: P4T2: Append generateRecoveryContext(seance): string to extensions/caravel-seance.ts. Output ≤500 chars, deterministic. 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: P4T2 Review: Verify generateRecoveryContext exported, output ≤500 chars, includes workSummary/filesModified/toolCallHist
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T5**: P4T3: Modify runPhaseInternal in extensions/caravel.ts: on task complete → recordTerminatedAgent(agentIdentity, taskId, 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T6**: P4T3 Review: Verify caravel.ts compiles, seance recording on task complete/fail, captures workSummary and filesModified,
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T7**: P4T4: Modify task retry logic in extensions/caravel.ts: on retry → getSeance(taskId). If found, prepend: '[SEANCE RECOVE
  - **Agent**: developer
  - **Review**: code + design
- [○] **T8**: P4T4 Review: Verify caravel.ts compiles, retry gets seance prefix when found, format '[SEANCE RECOVERY] {recoveryContext
  - **Agent**: tech-lead
  - **Review**: code + design

## Summary

- **Completed**: 0 tasks
- **Failed**: 0 tasks
- **Remaining**: 8 tasks

## Next Steps

1. Run `plan_project()` with more specific tasks if needed
2. Run `/go` to execute the fleet
3. Monitor progress in the widget bar

---

> Architecture reference: [PROJECT-DESIGN.md](./PROJECT-DESIGN.md)
> Full analysis: [ANALYSIS.md](./ANALYSIS.md)
