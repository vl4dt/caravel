---
plan: Gas Town/City improvements to Caravel
date: 2026-05-14
status: planned
---

# Caravel Improvement Plan: Gas Town / Gas City Learnings

Based on deep analysis of Gas Town (`gastownhall/gastown`) and Gas City (`gastownhall/gascity`), this plan adds 4 high-value features to Caravel while avoiding Gas Town/City's complexity traps.

**Source Analysis:** `ANALYSIS-CARAVEL-vs-GAS-TOWN-CITY.md` (22KB)  
**Implementation Target:** `extensions/caravel.ts` (~6,337 lines) + new module files

## Design Decisions

### Adopting (from Gas Town/City):
1. Persistent agent identity (Gas Town's `rig/polecats/alpha`)
2. Health monitoring (Witness/Deacon watchdog)
3. Inter-agent messaging (gt mail/nudge)
4. Predecessor context recovery (gt seance)

### Avoiding (from Gas Town/City):
- No Dolt dependency, no Go rewrite, no 20-30 agent scale, no Mad Max naming, no TOML-by-committee

### Implementation: All features opt-in via `.caravel/config.json`, zero new dependencies, backward compatible, modular, testable.

---

## Phase P1: Agent Identity & Session Recovery

### Task P1T1: Agent Identity Registry Module
- **File:** `extensions/caravel-identity.ts` (NEW)
- **Exports:** `getAgentIdentity(name: string): string`, `listAgentIdentities(): string[]`, `resetAgentIdentity(name: string): void`
- **Persistence:** `.caravel/agents.json` with `{ identity, created, worktree }` per agent
- **Testable:** 1) getAgentIdentity returns `caravel/<name>/primary`, creates file if missing 2) listAgentIdentities returns persisted identities 3) resetAgentIdentity removes entry 4) Identities deterministic across calls 5) File persists as valid JSON
- **Deliverable:** File `extensions/caravel-identity.ts` with 3 exported functions, `.caravel/agents.json` on first call
- **Verification:** Create extensions/caravel-identity.test.ts with tests for identity format, file persistence, deterministic generation; Run `npx tsx extensions/caravel-identity.test.ts` to verify

### Task P1T2: Agent Work History
- **File:** `extensions/caravel-identity.ts` (append)
- **Exports:** `recordWork(identity, taskId, phase, summary)`, `getAgentHistory(identity): WorkEntry[]`, `getPhaseHistory(phase): WorkEntry[]`
- **Persistence:** `.caravel/history.json` with auto-rotate at 100 entries/agent
- **Testable:** 1) recordWork appends entry 2) getAgentHistory returns agent's entries 3) getPhaseHistory filters by phase 4) Auto-rotate removes oldest at 100 5) History persists as JSON array
- **Deliverable:** 3 functions appended to caravel-identity.ts, `.caravel/history.json` with WorkEntry objects
- **Verification:** Create extensions/caravel-identity.test.ts with work history tests; Run `npx tsx extensions/caravel-identity.test.ts` to verify

### Task P1T3: Task Checkpoint System
- **File:** `extensions/caravel-checkpoints.ts` (NEW)
- **Exports:** `saveCheckpoint(taskId, agentName, state)`, `loadCheckpoint(taskId) | null`, `listCheckpoints(agentName?)`, `deleteCheckpoint(taskId)`, `generateContextSummary(toolCalls, output): string`
- **Persistence:** `.caravel/checkpoints/<taskId>-checkpoint.json`
- **Testable:** 1) saveCheckpoint writes valid JSON to file 2) loadCheckpoint returns last checkpoint or null 3) listCheckpoints filters by agent name 4) deleteCheckpoint removes file 5) generateContextSummary produces deterministic <200 char string
- **Deliverable:** File `extensions/caravel-checkpoints.ts` with 5 exported functions, checkpoint file on disk
- **Verification:** Create extensions/caravel-checkpoints.test.ts with tests for save/load/rotate; Run `npx tsx extensions/caravel-checkpoints.test.ts` to verify

### Task P1T4: Periodic Checkpointing
- **File:** `extensions/caravel-checkpoints.ts` (append)
- **Exports:** `startPeriodicCheckpointing(taskId, intervalMs): number`, `stopPeriodicCheckpointing(taskId): void`
- **Defaults:** 60s interval, captures current agent state each interval
- **Testable:** 1) startPeriodicCheckpointing creates interval, returns timerId 2) stopPeriodicCheckpointing clears interval 3) Checkpoints saved at interval 4) Default 60s interval accurate 5) No checkpoint after task completes
- **Deliverable:** 2 functions appended, interval verified at 60s, timerId return/stop verified
- **Verification:** Create extensions/caravel-checkpoints.test.ts with timer tests; Run `npx tsx extensions/caravel-checkpoints.test.ts` to verify timer lifecycle

### Task P1T5: Context Recovery Injection on Retry
- **File:** `extensions/caravel.ts` (modify `runPhaseInternal`)
- **Behavior:** On task retry, `loadCheckpoint(taskId)` called. If found, inject: `[AGENT: {identity}] [RECOVERED CONTEXT] {summary}`
- **Testable:** 1) Retried tasks get context prefix when checkpoint exists 2) Non-retry tasks unchanged (no regression) 3) Context format matches spec 4) Identity included in prefix 5) Missing checkpoint gracefully skipped
- **Deliverable:** Modified `runPhaseInternal` with checkpoint injection logic, effective task description includes prefix
- **Verification:** Verify runPhaseInternal compiles, check effective task description has prefix on retry, verify no regression on non-retry tasks

### Task P1T6: Agent Identity on Task Start
- **File:** `extensions/caravel.ts` (modify `runPhaseInternal`)
- **Behavior:** On task start, resolve agent identity via `getAgentIdentity(agentName)`, store in `task.metadata.agentIdentity`
- **Testable:** 1) Identity resolved before task starts 2) Identity stored in task metadata 3) `caravel/<name>/primary` format correct 4) Works with all agent types 5) No regression without identity feature
- **Deliverable:** Modified `runPhaseInternal` with identity resolution, task metadata updated
- **Verification:** Verify runPhaseInternal compiles, check metadata has identity after task start, verify no regression when feature disabled

---

## Phase P2: Health Monitoring & Stuck Detection

### Task P2T1: Health State Store Module
- **File:** `extensions/caravel-health.ts` (NEW)
- **Exports:** `getHealthState(): HealthState`, `updateAgentHealth(identity, status, data?)`, `listAgentHealth(): AgentHealth[]`, `clearHealthState()`
- **Persistence:** `.caravel/health.json` with `{ lastCheck, agents: {identity: {status, lastActivity, nudges, maxNudges}}, alerts }`
- **Testable:** 1) getHealthState returns persisted state 2) updateAgentHealth writes correctly 3) listAgentHealth returns all agents 4) clearHealthState resets state 5) State persists as valid JSON
- **Deliverable:** File `extensions/caravel-health.ts` with 4 exported functions, `.caravel/health.json` on first call
- **Verification:** Create extensions/caravel-health.test.ts with state CRUD tests; Run `npx tsx extensions/caravel-health.test.ts` to verify

### Task P2T2: Stuck Detection Engine
- **File:** `extensions/caravel-health.ts` (append)
- **Exports:** `detectStuckAgents(agents, thresholds?): StuckAgent[]`
- **Defaults:** stuck=120s, zombie=300s
- **Returns:** `{ agent: string, status: "stuck"|"zombie", duration: number }[]`
- **Testable:** 1) Agent with lastCheckpointAge > 120s marked stuck 2) Agent with lastCheckpointAge > 300s marked zombie 3) Healthy agents not flagged 4) Thresholds configurable 5) Returns correct array format
- **Deliverable:** `detectStuckAgents` function with exported signature, returns `StuckAgent[]` typed array
- **Verification:** Create extensions/caravel-health.test.ts with stuck detection tests; Run `npx tsx extensions/caravel-health.test.ts` to verify thresholds

### Task P2T3: Auto-Recovery (Nudge)
- **File:** `extensions/caravel-health.ts` (append)
- **Exports:** `nudgeAgent(agentIdentity, checkpoint): { context: string, nudgeCount: number, escalated: boolean }`
- **Defaults:** maxNudges=2
- **Testable:** 1) Nudge record created and saved to health state 2) Nudge count incremented 3) Escalated=true after maxNudges 4) Context format `[NUDGE: Agent stuck for {d}s]` 5) Health alert record written
- **Deliverable:** `nudgeAgent` function exported, returns nudge result object, creates health alert record
- **Verification:** Create extensions/caravel-health.test.ts with nudge tests; Run `npx tsx extensions/caravel-health.test.ts` to verify escalation

### Task P2T4: Health Dashboard Widget Line
- **File:** `extensions/caravel.ts` (modify widget bar)
- **Exports:** `buildHealthBar(healthState): string`
- **Format:** `[agents: developer✓ tech-lead⚠ designer✓]`
- **Testable:** 1) Widget line shows health icons when enabled 2) Correct icons per status (✓/⚠/✗) 3) No regression when disabled 4) Format matches spec 5) No widget bar layout changes
- **Deliverable:** `buildHealthBar` function exported, added to widget bar lines array, conditional on config flag
- **Verification:** Verify widget bar renders correctly in test, check format matches spec, verify no regression when disabled

### Task P2T5: Health Check Interval
- **File:** `extensions/caravel-health.ts` (append)
- **Exports:** `startHealthChecks(thresholds?): number`, `stopHealthChecks(): void`
- **Defaults:** 30s interval
- **Testable:** 1) startHealthChecks starts interval, returns timerId 2) stopHealthChecks clears interval 3) detectStuckAgents called each interval 4) Auto-recovery triggered for stuck agents 5) Default 30s interval accurate
- **Deliverable:** 2 functions appended, interval at 30s verified, auto-recovery triggered
- **Verification:** Create extensions/caravel-health.test.ts with interval tests; Run `npx tsx extensions/caravel-health.test.ts` to verify timer lifecycle

---

## Phase P3: Inter-Agent Messaging

### Task P3T1: Message Store Module
- **File:** `extensions/caravel-messaging.ts` (NEW)
- **Exports:** `sendMessage(from, to, subject, body, priority?): Message`, `getMessages(agentIdentity, unreadOnly?): Message[]`, `markAsRead(messageId)`, `getMessagesByChannel(channel): Message[]`
- **Persistence:** `.caravel/messages.json` with `{ nextId, channels: {name: Message[]} }`
- **Testable:** 1) sendMessage creates message with auto-increment id 2) getMessages returns agent's messages 3) markAsRead sets read=true 4) getMessagesByChannel filters by channel 5) Messages persist as JSON
- **Deliverable:** File `extensions/caravel-messaging.ts` with 4 exported functions, `.caravel/messages.json` on first call
- **Verification:** Create extensions/caravel-messaging.test.ts with CRUD tests; Run `npx tsx extensions/caravel-messaging.test.ts` to verify

### Task P3T2: Message Channels & Auto-Routing
- **File:** `extensions/caravel-messaging.ts` (append)
- **Exports:** `DEFAULT_CHANNELS = ['general', 'review', 'escalation']`, `getAvailableChannels(): string[]`, `getChannelMessages(channel, limit?): Message[]`
- **Behavior:** Agent-specific channels `<from>→<to>`, auto-created on first message
- **Testable:** 1) DEFAULT_CHANNELS exported 2) getAvailableChannels returns channels 3) getChannelMessages filters by channel 4) Agent channels auto-created 5) Messages routed correctly
- **Deliverable:** `DEFAULT_CHANNELS` const exported, `getChannelMessages` function, channel auto-creation in sendMessage
- **Verification:** Create extensions/caravel-messaging.test.ts with channel tests; Run `npx tsx extensions/caravel-messaging.test.ts` to verify

### Task P3T3: Nudge & Escalation Messages
- **File:** `extensions/caravel-messaging.ts` (append)
- **Exports:** `sendNudge(from, to, message): Message`, `escalate(from, to, subject, body): Message`, `getUnresolvedNudges(): Message[]`, `getOpenEscalations(): Message[]`, `resolveEscalation(escalationId)`
- **Defaults:** nudge priority='high' with 5min expiry, escalation priority='escalation' with auto-routing to ['tech-lead','orchestrator']
- **Testable:** 1) sendNudge creates high-priority message with expiry 2) escalate creates escalation with auto-routing 3) getUnresolvedNudges returns unread nudges only 4) getOpenEscalations returns unresolved 5) resolveEscalation marks resolved
- **Deliverable:** 5 functions appended, nudge expiry at 300000ms, escalation routing array correct
- **Verification:** Create extensions/caravel-messaging.test.ts with nudge/escalation tests; Run `npx tsx extensions/caravel-messaging.test.ts` to verify

### Task P3T4: Widget Integration for Messages
- **File:** `extensions/caravel.ts` (modify widget bar)
- **Behavior:** Show `[3 unread]` and `[1 escalation]` in widget bar when messaging enabled
- **Testable:** 1) Widget shows unread count when enabled 2) Widget shows escalation count 3) Conditional on messaging feature flag 4) No regression when disabled 5) No layout changes to widget bar
- **Deliverable:** Widget bar modified with message indicators, conditional on config.messaging.enabled
- **Verification:** Verify widget bar renders correctly in test, check format matches spec, verify no regression when disabled

---

## Phase P4: Predecessor Context Recovery

### Task P4T1: Seance Record Store Module
- **File:** `extensions/caravel-seance.ts` (NEW)
- **Exports:** `recordTerminatedAgent(agentIdentity, taskId, phase, reason, checkpoint?)`, `getSeanceHistory(agentIdentity): SeanceRecord[]`, `getSeance(taskId): SeanceRecord | null`, `clearSeance(taskId)`
- **Persistence:** `.caravel/seances.json` with `{ records: SeanceRecord[] }`
- **SeanceRecord:** `{ id, agentIdentity, taskId, phase, terminatedAt, reason, lastCheckpoint, workSummary, filesModified, toolCallHistory, contextWindow }`
- **Testable:** 1) recordTerminatedAgent saves record with all fields 2) getSeanceHistory returns agent records 3) getSeance returns specific task's record 4) clearSeance removes record 5) Records persist as JSON
- **Deliverable:** File `extensions/caravel-seance.ts` with 4 exported functions, `.caravel/seances.json` on first call
- **Verification:** Create extensions/caravel-seance.test.ts with seance CRUD tests; Run `npx tsx extensions/caravel-seance.test.ts` to verify

### Task P4T2: Seance Recovery Query
- **File:** `extensions/caravel-seance.ts` (append)
- **Exports:** `generateRecoveryContext(seance): string`
- **Constraints:** Output ≤500 chars, deterministic
- **Testable:** 1) Output ≤500 chars 2) Includes workSummary 3) Includes filesModified 4) Includes toolCallHistory 5) Deterministic (same input produces identical output twice)
- **Deliverable:** `generateRecoveryContext` function exported, returns string ≤500 chars
- **Verification:** Create extensions/caravel-seance.test.ts with recovery context tests; Run `npx tsx extensions/caravel-seance.test.ts` to verify output length and determinism

### Task P4T3: Seance Auto-Recording on Task End
- **File:** `extensions/caravel.ts` (modify `runPhaseInternal`)
- **Behavior:** On task complete: `recordTerminatedAgent(agentIdentity, taskId, phase, "task_complete")`. On task failed: `recordTerminatedAgent(agentIdentity, taskId, phase, "task_failed")`. Captures lastCheckpoint, workSummary, filesModified. Only when history enabled.
- **Testable:** 1) recordTerminatedAgent called on task complete 2) recordTerminatedAgent called on task fail 3) Captures workSummary 4) Captures filesModified 5) No record when seance disabled
- **Deliverable:** `runPhaseInternal` modified with seance recording, `.caravel/seances.json` written on task end
- **Verification:** Verify runPhaseInternal compiles, check seances.json written on task end, verify no record when disabled

### Task P4T4: Seance Injection on Retry
- **File:** `extensions/caravel.ts` (modify task retry logic)
- **Behavior:** On task retry: `getSeance(taskId)` called first. If found, prepend: `[SEANCE RECOVERY] {recoveryContext}\n\n[RETRYING TASK]: {description}`. Max 2 seance entries per retry (oldest first).
- **Testable:** 1) Retry gets seance prefix when found 2) Format matches spec 3) Max 2 entries injected 4) No seance when none found 5) No regression on normal tasks
- **Deliverable:** `runPhaseInternal` modified with seance injection, effective task description includes seance prefix
- **Verification:** Verify runPhaseInternal compiles, check effective task description has seance prefix on retry, verify max 2 entries

---

## Phase P5: Integration & Config

### Task P5T1: Feature Toggle Configuration
- **File:** `extensions/caravel-config.ts` (NEW)
- **Exports:** `DEFAULT_CONFIG`, `getConfig()`, `updateConfig(partial)`, `initializeConfig()`
- **Defaults:** All features **disabled** (opt-in). Config schema: `{ identity?: boolean, health?: boolean, messaging?: boolean, seance?: boolean, thresholds?: {...}, defaults?: {...} }`
- **Testable:** 1) DEFAULT_CONFIG has all features disabled 2) getConfig returns correct defaults 3) updateConfig merges correctly 4) Config persists to `.caravel/config.json` 5) initializeConfig creates files idempotently
- **Deliverable:** File `extensions/caravel-config.ts` with 4 exported functions, config.json persisted
- **Verification:** Create extensions/caravel-config.test.ts with config tests; Run `npx tsx extensions/caravel-config.test.ts` to verify

### Task P5T2: Config Initialization
- **File:** `extensions/caravel-config.ts` (append)
- **Behavior:** `initializeConfig()` creates `.caravel/` with empty config and all feature files. Returns `{ created: boolean, files: string[] }`.
- **Testable:** 1) Creates `.caravel/config.json` 2) Creates empty state files 3) Idempotent (safe to call multiple times) 4) Returns created files list 5) No files created if `.caravel/` doesn't exist
- **Deliverable:** `initializeConfig` function appended, returns `{created: true, files: ['.caravel/config.json']}` on first call
- **Verification:** Create extensions/caravel-config.test.ts with init tests; Run `npx tsx extensions/caravel-config.test.ts` to verify idempotency

### Task P5T3: Integration Hooks in runPhaseInternal
- **File:** `extensions/caravel.ts` (modify `runPhaseInternal`)
- **Integration Points:**
  1. On `runPhaseInternal` start: load config, init features if needed
  2. On task start: resolve identity, start periodic checkpointing
  3. On task progress: health check interval
  4. On task complete: record seance, save checkpoint
  5. On task retry: inject seance context
  6. On phase end: stop health checks, stop periodic checkpointing
- **All hooks gated by feature config.**
- **Testable:** 1) Config loaded at phase start 2) Identity resolved at task start 3) Checkpoints saved at intervals 4) Seance recorded on task end 5) All features gated by config 6) No regression when all features disabled
- **Deliverable:** 6 integration points added to `runPhaseInternal`, all gated by feature flags, function compiles and runs
- **Verification:** Verify runPhaseInternal compiles, check all 6 hooks wired, verify gating, verify no regression when all disabled

### Task P5T4: Health in ZFS Status Bar
- **File:** `extensions/caravel.ts` (modify status bar)
- **Behavior:** Show per-agent health icons in `renderStatusBar` and `renderCompactStatusBar`. Format: `[developer✓ tech-lead⚠ designer✓]`. Conditional on `config.health.enabled`.
- **Testable:** 1) ZFS status bar shows health icons 2) Format consistent with widget bar 3) Conditional on feature flag 4) No regression when disabled 5) No layout changes to existing widgets
- **Deliverable:** Both `renderStatusBar` and `renderCompactStatusBar` modified with health integration
- **Verification:** Verify both status bar functions compile, check health icons render, verify no regression when disabled

### Task P5T5: Documentation & .gitignore
- **Files:** `README.md`, `.gitignore`
- **Content:** README.md updated with 4 feature sections (config examples, activation, troubleshooting). `.gitignore` updated with `.caravel/agents.json`, `.caravel/health.json`, `.caravel/messages.json`, `.caravel/seances.json` entries.
- **Testable:** 1) README has 4 feature sections with config examples 2) Activation instructions clear 3) Troubleshooting section present 4) .gitignore has all 4 new entries
- **Deliverable:** README.md updated, .gitignore updated
- **Verification:** Read README.md to verify 4 sections present, read .gitignore to verify entries

---

## Task Dependency Graph

```
P1T1 (identity registry) ──→ P1T2 (work history)
P1T3 (checkpoint system) ──→ P1T4 (periodic checkpoint)
P1T5 (context injection) ←── P1T1 + P1T3
P1T6 (identity on start) ←── P1T1

P2T1 (health store) ──→ P2T2 (stuck detection)
P2T2 ──→ P2T3 (nudge)
P2T3 ──→ P2T5 (health check interval)
P2T4 (widget bar) ←── P2T1

P3T1 (message store) ──→ P3T2 (channels)
P3T2 ──→ P3T3 (nudge/escalation)
P3T4 (widget bar) ←── P3T3

P4T1 (seance store) ──→ P4T2 (recovery query)
P4T3 (auto-recording) ←── P4T1
P4T4 (injection) ←── P4T1 + P4T2

P5T1 (config) ──→ P5T2 (initialization)
P5T3 (integration hooks) ←── P1 + P2 + P3 + P4
P5T4 (ZFS health) ←── P2T1
P5T5 (docs) ←── P5T3
```

## Execution Strategy
- **Run Phase 1** (P1T1-P1T6): Agent identity + checkpoints — core foundation
- **Run Phase 2** (P2T1-P2T5): Health monitoring — independent of messaging
- **Run Phase 3** (P3T1-P3T4): Messaging — independent of health
- **Run Phase 4** (P4T1-P4T4): Seance — depends on identity for context
- **Run Phase 5** (P5T1-P5T5): Config + integration — ties everything together

Each phase has a developer (implementation) and tech-lead (code review) task. Total: 24 tasks across 5 phases.
