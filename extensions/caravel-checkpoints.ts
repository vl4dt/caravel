/**
 * Caravel Checkpoint Management
 *
 * Saves, loads, lists, and deletes task checkpoints for the Caravel
 * fleet orchestrator. Checkpoints persist individual agent state so
 * work can be resumed after crashes, restarts, or context overflow.
 *
 * Storage layout:
 *   .caravel/checkpoints/<taskId>-checkpoint.json
 *
 * Usage:
 *   import { saveCheckpoint, loadCheckpoint, listCheckpoints, deleteCheckpoint, generateContextSummary } from "./caravel-checkpoints";
 *   saveCheckpoint("task-1", "developer", { messages: [...], tokens: 4200 });
 *   const cp = loadCheckpoint("task-1");
 *   listCheckpoints();        // all
 *   listCheckpoints("dev");   // filtered by agent
 *   deleteCheckpoint("task-1");
 *   const summary = generateContextSummary(toolCalls, output);
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Checkpoint entry stored on disk.
 *
 * The `state` field is intentionally typed as `unknown` to accept any
 * serialisable agent state (messages, tool-call logs, memory, etc.).
 */
interface Checkpoint {
  /** Unique task identifier (provided by the caller at save time). */
  taskId: string;
  /** Agent name that created this checkpoint. */
  agentName: string;
  /** Arbitrary serialisable state payload. */
  state: unknown;
  /** Wall-clock timestamp (ms since epoch) of creation. */
  createdAt: number;
  /** Wall-clock timestamp (ms) of the last update. */
  updatedAt: number;
}

/** Minimal metadata returned by listCheckpoints (avoids serialising full state). */
interface CheckpointMeta {
  taskId: string;
  agentName: string;
  createdAt: number;
  updatedAt: number;
}

/** Internal file schema version. */
const CHECKPOINT_VERSION = 1;

/** Maximum characters in the context summary returned by generateContextSummary. */
const MAX_SUMMARY_LENGTH = 200;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Return the directory path where checkpoints live, creating it if needed.
 */
function getCheckpointDir(projectRoot: string): string {
  const dir = path.join(projectRoot, ".caravel", "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Return the file path for a given taskId.
 */
function checkpointFilePath(projectRoot: string, taskId: string): string {
  // Sanitise taskId to prevent path traversal
  const safeId = taskId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(getCheckpointDir(projectRoot), `${safeId}-checkpoint.json`);
}

/**
 * Read a checkpoint file and return parsed data, or null if missing / corrupt.
 */
function readCheckpointFile(projectRoot: string, taskId: string): Checkpoint | null {
  const filePath = checkpointFilePath(projectRoot, taskId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Checkpoint;
    if (data.taskId && data.agentName && data.createdAt && data.updatedAt) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a checkpoint object to disk with a version wrapper.
 */
function writeCheckpointFile(projectRoot: string, taskId: string, checkpoint: Checkpoint): void {
  const filePath = checkpointFilePath(projectRoot, taskId);
  const wrapper = {
    _v: CHECKPOINT_VERSION,
    ...checkpoint,
  };
  fs.writeFileSync(filePath, JSON.stringify(wrapper, null, 2), "utf-8");
}

/**
 * Read all checkpoint files from the checkpoints directory, returning metadata
 * (lightweight — no full state payloads).
 */
function readAllCheckpoints(projectRoot: string): CheckpointMeta[] {
  const dir = getCheckpointDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  const meta: CheckpointMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith("-checkpoint.json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as Checkpoint;
      if (data.taskId && data.agentName) {
        meta.push({
          taskId: data.taskId,
          agentName: data.agentName,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        });
      }
    } catch {
      // Skip corrupt files
    }
  }
  // Sort by updatedAt descending (most recent first)
  meta.sort((a, b) => b.updatedAt - a.updatedAt);
  return meta;
}

/**
 * Delete a checkpoint file by taskId.
 */
function removeCheckpointFile(projectRoot: string, taskId: string): boolean {
  const filePath = checkpointFilePath(projectRoot, taskId);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Save (or update) a checkpoint for a given task.
 *
 * If a checkpoint for `taskId` already exists it is merged: the `state` is
 * replaced and `updatedAt` advances. Returns `true` on success.
 *
 * @param taskId   - Unique task identifier.
 * @param agentName - Agent that owns this checkpoint.
 * @param state    - Arbitrary serialisable state to persist.
 * @param projectRoot - Project root (defaults to process.cwd()).
 * @returns true if the checkpoint was saved.
 */
export function saveCheckpoint(
  taskId: string,
  agentName: string,
  state: unknown,
  projectRoot?: string
): boolean {
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    throw new Error("saveCheckpoint: taskId must be a non-empty string");
  }
  if (!agentName || typeof agentName !== "string" || agentName.trim() === "") {
    throw new Error("saveCheckpoint: agentName must be a non-empty string");
  }
  if (state === null || state === undefined) {
    throw new Error("saveCheckpoint: state must not be null or undefined");
  }

  const root = projectRoot || process.cwd();
  const now = Date.now();

  // Check if existing checkpoint; preserve createdAt if so
  const existing = readCheckpointFile(root, taskId);
  const checkpoint: Checkpoint = {
    taskId,
    agentName,
    state,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };

  try {
    writeCheckpointFile(root, taskId, checkpoint);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a checkpoint by taskId.
 *
 * @param taskId  - The task identifier to load.
 * @param projectRoot - Project root (defaults to process.cwd()).
 * @returns The checkpoint, or `null` if not found.
 */
export function loadCheckpoint(
  taskId: string,
  projectRoot?: string
): Checkpoint | null {
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    return null;
  }
  const root = projectRoot || process.cwd();
  return readCheckpointFile(root, taskId);
}

/**
 * List all checkpoints, optionally filtered by agent name.
 *
 * @param agentName - Optional filter: only return checkpoints for this agent.
 * @param projectRoot - Project root (defaults to process.cwd()).
 * @returns Array of checkpoint metadata, newest first.
 */
export function listCheckpoints(
  agentName?: string,
  projectRoot?: string
): CheckpointMeta[] {
  const root = projectRoot || process.cwd();
  let all = readAllCheckpoints(root);
  if (agentName) {
    all = all.filter((c) => c.agentName === agentName);
  }
  return all;
}

/**
 * Delete a checkpoint by taskId.
 *
 * @param taskId  - The task identifier to delete.
 * @param projectRoot - Project root (defaults to process.cwd()).
 * @returns true if the file existed and was deleted.
 */
export function deleteCheckpoint(
  taskId: string,
  projectRoot?: string
): boolean {
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    return false;
  }
  const root = projectRoot || process.cwd();
  return removeCheckpointFile(root, taskId);
}

/**
 * Generate a deterministic, compact summary from tool calls and output.
 *
 * Produces a fixed-length string (≤ 200 chars) that can be used as a
 * context summary for checkpoint metadata or log indexing.
 *
 * Determinism guarantees:
 *   - Same input → same output (no randomness, no timestamps)
 *   - toolCalls are sorted by id before hashing
 *   - Output text is normalised (trimmed, collapsed whitespace)
 *
 * @param toolCalls - Array of tool call objects (must be serialisable).
 * @param output    - Agent output string.
 * @returns A deterministic summary string (≤ 200 chars).
 */
export function generateContextSummary(
  toolCalls: unknown[],
  output: string
): string {
  // Normalise output
  const normalised = output
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // Build a deterministic tool-call signature
  let toolSig = "";
  try {
    // Sort tool calls by id (if present) for determinism
    const sorted = [...toolCalls]
      .filter((tc: any) => tc != null && typeof tc === "object")
      .sort((a: any, b: any) => {
        const aId = a.id ?? a.name ?? "";
        const bId = b.id ?? b.name ?? "";
        return String(aId).localeCompare(String(bId));
      })
      .map((tc: any) => {
        // Extract a compact signature from each tool call
        const id = tc.id ?? "";
        const name = tc.name ?? tc.tool ?? "";
        const args = tc.input ?? tc.arguments ?? tc.args ?? {};
        const argsKey = Object.keys(args)
          .sort()
          .map((k) => `${k}:${String(args[k] ?? "").slice(0, 20)}`)
          .join("|");
        return `${name}(${id.slice(0, 4)}):${argsKey}`;
      })
      .join(" | ");

    // Truncate tool sig if needed
    if (toolSig.length > 160) {
      toolSig = toolSig.slice(0, 160) + "...";
    }

    // Fallback: if toolSig is empty, use a simple representation
    if (toolSig === "" || toolSig.length > 160) {
      toolSig = `${toolCalls.length}tool${toolCalls.length === 1 ? "" : "s"}`;
    }
  } catch {
    toolSig = `${toolCalls.length}tool${toolCalls.length === 1 ? "" : "s"}`;
  }

  // Combine tool sig + output into a summary
  let summary = `${toolSig} | ${normalised}`;

  // Enforce hard 200-char limit
  if (summary.length > MAX_SUMMARY_LENGTH) {
    summary = summary.slice(0, MAX_SUMMARY_LENGTH - 3) + "...";
  }

  return summary;
}

// ── Periodic checkpointing ────────────────────────────────────────────────────

/** Default interval in milliseconds (60 seconds). */
const DEFAULT_INTERVAL_MS = 60_000;

/** Counter for generating unique numeric timer IDs. */
let timerIdCounter = 0;

/** Map from taskId → Node.js timer object (from setInterval). */
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Map from numeric timerId → taskId, for reverse lookup on clearInterval. */
const numericIdToTaskId = new Map<number, string>();

/**
 * Start periodic checkpointing for a task.
 *
 * Every `intervalMs` milliseconds (default 60s) the current checkpoint is
 * re-saved by reading the latest state from the checkpoint and writing it
 * back, thereby advancing `updatedAt` and keeping the checkpoint alive.
 *
 * Returns a timer ID that can be passed to `stopPeriodicCheckpointing`.
 *
 * @param taskId       - The task to checkpoint periodically.
 * @param intervalMs   - Interval in ms (default 60 000 ms = 60 s).
 * @param projectRoot  - Project root (defaults to process.cwd()).
 * @returns Timer ID (number on Node). Use this to stop later.
 */
export function startPeriodicCheckpointing(
  taskId: string,
  intervalMs?: number,
  projectRoot?: string
): number {
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    throw new Error("startPeriodicCheckpointing: taskId must be a non-empty string");
  }

  // Stop any existing periodic checkpoint for the same taskId
  if (activeTimers.has(taskId)) {
    stopPeriodicCheckpointing(taskId);
  }

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;
  const root = projectRoot || process.cwd();

  const timer = setInterval(() => {
    const cp = loadCheckpoint(taskId, root);
    if (cp) {
      saveCheckpoint(taskId, cp.agentName, cp.state, root);
    }
  }, interval);

  activeTimers.set(taskId, timer);

  // Generate and return a unique numeric timer ID
  const numericId = ++timerIdCounter;
  return numericId;
}

/**
 * Stop periodic checkpointing for a task.
 *
 * @param taskId - The task whose periodic checkpoint should be stopped.
 */
export function stopPeriodicCheckpointing(taskId: string): void {
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    return;
  }
  const timer = activeTimers.get(taskId);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(taskId);
  }
}

// ── Re-export types ────────────────────────────────────────────────────────────

export { Checkpoint, CheckpointMeta };
