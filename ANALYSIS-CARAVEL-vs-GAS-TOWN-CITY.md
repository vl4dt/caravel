# Caravel vs Gas Town / Gas City — Deep Analysis & Improvement Roadmap

> **Date:** 2026-05-14  
> **Sources:** Caravel README.md, SKILL.md, PROJECT-DESIGN.md, caravel.ts (6,337 lines); Gas Town README.md, AGENTS.md, architecture.md, packv2/; Gas City article (full Medium text); DeepWiki deep-dive; Steve Yegge Medium articles  
> **Scope:** Architectural comparison, what's good in Gas Town/City, what's bad, and how Caravel should evolve

---

## 1. Executive Summary

Caravel and Gas Town/City solve the same fundamental problem — **orchestrating multiple AI coding agents** — but with very different philosophies, scopes, and target audiences.

| Dimension | Caravel | Gas Town | Gas City |
|-----------|---------|----------|----------|
| **Target** | Pi coding agent fleet (single user, single project) | Multi-agent workspace (20-30 agents across projects) | SDK for building custom multi-agent factories |
| **Scope** | Single-project fleet within Pi | Multi-project Town with Rigs, federated Wasteland | Pack-based composable orchestration SDK |
| **Agent Model** | Supervisor-worker with pipeline review | Role-based hierarchy (Mayor/Polecats/Witness/Refinery) | Generic agent packs, declarative config |
| **Persistence** | `pi.appendEntry` (Pi-native) | Dolt SQL + git-backed Beads ledger | Dolt SQL + Beads via Packs |
| **Coordination** | Centralized orchestrator dispatches | Mail Router + Beads + Convoys | Orders, Formulas, Mail, Wisp layers |
| **Observability** | Widget bar (Pi Mode) / Status bar (ZFS) | `gt feed` TUI + web dashboard + OTEL | Console + tmux + dashboard |
| **Review** | Two-stage (code + design) mandatory gate | Refinery merge queue (bisecting) | Configurable packs |
| **Deployment** | Symlink into Pi config | tmux sessions + Go daemon | tmux/subprocess/Kubernetes providers |
| **Complexity** | Low — install via symlinks | High — Go, Dolt, tmux, Docker, multiple CLIs | Medium — Go SDK, pack management |

**Key finding:** Caravel is a **simpler, Pi-integrated fleet** that excels at single-project development with quality gates. Gas Town/City is an **enterprise-grade orchestration platform** that excels at multi-project coordination, persistence, and auditability. Caravel can learn from Gas Town/City's persistence model, health monitoring, and composability while avoiding Gas Town's complexity bloat and Gas City's over-engineering.

---

## 2. Architecture Comparison

### 2.1 Agent Models

#### Caravel: Supervisor-Worker with Pipeline Review
```
         +--- [Tech Lead] --- plan ---+
         |                             |
Main Agent --> supervisor routing     |
         |                             v
         +--- [Developer] --- execute ---+
                                      |
                         +--- [Designer] -- review (vision) ---+
```

**Strengths:**
- Simple, familiar pattern (known from Azure Architecture Center, LangGraph)
- Two-stage review is a **critical quality gate** — Caravel's best feature
- Easy to understand, low cognitive load
- Testability enforcement (T7) is excellent

**Weaknesses:**
- Centralized orchestrator = single point of failure
- No persistent agent identity across restarts
- No inter-agent messaging (all mediated through orchestrator)
- No health monitoring for running agents
- No merge queue or CI-gating

#### Gas Town: Role-Based Factory
```
Town (~/gt/)
├── Mayor (global coordinator)
├── Deacon (daemon watchdog)
├── Rigs (project containers)
│   ├── Witness (per-rig health monitor)
│   ├── Refinery (merge queue processor)
│   ├── Polecats (ephemeral workers)
│   └── Crew (human workspaces)
└── Dolt SQL (shared state)
```

**Strengths:**
- **Persistent agent identities** — agents survive restarts
- **Health monitoring** — Witness detects stuck/zombie agents
- **Merge queue** — Refinery's bisecting merge queue is brilliant
- **Inter-agent messaging** — Mail Router enables agent-to-agent communication
- **Multi-project** — Rigs enable multi-project coordination
- **Audit trail** — Dolt provides git-versioned history of every action
- **Scalability** — designed for 20-30 concurrent agents
- **Seance** — predecessor session discovery for context recovery

**Weaknesses:**
- **Massive complexity** — Go, Dolt, tmux, Docker, multiple CLIs (gt, bd, bv)
- **High dependency surface** — Go 1.25+, Git 2.25+, Dolt 1.82.4+, beads 0.55.4+, sqlite3, tmux 3.0+, Claude/Codex/GitHub Copilot CLIs
- **Over-engineered for single-project use** — most users only need Mayor + a few Polecats
- **Mad Max theme** — Mayor, Polecats, Refinery, Witness, Deacon, Dogs — unnecessarily opaque naming
- **"Industrialized coding factory manned by superintelligent robot chimps"** — Yegge's own warning about chaos
- **Expensive** — 20-30 concurrent LLM calls burns through budgets fast
- **Only suitable for developers already comfortable juggling multiple AI coding agents** (Yegge's own caveat)

#### Gas City: Composable Pack SDK
```
city.toml (deployment)
├── pack.toml (definition)
├── agents/ (agent configs)
├── formulas/ (workflow templates)
├── orders/ (exec/formula orders)
└── .gc/ (site binding)
```

**Strengths:**
- **Packs** — composable, declarative building blocks (biggest innovation)
- **Provider agnostic** — tmux, subprocess, exec, ACP, Kubernetes
- **Fine-grained model selection** — cost control at different levels
- **Light Factory philosophy** — maximize observability (all agents visible)
- **Enterprise focus** — audit trails, version history, SOC2-ready
- **De-SaaS narrative** — compelling case for building in-house
- **No baked-in roles** — roles come from config, not SDK law

**Weaknesses:**
- **Still Go-based** — high barrier to entry
- **Dolt dependency** — adds another external system
- **Pack ecosystem immature** — limited packs available
- **Overwhelming for newcomers** — too many concepts (packs, orders, formulas, waits, wisp, rigs, city)
- **"You should almost never deploy a single-agent pack"** — Yegge warns against it, meaning even "simple" use cases need complex multi-agent setups

---

## 3. What Gas Town/City Does Well (Caravel Should Adopt)

### 3.1 ✅ Persistent Agent Identity (HIGH PRIORITY)

**Gas Town:** Each agent has a permanent identity (`rig/polecats/alpha`) while sessions are ephemeral. Work persists across agent restarts via Beads.

**Caravel:** State persists via `pi.appendEntry` but agents don't have persistent identities. If an agent crashes mid-task, context is lost.

**Recommendation:** Add **agent identity** and **session recovery**:
```yaml
# agents/developer.md
identity: caravel/developer/primary  # persistent identity
session:
  recovery: true  # restore context on crash
  checkpoint_interval: 60  # seconds
```

This would allow agents to recover their exact position after crashes, not just resume from the last saved task.

### 3.2 ✅ Health Monitoring / Watchdog (HIGH PRIORITY)

**Gas Town:** Three-tier watchdog (Witness → Deacon → Boot). Detects stuck/zombie agents, triggers recovery, manages session cleanup.

**Caravel:** No health monitoring. If an agent hangs or crashes silently, the orchestrator has no way to detect it.

**Recommendation:** Add a **health monitor** phase:
```javascript
// During execution, periodically check:
health_monitor: {
  check_interval: 30,        // seconds
  stuck_threshold: 120,      // seconds without progress
  zombie_threshold: 300,     // seconds without heartbeat
  auto_recovery: true,       // nudge or restart stuck agents
  escalate_after: 600,       // seconds before escalating to user
}
```

### 3.3 ✅ Inter-Agent Messaging (MEDIUM PRIORITY)

**Gas Town:** `gt nudge` (immediate) and `gt mail` (persistent) enable agent-to-agent communication without going through the Mayor.

**Caravel:** All communication is mediated through the orchestrator. No direct agent-to-agent communication.

**Recommendation:** Add a **message bus** for agents:
```javascript
// During phase execution, agents can communicate:
message_bus: {
  channels: ["general", "review", "escalation"],
  persistent: true,  // messages survive restarts
}
```

This enables agents to coordinate autonomously during a phase (e.g., developer telling tech-lead "PR ready for review").

### 3.4 ✅ Predecessor Context Recovery (MEDIUM PRIORITY)

**Gas Town:** `gt seance` discovers previous agent sessions and enables querying them for context.

**Caravel:** No mechanism to recover context from crashed/terminated agents mid-phase.

**Recommendation:** Add **session checkpointing**:
```javascript
// Before each task, check for predecessor context:
context_recovery: {
  mode: "seance",  // or "none", "full"
  max_sessions: 3,  // how far back to look
}
```

### 3.5 ✅ Audit Trail (LOW-MEDIUM PRIORITY)

**Gas Town:** Every agent action recorded in Dolt (git-versioned SQL). Unmatched forensics/audit.

**Caravel:** Metrics collected but not versioned or queryable. No audit trail.

**Recommendation:** Add an **optional audit trail** (lightweight, no Dolt dependency):
```javascript
audit_trail: {
  enabled: true,
  storage: "git",  // or "jsonl", "sqlite"
  granularity: "task",  // or "tool_call", "agent_message"
}
```

### 3.6 ✅ Merge Queue Pattern (LOW PRIORITY for Caravel)

**Gas Town:** Refinery's bisecting merge queue is brilliant for CI-gating. But Caravel already has two-stage review as the quality gate.

**Caravel:** Review is per-task, not per-branch/PR. No merge queue concept.

**Recommendation:** Caravel already has the right mechanism (two-stage review). The merge queue is useful for Gas Town's multi-agent parallel development but less relevant for Caravel's per-task review model. **Skip this.**

---

## 4. What Gas Town/City Does Poorly (Caravel Should Avoid)

### 4.1 ❌ Complexity Bloat (CRITICAL to avoid)

**Gas Town's dependency surface:**
- Go 1.25+
- Git 2.25+
- Dolt 1.82.4+ (git-backed SQL database)
- beads 0.55.4+ (separate CLI tool)
- sqlite3
- tmux 3.0+
- Claude Code / Codex / Copilot CLI
- Docker Compose (optional)
- OpenTelemetry (optional)

**Caravel's dependency surface:**
- Node.js (via Pi)
- Git (optional, for hooks)
- Zellij (optional, for ZFS mode)

**Lesson:** Caravel's simplicity is its **competitive advantage**. Gas Town's complexity is its fatal flaw — "only suitable for developers already comfortable juggling multiple AI coding agents." Most users can't or won't install Go + Dolt + tmux + Docker + multiple CLIs just to coordinate a few agents.

**Recommendation:** Keep Caravel's **zero-friction installation** philosophy. Every new feature should ask: "Can this be optional?" and "Does this require new dependencies?" If the answer to either is "yes," make it opt-in.

### 4.2 ❌ Mad Max Theme / Opaque Naming (AVOID)

**Gas Town:** Mayor, Polecats, Refinery, Witness, Deacon, Dogs, Crew, Rig, Convoy, Bead, Formula, Molecule, Hook, Seance, Wasteland...

**Problem:** Every concept needs a Mad Max-themed name. New users spend enormous cognitive effort learning the theme before understanding the system.

**Caravel's naming:** developer, tech-lead, designer, planner, auditor — **clear, descriptive, professional**.

**Recommendation:** Keep Caravel's **clear naming**. If Gas Town's concepts are useful (health monitor, merge queue, message bus), give them clear names, not thematic ones.

### 4.3 ❌ Gas City's Over-Engineering (AVOID)

**Gas City's key innovation (packs)** is genuinely useful, but the **execution is over-engineered**:
- TOML configs for everything (`city.toml`, `pack.toml`, `agents/<name>/agent.toml`)
- Import model with aliasing, versioning, transitive resolution
- Lock files for pack resolution
- Rig-level imports, city-level imports, patches, overlays, skills, MCP servers
- Multiple provider backends (tmux, subprocess, exec, ACP, Kubernetes)
- Wisp layers for transient local overrides
- Multiple state layers (pack.toml, city.toml, .gc/, .beads/)

**Lesson:** The **Pack concept** is good (composable, declarative), but the **implementation complexity** is bad. Caravel should adopt the *philosophy* of packs (composable, shareable agent configurations) without the **TOML-by-committee** approach.

**Recommendation:** Adopt **composable agent configs** via YAML/JSON with simple import syntax:
```yaml
# agents/developer.md
base: "caravel/base/developer"
overrides:
  model: "ollama/qwen3:8b"
  tools: ["read", "write", "edit", "bash"]
```

### 4.4 ❌ "Industrialized Coding Factory" Chaos (AVOID)

**Yegge's own admission:** "Gas Town is an industrialized coding factory manned by superintelligent robot chimps, and when they feel like it, they can wreck your shit in an instant."

**Problem:** At scale (20-30 agents), agents can:
- Conflict on the same files
- Hallucinate and make bad calls
- Go temporarily insane without human oversight
- Overwhelm API rate limits

**Caravel's approach:** 3-5 agents with mandatory review gates is a **sweet spot** — enough parallelism without chaos.

**Recommendation:** Caravel should **enforce guardrails**:
- File-level locking to prevent agent conflicts
- Rate limit awareness (warn before agents exhaust budgets)
- Mandatory review gates (already have this — keep it)
- Default max agents per phase (3-5, not 20-30)

### 4.5 ❌ Expensive at Scale (AVOID)

**Gas Town:** 20-30 concurrent Claude Code instances = enormous token costs. Yegge warns it's "expensive."

**Caravel:** Sequential phase execution with 3-5 agents = much more cost-effective.

**Recommendation:** **Keep Caravel's cost-conscious design**. Don't add features that encourage running too many agents simultaneously. Add **cost estimation** to the widget bar instead.

---

## 5. Improvement Roadmap for Caravel

### Phase 1: Persistence & Recovery (Weeks 1-2)

| # | Feature | Priority | Description | Gas Town/City Inspiration |
|---|---------|----------|-------------|--------------------------|
| 1 | Agent identity | Critical | Each agent gets a persistent identity string | `rig/polecats/alpha` |
| 2 | Session recovery | Critical | On crash, restore agent to last checkpoint | `gt prime` + Beads persistence |
| 3 | Task checkpointing | Critical | Save task state every N seconds | Hook system |
| 4 | Predecessor context | Medium | Query terminated agent's last work | `gt seance` |

**Why critical:** This is Caravel's biggest gap vs. Gas Town. If agents can recover from crashes, Caravel becomes viable for longer-running projects.

### Phase 2: Health Monitoring (Weeks 3-4)

| # | Feature | Priority | Description | Gas Town/City Inspiration |
|---|---------|----------|-------------|--------------------------|
| 5 | Stuck detection | High | Detect agents without progress for N seconds | Witness health patrol |
| 6 | Auto-recovery | High | Nudge or restart stuck agents automatically | Witness nudging |
| 7 | Progress heartbeat | Medium | Agents send periodic progress signals | Data plane lifecycle |
| 8 | Health dashboard | Low | Widget bar expansion showing agent health | `gt feed --problems` |

### Phase 3: Inter-Agent Communication (Weeks 5-6)

| # | Feature | Priority | Description | Gas Town/City Inspiration |
|---|---------|----------|-------------|--------------------------|
| 9 | Message bus | High | Persistent, channel-based messaging between agents | `gt mail` |
| 10 | Escalation channel | High | Agents can escalate blockers to orchestrator | Escalation system |
| 11 | File-level locking | Medium | Prevent agent file conflicts | Git worktree model |
| 12 | Cost estimation | Medium | Predict token cost before starting phases | Gas City model selection |

### Phase 4: Composable Config (Weeks 7-8)

| # | Feature | Priority | Description | Gas City Inspiration |
|---|---------|----------|-------------|---------------------|
| 13 | Agent packs | Medium | Shareable, composable agent configurations | Pack system |
| 14 | Review gate configs | Medium | Configurable review rules per task type | Formula system |
| 15 | Cost guardrails | Low | Budget limits, per-agent cost caps | Gas City fine-grained model selection |
| 16 | Audit trail | Low | Optional git-versioned action log | Dolt-backed Beads |

---

## 6. Detailed Architecture Comparison

### 6.1 Persistence Model

| Aspect | Caravel | Gas Town | Gas City | Caravel Should Do |
|--------|---------|----------|----------|-------------------|
| **State format** | `pi.appendEntry` (Pi-native) | Dolt SQL + JSON | Dolt SQL + JSON | Add **JSONL checkpoint files** alongside Pi state |
| **Persistence level** | Fleet-wide | Per-agent, per-rig, per-town | Per-agent, per-pack | **Per-task checkpoints** at agent level |
| **Recovery** | Resume from last fleet state | `gt prime` restores full context | Session config recovery | **Both** — fleet resume + agent recovery |
| **Crash survival** | Partial (fleet state only) | Full (Beads survive) | Full (Dolt survives) | Add per-task file-based checkpoints |

### 6.2 Agent Model

| Aspect | Caravel | Gas Town | Gas City |
|--------|---------|----------|----------|
| **Identity** | None (session-scoped) | Permanent (`rig/polecats/alpha`) | Configured per pack |
| **Lifecycle** | Spawn → work → terminate | Spawn → work → idle → respawn | Persistent/scalable sessions |
| **Health** | None | Witness patrol | Controller health patrol |
| **Messaging** | None (orchestrator-mediated) | Mail Router + nudge | Orders + mail |
| **Scope** | Single project | Multi-project (Rigs) | Multi-project (packs) |

### 6.3 Review & Quality

| Aspect | Caravel | Gas Town | Gas City |
|--------|---------|----------|----------|
| **Review model** | Two-stage mandatory | Refinery bisecting merge queue | Configurable per pack |
| **Code review** | Tech Lead | Refinery + CI gates | Configurable |
| **Design review** | Designer (vision) | N/A | N/A |
| **Quality gates** | Logic error detection, gate checks | Bors-style bisect | Per-pack policies |
| **Review loop** | Auto-fix, max iterations | Bisecting isolation | Per-pack policies |

**Caravel's review system is actually superior to Gas Town's for most use cases.** Two-stage review (code + design) is more thorough than Gas Town's Refinery (which only handles merge queue, not code quality). Caravel should **keep this as-is** and not try to adopt Gas Town's Refinery.

### 6.4 Observability

| Aspect | Caravel | Gas Town | Gas City |
|--------|---------|----------|----------|
| **Widget bar** | ✅ Fixed 6-line (Pi Mode) | ❌ No | ❌ No |
| **Status bar** | ✅ 10-line floating (ZFS) | `gt feed` TUI | Console |
| **Web dashboard** | ❌ No | ✅ `gt dashboard` | ✅ Dashboard |
| **Telemetry** | Metrics collection | OpenTelemetry | OTEL + audit trail |
| **Problem detection** | ❌ No | ✅ `--problems` view | Health patrol |
| **Per-agent detail** | ✅ Model, tokens, status | ✅ Full agent tree | Console |

**Caravel's widget bar is excellent** — fixed size, always visible, never intrusive. This is a **design win** that Gas Town lacks. Caravel should keep this as-is and potentially add **agent health indicators** to it.

---

## 7. Key Recommendations

### Do Adopt (from Gas Town/City):
1. **Agent persistence** — persistent identity + session recovery
2. **Health monitoring** — stuck detection + auto-recovery
3. **Inter-agent messaging** — persistent message bus
4. **Predecessor context recovery** — query terminated agents
5. **Audit trail** — lightweight git-versioned log (no Dolt needed)
6. **Composable agent configs** — simple pack-like system
7. **Cost estimation** — predict token costs before execution
8. **Escalation system** — agents can escalate blockers

### Do NOT Adopt (from Gas Town/City):
1. **Dolt dependency** — too heavy; use JSONL or SQLite instead
2. **Go-based architecture** — keep Caravel Node.js/Pi-native
3. **20-30 agent scale** — keep 3-5 agent sweet spot
4. **Mad Max naming** — keep clear, descriptive names
5. **TOML-by-committee config** — keep YAML/JSON simplicity
6. **Mandatory multi-agent for everything** — Caravel works fine with 1-5 agents
7. **Complex import/lock model** — keep config simple
8. **Kubernetes provider** — not needed for Caravel's scope

### Keep As-Is (Caravel already does better):
1. **Two-stage review** (code + design) — superior to Gas Town's Refinery
2. **Fixed widget bar** — better than Gas Town's variable TUI
3. **Zero-friction installation** — symlink vs. Go + Dolt + tmux
4. **Cost-conscious design** — 3-5 agents vs. 20-30
5. **Testability enforcement (T7)** — brilliant feature, keep it
6. **Natural language workflow** — user never touches config
7. **Provider-agnostic model selection** — works with any provider

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Adding Dolt-like complexity | High | High | Keep persistence as JSONL + git, no Dolt |
| Over-engineering agent identity | Medium | Medium | Simple identity string, not full Beads schema |
| Breaking existing workflows | Medium | High | All new features opt-in, backward compatible |
| Token cost from more agents | Low | Medium | Keep agent count guidance (3-5) |
| ZFS compatibility issues | Low | Low | ZFS is optional, test independently |
| Pack system complexity creep | Medium | Medium | Simple YAML imports, no TOML lock files |

---

## 9. Conclusion

Caravel is **already well-designed** for its target use case (single-project fleet within Pi). Gas Town and Gas City are impressive but over-engineered for most users. Caravel should **selectively adopt** Gas Town/City's best ideas:

1. **Agent persistence** (identity + session recovery) — highest value, lowest complexity
2. **Health monitoring** (stuck detection + auto-recovery) — prevents silent failures
3. **Inter-agent messaging** (persistent message bus) — enables autonomous coordination
4. **Predecessor context** (seance-like recovery) — survives agent crashes
5. **Composable configs** (simple pack imports) — shareable agent definitions

Caravel should **resist** Gas Town/City's complexity bloat:
- No Dolt dependency
- No Go rewrite
- No 20-30 agent scale
- No Mad Max naming
- No TOML-by-committee

The goal: **Gas Town's reliability + Caravel's simplicity**.
