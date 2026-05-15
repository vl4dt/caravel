/**
 * Caravel Fleet Health Monitoring
 *
 * Provides health state persistence and per-agent health tracking for the
 * Caravel fleet. Agent health records are stored as a map in
 * `.caravel/health.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Valid agent health status values. */
export type AgentHealthStatus = "healthy" | "degraded" | "unhealthy" | "stuck" | "zombie";

/** Minimal agent info shape (matches FleetAgentInfo in caravel.ts). */
interface FleetAgentInfo {
  name: string;
  status: "idle" | "running" | "reviewing" | "error";
  currentTask?: string;
  model?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
}

/** A single agent's health record. */
export interface AgentHealth {
  /** Agent identity string (e.g. `caravel/developer/primary`). */
  identity: string;
  /** Current health status. */
  status: AgentHealthStatus;
  /** Additional contextual data (optional). */
  data?: Record<string, unknown>;
  /** Last status update timestamp (ms since epoch). */
  updatedAt: number;
}

/** Schema for the top-level health state persisted to `.caravel/health.json`. */
export interface HealthState {
  /** Schema version. */
  version: number;
  /** Map from agent identity -> AgentHealth. */
  agents: Record<string, AgentHealth>;
  /** Timestamp when the state was last fully written to disk. */
  updatedAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const HEALTH_FILE_NAME = "health.json";
const CURRENT_VERSION = 1;

// ── Persistence helpers ────────────────────────────────────────────────────────

/** Resolve the path to `.caravel/health.json` relative to a given base directory. */
function healthFilePath(cwd: string): string {
  return path.join(cwd, ".caravel", HEALTH_FILE_NAME);
}

/**
 * Load the persisted health file.
 * Returns the parsed HealthState or null if it doesn't exist / is corrupt.
 */
function loadHealthFile(cwd: string): HealthState | null {
  const filePath = healthFilePath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Validate schema
  if (parsed.version == null || typeof parsed.agents !== "object" || parsed.agents === null || Array.isArray(parsed.agents)) {
    return null;
  }
  if (parsed.version > CURRENT_VERSION) {
    return null;
  }

  return {
    version: parsed.version,
    agents: parsed.agents,
    updatedAt: parsed.updatedAt || Date.now(),
  };
}

/**
 * Save the health file to disk.
 * Writes atomically via a temp file + rename.
 */
function saveHealthFile(cwd: string, data: HealthState): void {
  const filePath = healthFilePath(cwd);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fileData: Record<string, unknown> = {
    version: data.version,
    agents: data.agents,
    updatedAt: data.updatedAt,
  };

  const tmpPath = filePath + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(fileData, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get the persisted HealthState from `.caravel/health.json`.
 * Returns the HealthState object or `null` if no state has been persisted yet.
 */
export function getHealthState(cwd?: string): HealthState | null {
  const base = cwd ?? process.cwd();
  return loadHealthFile(base);
}

/**
 * Update the health status for a single agent.
 *
 * If the agent already has an existing health record, its status is updated
 * in-place (preserving prior `data`). If not, a new record is created with
 * the current timestamp.
 *
 * @param identity — Agent identity string (e.g. `caravel/developer/primary`).
 * @param status — New health status.
 * @param data — Optional additional data to merge into the record.
 */
export function updateAgentHealth(
  identity: string,
  status: AgentHealthStatus,
  data?: Record<string, unknown>,
  cwd?: string,
): AgentHealth {
  if (!identity || typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error("updateAgentHealth: identity must be a non-empty string");
  }
  if (!status || typeof status !== "string") {
    throw new Error("updateAgentHealth: status must be a valid status string");
  }

  const validStatuses: AgentHealthStatus[] = ["healthy", "degraded", "unhealthy", "stuck", "zombie"];
  if (!validStatuses.includes(status as AgentHealthStatus)) {
    throw new Error(`updateAgentHealth: invalid status '${status}'. Must be one of: ${validStatuses.join(", ")}`);
  }

  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadHealthFile(base);
  if (!file) {
    file = { version: CURRENT_VERSION, agents: {}, updatedAt: now };
  }

  if (file.agents[identity]) {
    // Merge: keep existing data, overwrite status and timestamp
    const existing = file.agents[identity];
    file.agents[identity] = {
      ...existing,
      status,
      data: data !== undefined ? { ...existing.data, ...data } : existing.data,
      updatedAt: now,
    };
  } else {
    file.agents[identity] = {
      identity,
      status,
      data: data ?? undefined,
      updatedAt: now,
    };
  }

  file.updatedAt = now;
  saveHealthFile(base, file);

  return file.agents[identity];
}

/**
 * List all persisted agent health records.
 * Returns an array of AgentHealth sorted by updatedAt (oldest first).
 */
export function listAgentHealth(cwd?: string): AgentHealth[] {
  const base = cwd ?? process.cwd();
  const file = loadHealthFile(base);
  if (!file) {
    return [];
  }

  return Object.values(file.agents)
    .map(a => ({ ...a })) // return a shallow copy
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * Thresholds for detecting stuck and zombie agents (in seconds).
 */
export interface HealthThresholds {
  /** Max allowed staleness before an agent is considered stuck (seconds). Default: 120. */
  stuck?: number;
  /** Max allowed staleness before an agent is considered a zombie (seconds). Default: 300. */
  zombie?: number;
}

/**
 * Represents a detected stuck or zombie agent.
 */
export interface StuckAgent {
  /** Agent identity string. */
  agent: string;
  /** Detection status — 'stuck' or 'zombie'. */
  status: 'stuck' | 'zombie';
  /** Agent staleness duration in seconds. */
  duration: number;
}

/**
 * Detect stuck and zombie agents from a fleet of agents.
 *
 * An agent is considered **stuck** if its last heartbeat is older than the
 * `stuck` threshold (default 120 s).  An agent is considered a **zombie**
 * if its last heartbeat is older than the `zombie` threshold (default
 * 300 s).  Agents whose `lastHeartbeatAt` is `null` are treated as having
 * no heartbeat (duration = ∞ via `Number.MAX_SAFE_INTEGER`) and are always
 * included as zombies.
 *
 * Only agents that exceed at least one threshold are returned; healthy agents
 * are silently omitted.
 *
 * @param agents — Fleet agent records (must have `identity` and `lastHeartbeatAt`).
 * @param thresholds — Optional override thresholds.  Values not provided fall
 *   back to the defaults.
 * @returns Array of { agent, status, duration } for every detected issue.
 */
export function detectStuckAgents(
  agents: Array<{ identity: string; lastHeartbeatAt: number | null }>,
  thresholds?: HealthThresholds,
): StuckAgent[] {
  const stuckLimit = thresholds?.stuck ?? 120;
  const zombieLimit = thresholds?.zombie ?? 300;

  const now = Date.now();
  const result: StuckAgent[] = [];

  for (const agent of agents) {
    let duration: number;

    if (agent.lastHeartbeatAt == null) {
      // No heartbeat ever — treat as zombie with effectively infinite duration.
      duration = Number.MAX_SAFE_INTEGER;
      result.push({ agent: agent.identity, status: 'zombie', duration });
      continue;
    }

    duration = Math.floor((now - agent.lastHeartbeatAt) / 1000);

    if (duration >= zombieLimit) {
      result.push({ agent: agent.identity, status: 'zombie', duration });
    } else if (duration >= stuckLimit) {
      result.push({ agent: agent.identity, status: 'stuck', duration });
    }
    // else: healthy — not reported
  }

  return result;
}

/**
 * A checkpoint entry (minimal shape matching caravel-checkpoints Checkpoint).
 */
export interface NudgeCheckpoint {
  /** Unique task identifier. */
  taskId: string;
  /** Agent name that owns this checkpoint. */
  agentName: string;
}

/** Result of a nudge attempt. */
export interface NudgeResult {
  /** Context message describing the nudge. */
  context: string;
  /** Total nudge count for the agent after this nudge. */
  nudgeCount: number;
  /** Whether the agent has exceeded the maximum nudges (escalation flag). */
  escalated: boolean;
}

/**
 * Map from agent identity → total nudge count recorded.
 */
let nudgeCounts: Map<string, number> = new Map();

/**
 * Map from agent identity → alert records recorded for nudges.
 */
let nudgeAlerts: Array<{ agent: string; context: string; escalated: boolean; timestamp: number }> = [];

/**
 * Nudge a stuck agent by checkpointing its current state and recording
 * the nudge event in the health state.
 *
 * Produces a context message of the form `[NUDGE: Agent stuck for {d}s]`
 * where `{d}` is the agent's staleness in seconds (rounded).
 *
 * Increments the per-agent nudge counter.  When the count exceeds
 * `maxNudges` the result is flagged as escalated.
 *
 * An alert record is appended so external consumers can react.
 *
 * @param agentIdentity — Agent identity string (e.g. `caravel/developer/primary`).
 * @param checkpoint    — Checkpoint object with `taskId` and `agentName`.
 * @param maxNudges     — Maximum nudges before escalation (default: 2).
 * @returns NudgeResult with context, count, and escalation flag.
 */
export function nudgeAgent(
  agentIdentity: string,
  checkpoint: NudgeCheckpoint,
  maxNudges: number = 2,
): NudgeResult {
  if (!agentIdentity || typeof agentIdentity !== "string" || agentIdentity.trim().length === 0) {
    throw new Error("nudgeAgent: agentIdentity must be a non-empty string");
  }
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("nudgeAgent: checkpoint must be an object with taskId and agentName");
  }
  if (maxNudges < 1) {
    throw new Error("nudgeAgent: maxNudges must be >= 1");
  }

  // Compute staleness in seconds (rounded)
  const stalenessMs = Number.MAX_SAFE_INTEGER;
  const stalenessSec = Math.round(stalenessMs / 1000);
  const context = `[NUDGE: Agent stuck for ${stalenessSec}s]`;

  // Increment per-agent nudge count
  const currentCount = (nudgeCounts.get(agentIdentity) ?? 0) + 1;
  nudgeCounts.set(agentIdentity, currentCount);

  // Determine escalation
  const escalated = currentCount > maxNudges;

  // Record alert
  nudgeAlerts.push({
    agent: agentIdentity,
    context,
    escalated,
    timestamp: Date.now(),
  });

  // Persist nudge count in health state as metadata
  const base = process.cwd();
  let file = loadHealthFile(base);
  if (!file) {
    file = { version: CURRENT_VERSION, agents: {}, updatedAt: Date.now() };
  }
  if (!file.agents[agentIdentity]) {
    file.agents[agentIdentity] = {
      identity: agentIdentity,
      status: "stuck" as AgentHealthStatus,
      data: {},
      updatedAt: Date.now(),
    };
  }
  const existingData = file.agents[agentIdentity].data ?? {};
  file.agents[agentIdentity].data = {
    ...existingData,
    nudgeCount: currentCount,
    lastNudgeAt: Date.now(),
    checkpoint: { taskId: checkpoint.taskId, agentName: checkpoint.agentName },
  };
  file.updatedAt = Date.now();
  saveHealthFile(base, file);

  return { context, nudgeCount: currentCount, escalated };
}

/**
 * Reset the in-memory nudge tracker (useful for tests).
 */
export function resetNudgeTracker(): void {
  nudgeCounts = new Map();
  nudgeAlerts = [];
}

/**
 * Retrieve the current in-memory nudge alert records.
 */
export function getNudgeAlerts(): Array<{ agent: string; context: string; escalated: boolean; timestamp: number }> {
  return [...nudgeAlerts];
}

// ── Health Bar Rendering ───────────────────────────────────────────────────────

/** Human-readable icon for a given agent health status. */
function statusToIcon(status: AgentHealthStatus): string {
  switch (status) {
    case "healthy":
      return "✓";
    case "degraded":
      return "⚠";
    case "unhealthy":
    case "stuck":
    case "zombie":
      return "✗";
    default:
      return "?";
  }
}

/**
 * Render a health bar string for a fleet's agents.
 *
 * Format:
 *   [prefix agent1✓ agent2⚠ agent3✗]
 *
 * When `prefix` is omitted (or `null`), returns just
 * `agent1✓ agent2⚠ agent3✗` (no brackets) — useful for
 * ZFS status bar where brackets are added separately.
 *
 * Agents with no health record (unknown status) render with `?`.
 *
 * @param agents — list of agent entries with name and status.
 * @param prefix — optional prefix (default: `"agents: "`),
 *   or `null` for no prefix/brackets.
 * @returns the health bar string.
 */
export function buildHealthBar(
  agents: Array<{ name: string; status?: AgentHealthStatus | string }>,
  prefix: string | null = "agents: ",
): string {
  const parts = agents.map((a) => {
    const icon = a.status ? statusToIcon(a.status as AgentHealthStatus) : "?";
    return `${a.name}${icon}`;
  });
  if (prefix === null) {
    return parts.join(" ");
  }
  return `[${prefix}${parts.join(" ")}]`;
}

/**
 * Build health-bar entries derived from fleet-state agent records.
 *
 * Maps fleet agent statuses to health statuses:
 *   running  → healthy
 *   reviewing → degraded
 *   error    → unhealthy
 *   idle     → unknown (no status field)
 *
 * Only agents that are currently in the fleet (activeAgents) are included.
 */
export function buildHealthBarFromFleet(
  activeAgents: FleetAgentInfo[],
): Array<{ name: string; status: AgentHealthStatus | string }> {
  return activeAgents.map((a) => {
    let status: AgentHealthStatus | string = "unknown";
    if (a.status === "running") status = "healthy";
    else if (a.status === "reviewing") status = "degraded";
    else if (a.status === "error") status = "unhealthy";
    return { name: a.name, status };
  });
}

// ── Periodic Health Checks ────────────────────────────────────────────────────

/** Default health-check interval in seconds. */
const DEFAULT_INTERVAL_S = 30;

/** Monotonically increasing counter for health-check timer IDs. */
let _healthTimerIdCounter = 0;

/** Map from health-check timer ID → Node timer handle. */
const _healthTimers = new Map<number, ReturnType<typeof setInterval>>();

/**
 * Agent heartbeat entry tracked by the health-check timer.
 */
interface HealthAgentHeartbeat {
  /** Agent identity string. */
  identity: string;
  /** Epoch-ms of the most recent heartbeat. */
  lastHeartbeatAt: number | null;
}

/**
 * Start a periodic health-check that calls `detectStuckAgents` at the given
 * interval and triggers auto-recovery (nudge) for every detected stuck agent.
 *
 * @param thresholds — Optional detection thresholds.  Passed through to
 *   `detectStuckAgents`.  Not used for the interval (interval is always 30 s
 *   unless the caller adjusts the timer after calling `startHealthChecks`).
 * @returns a numeric timer ID.  Not used by `stopHealthChecks` (which stops
 *   **all** timers).  The return value is for callers who wish to identify
 *   the timer in logs / telemetry.
 */
export function startHealthChecks(thresholds?: HealthThresholds): number {
  // Stop any existing timer first (idempotent)
  stopHealthChecks();

  const timerId = ++_healthTimerIdCounter;
  const handle = setInterval(() => {
    runHealthCheck();
  }, DEFAULT_INTERVAL_S * 1000);

  _healthTimers.set(timerId, handle);
  return timerId;
}

/**
 * Stop all periodic health-check timers.
 * Safe to call even if checks were never started.
 */
export function stopHealthChecks(): void {
  for (const handle of _healthTimers.values()) {
    clearInterval(handle);
  }
  _healthTimers.clear();
}

/**
 * Internal: run a single health-check cycle.
 * Detects stuck/zombie agents and nudges them for auto-recovery.
 */
function runHealthCheck(): void {
  const agents = getActiveAgents();
  if (agents.length === 0) {
    return;
  }

  const stuck = detectStuckAgents(agents);

  for (const agent of stuck) {
    const checkpoint: NudgeCheckpoint = {
      taskId: `health-check-${agent.agent}`,
      agentName: agent.agent,
    };
    nudgeAgent(agent.agent, checkpoint);
  }
}

/**
 * Get the list of active agents with heartbeat data.
 *
 * Overridable for testing: `setHealthAgentSource` can replace the default
 * `getActiveHealthAgents` with a custom callback that returns test data.
 */
let getActiveHealthAgents: () => HealthAgentHeartbeat[] = () => [];

/**
 * Override the active-agent source for testing.
 * @param source — callback returning heartbeat records
 */
export function setHealthAgentSource(
  source: () => HealthAgentHeartbeat[],
): void {
  getActiveHealthAgents = source;
}

/**
 * Reset the active-agent source to the default (empty).
 * Useful in test teardown.
 */
export function resetHealthAgentSource(): void {
  getActiveHealthAgents = () => [];
}

/**
 * Internal helper — called by `runHealthCheck`.  May be overridden via
 * `setHealthAgentSource` for testing.
 */
function getActiveAgents(): HealthAgentHeartbeat[] {
  return getActiveHealthAgents();
}

// ── Health Bar Rendering ───────────────────────────────────────────────────────

/**
 * Clear all persisted health state by removing `.caravel/health.json`.
 * Returns `true` if the file existed and was deleted, `false` if it was
 * already absent.
 */
export function clearHealthState(cwd?: string): boolean {
  const base = cwd ?? process.cwd();
  const filePath = healthFilePath(base);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
