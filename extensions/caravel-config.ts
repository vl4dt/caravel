/**
 * Caravel Fleet Configuration Management
 *
 * Provides DEFAULT_CONFIG, getConfig(), updateConfig(), and initializeConfig()
 * for managing feature flags and thresholds.  Configuration is persisted to
 * `.caravel/config.json` relative to the project root.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Health-threshold settings for agent monitoring. */
export interface HealthThresholds {
  /** Time in seconds before a healthy agent is considered "stuck". */
  stuck: number;
  /** Time in seconds before a stuck agent is considered "zombie". */
  zombie: number;
  /** Interval in seconds between health-check pings. */
  healthInterval: number;
  /** Interval in seconds between checkpoint saves. */
  checkpointInterval: number;
}

/** Default-threshold overrides (used when no per-agent thresholds exist). */
export interface DefaultThresholds {
  healthThresholds?: HealthThresholds;
}

/** Top-level Caravel configuration. */
export interface CaravelConfig {
  /** Enable the identity module. */
  identity?: boolean;
  /** Enable the health-monitoring module. */
  health?: boolean;
  /** Enable the messaging module. */
  messaging?: boolean;
  /** Enable the seance (session-history) module. */
  seance?: boolean;
  /** Health-threshold overrides. */
  thresholds?: HealthThresholds;
  /** Default overrides applied when no per-agent thresholds exist. */
  defaults?: DefaultThresholds;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** All features disabled by default. */
export const DEFAULT_CONFIG: CaravelConfig = {
  identity: false,
  health: false,
  messaging: false,
  seance: false,
  thresholds: {
    stuck: 120,
    zombie: 300,
    healthInterval: 30,
    checkpointInterval: 60,
  },
  defaults: {
    healthThresholds: {
      stuck: 120,
      zombie: 300,
    },
  },
};

const CONFIG_FILE_NAME = "config.json";

// ── Module-level state ─────────────────────────────────────────────────────────

let currentConfig: CaravelConfig | null = null;

/** Reset the in-memory config (useful for tests). */
export function resetConfig(): void {
  currentConfig = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Resolve the path to `.caravel/config.json` relative to a base directory. */
function configFilePath(cwd?: string): string {
  const base = cwd || process.cwd();
  return path.join(base, ".caravel", CONFIG_FILE_NAME);
}

/** Load a persisted config from disk. Returns null when no file exists or is corrupt. */
function loadPersistedConfig(cwd?: string): CaravelConfig | null {
  const filePath = configFilePath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CaravelConfig;
    return parsed;
  } catch {
    return null;
  }
}

/** Deep-merge `partial` on top of `base` (shallow merge per level). */
function mergeConfig(base: CaravelConfig, partial: CaravelConfig): CaravelConfig {
  const merged: CaravelConfig = { ...base };

  // Boolean feature flags
  for (const key of ["identity", "health", "messaging", "seance"] as (keyof CaravelConfig)[]) {
    if (partial[key] !== undefined) {
      merged[key] = partial[key];
    }
  }

  // thresholds — deep merge
  if (partial.thresholds) {
    merged.thresholds = {
      ...merged.thresholds,
      ...partial.thresholds,
    };
  }

  // defaults → deep merge healthThresholds
  if (partial.defaults) {
    merged.defaults = {
      ...merged.defaults,
      ...(partial.defaults.healthThresholds
        ? { healthThresholds: { ...merged.defaults?.healthThresholds, ...partial.defaults.healthThresholds } }
        : {}),
    };
  }

  return merged;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Return the current configuration (in-memory).
 *
 * If the config has not been initialized in-memory but a persisted file
 * exists, it is loaded automatically (lazy load).
 */
export function getConfig(cwd?: string): CaravelConfig {
  if (currentConfig === null) {
    const persisted = loadPersistedConfig(cwd);
    if (persisted) {
      currentConfig = mergeConfig({ ...DEFAULT_CONFIG }, persisted);
    } else {
      currentConfig = { ...DEFAULT_CONFIG };
    }
  }
  return { ...currentConfig };
}

/**
 * Update the in-memory configuration with `partial` and persist to disk.
 *
 * Unset fields (undefined) are left at their current value.
 * Returns the merged configuration.
 */
export function updateConfig(partial: CaravelConfig, cwd?: string): CaravelConfig {
  if (currentConfig === null) {
    currentConfig = getConfig(cwd);
  }
  currentConfig = mergeConfig(currentConfig, partial);

  // Persist
  const filePath = configFilePath(cwd);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(currentConfig, null, 2), "utf-8");

  return { ...currentConfig };
}

/**
 * Initialize the in-memory config from the persisted file (or DEFAULT_CONFIG
 * if no file exists).
 *
 * Always replaces the in-memory state so it can be called repeatedly (idempotent).
 * If the persisted file is corrupt, falls back to DEFAULT_CONFIG without error.
 */
export function initializeConfig(cwd?: string): CaravelConfig {
  const persisted = loadPersistedConfig(cwd);
  if (persisted) {
    currentConfig = mergeConfig({ ...DEFAULT_CONFIG }, persisted);
  } else {
    currentConfig = { ...DEFAULT_CONFIG };
  }
  return { ...currentConfig };
}
