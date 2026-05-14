# Gas Town/City Improvements to Caravel - Project Plan

> Generated: 2026-05-14 from project planning phase
> Phases: 5
> Total Tasks: 25

---

## Phases

### ⏳ Phase 1: P1: Agent Identity & Session Recovery

**Status**: pending

#### Tasks

- [○] **T1**: Create extensions/caravel-identity.ts with getAgentIdentity, listAgentIdentities, resetAgentIdentity. Persists to .carav
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Review caravel-identity.ts and caravel-identity.test.ts. Verification: check identity format matches spec, file I/O asyn
  - **Agent**: tech-lead
  - **Review**: code + design
- [○] **T3**: Append work history to caravel-identity.ts: recordWork, getAgentHistory, getPhaseHistory. Persists to .caravel/history.j
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: Create extensions/caravel-checkpoints.ts with saveCheckpoint, loadCheckpoint, listCheckpoints, deleteCheckpoint, generat
  - **Agent**: developer
  - **Review**: code + design
- [○] **T5**: Append periodic checkpointing to caravel-checkpoints.ts: startPeriodicCheckpointing, stopPeriodicCheckpointing. Default 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T6**: Modify runPhaseInternal in caravel.ts: on task retry inject checkpoint context, on task start resolve agent identity. Al
  - **Agent**: developer
  - **Review**: code + design
- [○] **T7**: Review caravel.ts modifications. Verification: check context injection format correct, identity resolution correct, all 
  - **Agent**: tech-lead
  - **Review**: code + design

### ⏳ Phase 2: P2: Health Monitoring & Stuck Detection

**Status**: pending

#### Tasks

- [○] **T1**: Create extensions/caravel-health.ts with getHealthState, updateAgentHealth, listAgentHealth, clearHealthState. Persists 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Append stuck detection to caravel-health.ts: detectStuckAgents returning StuckAgent[]. Defaults stuck=120s, zombie=300s.
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Append auto-recovery to caravel-health.ts: nudgeAgent returning {context, nudgeCount, escalated}. Default maxNudges=2. C
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: Add health bar to caravel.ts widget: buildHealthBar(healthState) returning '[agents: developer✓ tech-lead⚠ designer✓]'. 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T5**: Append health check interval to caravel-health.ts: startHealthChecks returning timerId, stopHealthChecks clearing timerI
  - **Agent**: developer
  - **Review**: code + design

### ⏳ Phase 3: P3: Inter-Agent Messaging

**Status**: pending

#### Tasks

- [○] **T1**: Create extensions/caravel-messaging.ts with sendMessage, getMessages, markAsRead, getMessagesByChannel. Persists to .car
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Append channels to caravel-messaging.ts: DEFAULT_CHANNELS=['general','review','escalation'], getAvailableChannels, getCh
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Append nudge/escalation to caravel-messaging.ts: sendNudge (priority='high', 5min expiry), escalate (priority='escalatio
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: Add message indicators to caravel.ts widget: show '[3 unread]' and '[1 escalation]' in widget bar. Conditional on config
  - **Agent**: developer
  - **Review**: code + design

### ⏳ Phase 4: P4: Predecessor Context Recovery

**Status**: pending

#### Tasks

- [○] **T1**: Create extensions/caravel-seance.ts with recordTerminatedAgent, getSeanceHistory, getSeance, clearSeance. Persists to .c
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Append recovery query to caravel-seance.ts: generateRecoveryContext returning deterministic string ≤500 chars. Create ex
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Modify runPhaseInternal in caravel.ts: on task complete/failed call recordTerminatedAgent. On task retry call getSeance 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: Append seance cleanup to caravel-seance.ts: cleanupSeances(maxAgeHours=24, maxRecordsPerAgent=10) returning clean count.
  - **Agent**: developer
  - **Review**: code + design

### ⏳ Phase 5: P5: Integration & Config

**Status**: pending

#### Tasks

- [○] **T1**: Create extensions/caravel-config.ts: DEFAULT_CONFIG (all disabled), getConfig, updateConfig, initializeConfig. Persists 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T2**: Append config init to caravel-config.ts: initializeConfig creates .caravel/ with all feature files. Returns {created, fi
  - **Agent**: developer
  - **Review**: code + design
- [○] **T3**: Wire all integration hooks into runPhaseInternal: (1) phase start: load config + init features, (2) task start: resolve 
  - **Agent**: developer
  - **Review**: code + design
- [○] **T4**: Add health to ZFS status bar in caravel.ts: modify renderStatusBar and renderCompactStatusBar to include health icons. C
  - **Agent**: developer
  - **Review**: code + design
- [○] **T5**: Update README.md with 4 feature sections (config examples, activation, troubleshooting), update .gitignore with new .car
  - **Agent**: developer
  - **Review**: code + design

## Summary

- **Completed**: 0 tasks
- **Failed**: 0 tasks
- **Remaining**: 25 tasks

## Next Steps

1. Run `plan_project()` with more specific tasks if needed
2. Run `/go` to execute the fleet
3. Monitor progress in the widget bar

---

> Architecture reference: [PROJECT-DESIGN.md](./PROJECT-DESIGN.md)
> Full analysis: [ANALYSIS.md](./ANALYSIS.md)
