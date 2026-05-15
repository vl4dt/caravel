/**
 * Caravel Seance (Session) Persistence
 *
 * Records agent terminations and provides queryable session history for each
 * agent.  Persistent state lives in `.caravel/seances.json` with the shape:
 *   { records: SeanceRecord[] }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single seance (session) record. */
export interface SeanceRecord {
  /** Unique identifier for this seance. */
  id: string;
  /** Agent identity that was terminated (e.g. `caravel/developer/primary`). */
  agentIdentity: string;
  /** Task identifier this seance was working on. */
  taskId: string;
  /** Phase the agent was in when terminated. */
  phase: string;
  /** Termination timestamp (ms since epoch). */
  terminatedAt: number;
  /** Human-readable reason for the termination. */
  reason: string;
  /** Last checkpoint saved by the agent (optional). */
  lastCheckpoint?: Record<string, unknown>;
  /** Summary of the agent's work during this session. */
  workSummary?: string;
  /** Files that were modified during this session. */
  filesModified?: string[];
  /** Tool calls executed during this session (truncated summary). */
  toolCallHistory?: Array<{ tool: string; args: string; result: string }>;
  /** Snapshot of the context window at termination (truncated). */
  contextWindow?: string;
}

/** Schema for the top-level seance state persisted to `.caravel/seances.json`. */
interface SeanceState {
  records: SeanceRecord[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SEANCES_FILE_NAME = "seances.json";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Resolve the path to `.caravel/seances.json` relative to a given base directory. */
function seancesFilePath(cwd: string): string {
  return path.join(cwd, ".caravel", SEANCES_FILE_NAME);
}

/** Load the persisted seance file. Returns `null` if it doesn't exist or is corrupt. */
function loadSeancesFile(cwd: string): SeanceState | null {
  const filePath = seancesFilePath(cwd);
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
  if (!Array.isArray(parsed.records)) {
    return null;
  }

  return { records: parsed.records };
}

/**
 * Save the seance state to disk.
 * Writes atomically via a temp file + rename.
 */
function saveSeancesFile(cwd: string, data: SeanceState): void {
  const filePath = seancesFilePath(cwd);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = filePath + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Record that an agent was terminated.
 *
 * Appends a new SeanceRecord to `.caravel/seances.json` with the provided
 * details.  If no prior state exists, a new file is created.
 *
 * @param agentIdentity — Agent identity (e.g. `caravel/developer/primary`).
 * @param taskId        — Task identifier the agent was working on.
 * @param phase         — Phase the agent was in at termination (e.g. `coding`, `review`).
 * @param reason        — Human-readable termination reason.
 * @param checkpoint    — Optional last checkpoint saved by the agent.
 * @param extra         — Optional extra fields to attach (workSummary, filesModified, toolCallHistory, contextWindow).
 * @param cwd           — Optional base directory. Defaults to `process.cwd()`.
 */
export function recordTerminatedAgent(
  agentIdentity: string,
  taskId: string,
  phase: string,
  reason: string,
  checkpoint?: Record<string, unknown>,
  extra?: {
    workSummary?: string;
    filesModified?: string[];
    toolCallHistory?: Array<{ tool: string; args: string; result: string }>;
    contextWindow?: string;
  },
  cwd?: string,
): SeanceRecord {
  if (!agentIdentity || typeof agentIdentity !== "string" || agentIdentity.trim().length === 0) {
    throw new Error("recordTerminatedAgent: agentIdentity must be a non-empty string");
  }
  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("recordTerminatedAgent: taskId must be a non-empty string");
  }
  if (!phase || typeof phase !== "string" || phase.trim().length === 0) {
    throw new Error("recordTerminatedAgent: phase must be a non-empty string");
  }
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("recordTerminatedAgent: reason must be a non-empty string");
  }

  const now = Date.now();
  const record: SeanceRecord = {
    id: randomUUID(),
    agentIdentity,
    taskId,
    phase,
    terminatedAt: now,
    reason,
    lastCheckpoint: checkpoint,
    workSummary: extra?.workSummary,
    filesModified: extra?.filesModified,
    toolCallHistory: extra?.toolCallHistory,
    contextWindow: extra?.contextWindow,
  };

  const base = cwd ?? process.cwd();
  let state = loadSeancesFile(base);
  if (!state) {
    state = { records: [] };
  }

  state.records.push(record);
  saveSeancesFile(base, state);

  return record;
}

/**
 * Retrieve all seance records for a given agent.
 *
 * @param agentIdentity — Agent identity to filter by.
 * @param cwd — Optional base directory. Defaults to `process.cwd()`.
 * @returns Array of SeanceRecord sorted by terminatedAt (oldest first).
 */
export function getSeanceHistory(agentIdentity: string, cwd?: string): SeanceRecord[] {
  if (!agentIdentity || typeof agentIdentity !== "string" || agentIdentity.trim().length === 0) {
    throw new Error("getSeanceHistory: agentIdentity must be a non-empty string");
  }

  const base = cwd ?? process.cwd();
  const state = loadSeancesFile(base);
  if (!state) {
    return [];
  }

  return state.records
    .filter(r => r.agentIdentity === agentIdentity)
    .map(r => ({ ...r })) // shallow copy
    .sort((a, b) => a.terminatedAt - b.terminatedAt);
}

/**
 * Retrieve the seance record for a specific task.
 *
 * @param taskId — Task identifier to look up.
 * @param cwd — Optional base directory. Defaults to `process.cwd()`.
 * @returns The latest SeanceRecord for that taskId, or `null` if none exists.
 */
export function getSeance(taskId: string, cwd?: string): SeanceRecord | null {
  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("getSeance: taskId must be a non-empty string");
  }

  const base = cwd ?? process.cwd();
  const state = loadSeancesFile(base);
  if (!state) {
    return null;
  }

  const matching = state.records
    .filter(r => r.taskId === taskId)
    .sort((a, b) => b.terminatedAt - a.terminatedAt);

  if (matching.length === 0) {
    return null;
  }

  return { ...matching[0] }; // return a shallow copy of the latest
}

/**
 * Clear all seance records for a given task.
 *
 * @param taskId — Task identifier whose records should be removed.
 * @param cwd — Optional base directory. Defaults to `process.cwd()`.
 * @returns `true` if any records were removed, `false` if none existed.
 */
export function clearSeance(taskId: string, cwd?: string): boolean {
  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("clearSeance: taskId must be a non-empty string");
  }

  const base = cwd ?? process.cwd();
  const state = loadSeancesFile(base);
  if (!state) {
    return false;
  }

  const before = state.records.length;
  state.records = state.records.filter(r => r.taskId !== taskId);
  const removed = before - state.records.length;

  if (removed > 0) {
    saveSeancesFile(base, state);
    return true;
  }

  return false;
}

/**
 * Clear all persisted seance records (remove the file).
 */
export function clearAllSeances(cwd?: string): boolean {
  const base = cwd ?? process.cwd();
  const filePath = seancesFilePath(base);

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

/**
 * Retrieve all seance records across all agents.
 * Returns sorted by terminatedAt (oldest first).
 *
 * @param cwd — Optional base directory. Defaults to `process.cwd()`.
 */
export function getAllSeances(cwd?: string): SeanceRecord[] {
  const base = cwd ?? process.cwd();
  const state = loadSeancesFile(base);
  if (!state) {
    return [];
  }

  return [...state.records].sort((a, b) => a.terminatedAt - b.terminatedAt);
}

/**
 * Generate a deterministic recovery context string from a SeanceRecord.
 *
 * Output is ≤500 chars and includes workSummary, filesModified, and toolCallHistory.
 * Uses deterministic JSON serialization (sorted keys, no randomness).
 *
 * @param seance — A SeanceRecord to serialize.
 * @returns A deterministic recovery context string (≤500 chars).
 */
export function generateRecoveryContext(seance: SeanceRecord): string {
  const parts: string[] = [];

  if (seance.workSummary) {
    parts.push(`workSummary:${seance.workSummary}`);
  }

  if (seance.filesModified && seance.filesModified.length > 0) {
    parts.push(`filesModified:[${seance.filesModified.join(",")}]`);
  }

  if (seance.toolCallHistory && seance.toolCallHistory.length > 0) {
    const toolEntries = seance.toolCallHistory.map(tc => `${tc.tool}(${tc.args})→${tc.result}`).join("|");
    parts.push(`toolCallHistory:[${toolEntries}]`);
  }

  const raw = parts.join("||");

  // Enforce ≤500 char limit deterministically by trimming from the end
  if (raw.length > 500) {
    return raw.slice(0, 500);
  }

  return raw;
}

/**
 * Retrieve up to `limit` seance records for a specific task, oldest first.
 *
 * @param taskId — Task identifier to filter by.
 * @param limit  — Maximum number of records to return (default 2).
 * @param cwd    — Optional base directory. Defaults to `process.cwd()`.
 * @returns Array of SeanceRecord sorted by terminatedAt (oldest first).
 */
export function getSeanceRecordsForTask(
  taskId: string,
  limit: number = 2,
  cwd?: string,
): SeanceRecord[] {
  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("getSeanceRecordsForTask: taskId must be a non-empty string");
  }

  const base = cwd ?? process.cwd();
  const state = loadSeancesFile(base);
  if (!state) {
    return [];
  }

  return state.records
    .filter(r => r.taskId === taskId)
    .sort((a, b) => a.terminatedAt - b.terminatedAt)
    .slice(0, limit)
    .map(r => ({ ...r }));
}

/**
 * Get a count of all persisted seance records.
 *
 * @param cwd — Optional base directory. Defaults to `process.cwd()`.
 */
export function getSeanceCount(cwd?: string): number {
  const base = cwd ?? process.cwd();
  const state = loadSeancesFile(base);
  if (!state) {
    return 0;
  }
  return state.records.length;
}
