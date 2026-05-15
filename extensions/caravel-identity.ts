/**
 * Caravel Agent Identity Management
 *
 * Provides deterministic identity generation, persistence, and reset
 * for agents within the Caravel fleet. Identities are stored as
 * `caravel/<name>/primary` format and persisted to `.caravel/agents.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentIdentity {
  name: string;
  identity: string;
  createdAt: number;
  updatedAt: number;
}

/** An entry recorded by recordWork(). */
export interface WorkEntry {
  /** The agent identity that performed this work. */
  identity: string;
  /** Unique task identifier (provided by caller). */
  taskId: string;
  /** Phase label (e.g. 'design', 'implement', 'review', 'test'). */
  phase: string;
  /** Brief human-readable summary. */
  summary: string;
  /** Timestamp when the entry was recorded. */
  timestamp: number;
}

/** Schema for the persisted agents.json file. */
interface AgentsFile {
  version: number;
  agents: AgentIdentity[];
  updatedAt: number;
}

/** Schema for the persisted history.json file. */
interface HistoryFile {
  version: number;
  /** Map from agent identity -> array of WorkEntry. */
  work: Record<string, WorkEntry[]>;
  updatedAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const IDENTITY_PREFIX = "caravel/";
const IDENTITY_SUFFIX = "/primary";
const AGENTS_FILE_NAME = "agents.json";
const HISTORY_FILE_NAME = "history.json";
const CURRENT_VERSION = 1;
const HISTORY_VERSION = 1;

/** Maximum number of work entries kept per agent before auto-rotation. */
const MAX_ENTRIES_PER_AGENT = 100;

// ── Identity generation ────────────────────────────────────────────────────────

/**
 * Generate a deterministic agent identity string.
 * Format: `caravel/<name>/primary`
 */
export function getAgentIdentity(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("getAgentIdentity: name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("getAgentIdentity: name must be a non-empty string");
  }
  return `${IDENTITY_PREFIX}${trimmed}${IDENTITY_SUFFIX}`;
}

// ── Persistence helpers ────────────────────────────────────────────────────────

/** Resolve the path to `.caravel/agents.json` relative to a given base directory. */
function agentsFilePath(cwd: string): string {
  return path.join(cwd, ".caravel", AGENTS_FILE_NAME);
}

/**
 * Load the persisted agents file.
 * Returns the parsed AgentsFile or null if it doesn't exist / is corrupt.
 */
function loadAgentsFile(cwd: string): AgentsFile | null {
  const filePath = agentsFilePath(cwd);
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
  if (parsed.version == null || !Array.isArray(parsed.agents)) {
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
 * Save the agents file to disk.
 * Writes atomically via a temp file + rename.
 */
function saveAgentsFile(cwd: string, data: AgentsFile): void {
  const filePath = agentsFilePath(cwd);
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
 * Get the list of persisted agent identities.
 * Reads from `.caravel/agents.json` in the current working directory.
 */
export function listAgentIdentities(cwd?: string): AgentIdentity[] {
  const base = cwd ?? process.cwd();
  const file = loadAgentsFile(base);
  return file ? file.agents : [];
}

/**
 * Persist an agent identity to `.caravel/agents.json`.
 * If an identity for the same name already exists, it is updated in-place.
 */
export function registerAgentIdentity(name: string, cwd?: string): AgentIdentity {
  const identity = getAgentIdentity(name);
  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadAgentsFile(base);
  if (!file) {
    file = { version: CURRENT_VERSION, agents: [], updatedAt: now };
  }

  const existingIdx = file.agents.findIndex((a) => a.name === name);
  if (existingIdx >= 0) {
    file.agents[existingIdx] = {
      name,
      identity,
      createdAt: file.agents[existingIdx].createdAt,
      updatedAt: now,
    };
  } else {
    file.agents.push({ name, identity, createdAt: now, updatedAt: now });
  }

  file.updatedAt = now;
  saveAgentsFile(base, file);

  return { name, identity, createdAt: file.agents[existingIdx >= 0 ? existingIdx : file.agents.length - 1].createdAt, updatedAt: now };
}

/**
 * Remove a persisted agent identity by name.
 * Returns true if the identity was found and removed, false otherwise.
 */
export function resetAgentIdentity(name: string, cwd?: string): boolean {
  const base = cwd ?? process.cwd();
  const file = loadAgentsFile(base);
  if (!file) return false;

  const initialLen = file.agents.length;
  file.agents = file.agents.filter((a) => a.name !== name);

  if (file.agents.length === initialLen) {
    return false;
  }

  file.updatedAt = Date.now();
  saveAgentsFile(base, file);
  return true;
}

// ── History / work tracking persistence ────────────────────────────────────────

/** Resolve the path to `.caravel/history.json` relative to a given base directory. */
function historyFilePath(cwd: string): string {
  return path.join(cwd, ".caravel", HISTORY_FILE_NAME);
}

/** Load the persisted history file. */
function loadHistoryFile(cwd: string): HistoryFile | null {
  const filePath = historyFilePath(cwd);
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

  if (parsed.version == null || typeof parsed.work !== "object" || parsed.work === null || Array.isArray(parsed.work)) {
    return null;
  }

  return {
    version: parsed.version,
    work: parsed.work,
    updatedAt: parsed.updatedAt || Date.now(),
  };
}

/** Save the history file to disk. */
function saveHistoryFile(cwd: string, data: HistoryFile): void {
  const filePath = historyFilePath(cwd);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fileData: Record<string, unknown> = {
    version: data.version,
    work: data.work,
    updatedAt: data.updatedAt,
  };

  const tmpPath = filePath + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(fileData, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Record a piece of work performed by an agent.
 *
 * Appends a WorkEntry to `.caravel/history.json` for the given identity,
 * then auto-rotates that identity's entries if they exceed MAX_ENTRIES_PER_AGENT.
 */
export function recordWork(
  identity: string,
  taskId: string,
  phase: string,
  summary: string,
  cwd?: string,
): void {
  if (!identity || typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error("recordWork: identity must be a non-empty string");
  }
  if (!taskId || typeof taskId !== "string") {
    throw new Error("recordWork: taskId must be a non-empty string");
  }
  if (!phase || typeof phase !== "string") {
    throw new Error("recordWork: phase must be a non-empty string");
  }
  if (!summary || typeof summary !== "string") {
    throw new Error("recordWork: summary must be a non-empty string");
  }

  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadHistoryFile(base);
  if (!file) {
    file = { version: HISTORY_VERSION, work: {}, updatedAt: now };
  }

  // Ensure the identity bucket exists
  if (!file.work[identity]) {
    file.work[identity] = [];
  }

  file.work[identity].push({ identity, taskId, phase, summary, timestamp: now });
  file.updatedAt = now;

  // Auto-rotate: drop oldest entries if over the limit
  const entries = file.work[identity];
  if (entries.length > MAX_ENTRIES_PER_AGENT) {
    const excess = entries.length - MAX_ENTRIES_PER_AGENT;
    entries.splice(0, excess);
  }

  saveHistoryFile(base, file);
}

/**
 * Get all work entries for a specific agent identity.
 * Returns WorkEntry[] sorted by timestamp (oldest first).
 */
export function getAgentHistory(identity: string, cwd?: string): WorkEntry[] {
  const base = cwd ?? process.cwd();
  const file = loadHistoryFile(base);
  if (!file || !file.work[identity]) {
    return [];
  }
  // Return a copy sorted by timestamp ascending
  return [...file.work[identity]].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Get all work entries across all agents for a given phase.
 * Returns WorkEntry[] sorted by timestamp (oldest first).
 */
export function getPhaseHistory(phase: string, cwd?: string): WorkEntry[] {
  const base = cwd ?? process.cwd();
  const file = loadHistoryFile(base);
  if (!file) {
    return [];
  }

  const results: WorkEntry[] = [];
  for (const entries of Object.values(file.work)) {
    for (const entry of entries) {
      if (entry.phase === phase) {
        results.push(entry);
      }
    }
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}
