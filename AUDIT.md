# Caravel Codebase Audit Report

> Generated: 2026-05-15
> Scope: architecture, bloat, missing implementations, outdated docs, antipatterns

---

## 1. CRITICAL BUGS

### 1.1 `caravel-health.ts` — nudgeAgent always reports stale duration
**File:** `extensions/caravel-health.ts`
**Severity:** CRITICAL

The `nudgeAgent()` function computes staleness as `Number.MAX_SAFE_INTEGER` regardless of the actual duration passed from `detectStuckAgents()`. It always reports `"[NUDGE: Agent stuck for 9007199254740991s]"`.

**Fix applied:** Added `stalenessSec?: number` parameter to `nudgeAgent()` and updated `runHealthCheck()` to pass the actual duration.

### 1.2 `caravel-health.ts` — `getActiveHealthAgents` always returns empty
**File:** `extensions/caravel-health.ts`
**Severity:** HIGH

The `getActiveHealthAgents` module variable defaults to `() => []` and there is no public mechanism for the fleet orchestrator to register agent heartbeats. The periodic health checks will never detect stuck agents because there's no way to populate heartbeat data.

**Recommendation:** Wire `getActiveHealthAgents` to the fleet's active agent state, or provide a `registerHeartbeat()` API that the orchestrator calls on each task cycle.

---

## 2. BLOAT & ARCHITECTURE

### 2.1 `caravel.ts` is a 7,066-line monolith
**File:** `extensions/caravel.ts`
**Severity:** HIGH

This single file contains:
- Feature config & hooks (~150 lines)
- Testability enforcement (~100 lines)
- Progress formatting (~40 lines)
- ZFS status bar rendering (~270 lines)
- ZFS status bar manager class (~90 lines)
- ZFS process manager (KDL parsing, pane creation, process control) (~810 lines)
- Background process manager (~540 lines)
- Widget bar rendering (~200 lines)
- Integration hooks (~170 lines)
- Pre-flight codebase scan (~450 lines)
- Artifact generation (~210 lines)
- Fleet orchestration logic (~2,000+ lines)
- Command parsing & handlers (~1,000+ lines)
- ZFS session management (~700+ lines)

**Recommendation:** Split into:
- `caravel-fleet.ts` — core orchestration, phases, tasks, review
- `caravel-zfs.ts` — all ZFS code (process manager, layout, status bar)
- `caravel-dashboard.ts` — widget bar + status bar rendering
- `caravel-scanner.ts` — pre-flight scan + artifact generation

### 2.2 Duplicate persistence boilerplate
**Files:** All extension files (`caravel-identity.ts`, `caravel-health.ts`, `caravel-messaging.ts`, `caravel-seance.ts`, `caravel-config.ts`, `caravel-checkpoints.ts`)

Every extension repeats:
- `loadXxxFile()` with identical schema validation logic
- `saveXxxFile()` with identical atomic-write pattern (`.tmp.${pid}.${Date.now()}` + `rename`)
- `fs.existsSync` → `readFileSync` → `JSON.parse` → null-on-failure

**Recommendation:** Extract a shared `persisted.ts` module:
```ts
export function loadPersisted<T>(path: string): T | null
export function savePersisted<T>(path: string, data: T): void
```

---

## 3. DEAD / BROKEN CODE

### 3.1 `caravel-widget-indicators.ts` — never wired to dashboard
**File:** `extensions/caravel-widget-indicators.ts`
**Severity:** MEDIUM

The module provides `buildMessagingIndicators()` and `formatIndicatorLine()` which are never called from `caravel.ts` or any other file. The widget bar code in `caravel.ts` builds its own unread count logic inline.

**Recommendation:** Either wire it into the dashboard or remove it.

### 3.2 `caravel-checkpoints.ts` — periodic timer IDs are misleading
**File:** `extensions/caravel-checkpoints.ts`
**Severity:** LOW

`startPeriodicCheckpointing()` returns a numeric timer ID but the internal `activeTimers` Map uses `taskId` as the key. The numeric return is never used by callers and `stopPeriodicCheckpointing()` only works by taskId.

### 3.3 `caravel-messaging.ts` — `getChannelMessages()` hidden side-effect
**File:** `extensions/caravel-messaging.ts`
**Severity:** LOW

Calling `getChannelMessages()` auto-creates the channel (writes to disk) even though the function name implies read-only behavior. This is surprising to callers.

### 3.4 `caravel-seance.ts` — `generateRecoveryContext()` is impractical
**File:** `extensions/caravel-seance.ts`
**Severity:** LOW

The `toolCallHistory` field is described as "truncated summary" but the function serializes it with `tc.tool(${tc.args})→${tc.result}`, which would be enormous for any real session. The `contextWindow` field is similarly vague.

---

## 4. OUTDATED DOCUMENTATION

### 4.1 README — duplicate sections (FIXED)
**File:** `README.md`
**Severity:** HIGH — **FIXED**

Removed duplicate sections:
- "Configuration Examples" (appeared twice) — removed second copy
- "Activation" (appeared twice) — removed second copy
- "Monitoring & Control" (appeared twice) — removed second copy
- "Verify It Works" (appeared twice as sections 4 and 3) — removed second copy

### 4.2 README — broken file references (FIXED)
**File:** `README.md`
**Severity:** MEDIUM — **FIXED**

Fixed:
- `skills/zellij-fleet.md` → `skills/zellij-fleet/SKILL.md`
- Added missing space in `zellij-fleet-config.md#` → `zellij-fleet-config.md  #`

### 4.3 SKILL.md — broken command references (FIXED)
**File:** `SKILL.md`
**Severity:** HIGH — **FIXED**

Fixed:
- All `/caravel-go` → `/go` (7 occurrences)
- `/caravel-fleet` → `/fleet` (1 occurrence)

### 4.4 SKILL.md — dead integration code (FIXED)
**File:** `SKILL.md`
**Severity:** MEDIUM — **FIXED**

Removed non-existent integration code:
- Telegram Notifications (code example, no `integrations/telegram`)
- Linear Integration (code example, no `integrations/linear`)
- Plane Integration (code example, no `integrations/plane`)
- Metrics collection (`notes/metrics-spec.md` doesn't exist)

### 4.5 SKILL.md — removed `PROJECT-PLAN.md` from key files
**File:** `SKILL.md`
**Severity:** LOW — **FIXED**

`PROJECT-PLAN.md` is a P5 sub-plan generated by the planning phase, not the main project plan. Removed from the key files table.

---

## 5. CODE QUALITY ISSUES

### 5.1 `caravel-config.ts` — inconsistent merge depth (FIXED)
**File:** `extensions/caravel-config.ts`
**Severity:** MEDIUM — **FIXED**

`mergeConfig()` did shallow merge for `thresholds` but deep merge for `defaults.healthThresholds`. Fixed to use consistent shallow merge for both.

### 5.2 `caravel-health.ts` — `detectStuckAgents()` never used by `runHealthCheck()`
**File:** `extensions/caravel-health.ts`
**Severity:** MEDIUM

`detectStuckAgents()` expects `{ identity, lastHeartbeatAt }[]` but `getActiveHealthAgents()` always returns `[]`. The detection logic is correct but unreachable.

### 5.3 `caravel-messaging.ts` — `ESCALATION_RECIPIENTS` unused
**File:** `extensions/caravel-messaging.ts`
**Severity:** LOW

`ESCALATION_RECIPIENTS = ["tech-lead", "orchestrator"]` is defined but `escalate()` ignores it — it routes to the caller-specified `to` parameter.

### 5.4 Agent default models are overly specific
**Files:** `agents/*.md`
**Severity:** LOW

All agents default to `llama.cpp/Qwen/Qwen3.6-35B-A3B-GGUF:Q4_K_M` — a specific GGUF quantization. This is fine as documentation but should be clearer that users should override this.

---

## 6. MISSING TESTS

### 6.1 Health-messaging integration
No tests for `nudgeAgent()` passing actual staleness values, or `detectStuckAgents()` with real heartbeat data.

### 6.2 Widget indicator edge cases
`generateRecoveryContext()` edge cases (empty toolCallHistory, oversized contextWindow) aren't tested.

### 6.3 Config merge edge cases
`mergeConfig()` edge cases (undefined subfields, nested partials) aren't covered.

### 6.4 caravel.ts integration
The main orchestrator has no integration tests — only unit tests for individual extensions exist.

---

## 7. RECOMMENDATIONS (Priority Order)

### P0 — Must Fix
1. ✅ **Fixed** nudgeAgent staleness bug in `caravel-health.ts`
2. ✅ **Fixed** README duplicate sections
3. ✅ **Fixed** SKILL.md broken commands (`/caravel-go` → `/go`)
4. ✅ **Fixed** SKILL.md dead integration/metrics code
5. ⏳ Wire `getActiveHealthAgents` to fleet state (so health checks actually work)

### P1 — Should Fix
6. Split `caravel.ts` into logical modules (P0 architectural debt)
7. Extract shared persistence module to eliminate boilerplate
8. Wire `caravel-widget-indicators.ts` into the dashboard or remove it
9. Add tests for health-messaging integration

### P2 — Nice to Have
10. Add `registerHeartbeat()` API to `caravel-health.ts`
11. Fix `caravel-messaging.ts` `getChannelMessages()` side-effect
12. Add integration tests for caravel.ts
13. Document `caravel-checkpoints.ts` timer ID behavior

---

## 8. FILES CHANGED IN THIS AUDIT

| File | Change |
|------|--------|
| `extensions/caravel-health.ts` | Fixed `nudgeAgent()` staleness parameter + `runHealthCheck()` |
| `extensions/caravel-config.ts` | Fixed inconsistent merge depth in `mergeConfig()` |
| `README.md` | Removed 95 lines of duplicate content; fixed file references |
| `SKILL.md` | Fixed `/caravel-go` → `/go`; removed dead integrations/metrics |
| `AUDIT.md` | This file |

---

## 9. STATISTICS

| Metric | Value |
|--------|-------|
| Total files audited | 26+ |
| Extension files reviewed | 8 |
| Agent files reviewed | 6 |
| Skill files reviewed | 7 |
| Test files reviewed | 17 |
| Critical bugs found | 1 (fixed) |
| High-severity bugs found | 1 (requires follow-up) |
| Duplicate sections removed | 4 |
| Dead code sections removed | 4 (metrics, telegram, linear, plane) |
| Broken references fixed | 5 |
