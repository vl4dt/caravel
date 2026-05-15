/**
 * Caravel Fleet Initialization
 *
 * Provides `initializeFleetConfig()` to create and populate the `.caravel/`
 * directory structure with all required feature files.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Result of a fleet-initialization call. */
export interface FleetInitResult {
  /** Whether the `.caravel/` directory was newly created (true) or already existed (false). */
  created: boolean;
  /** Absolute paths to all files and directories that exist (or were ensured) by the call. */
  files: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Relative paths of feature config files to create inside `.caravel/`. */
const FEATURE_FILES = [
  "agents.json",
  "history.json",
  "health.json",
  "messages.json",
  "seances.json",
];

/** Relative path of the checkpoints directory to create inside `.caravel/`. */
const CHECKPOINTS_DIR = "checkpoints";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Resolve the `.caravel/` directory path relative to a base directory. */
function caravelDir(cwd?: string): string {
  const base = cwd || process.cwd();
  return path.join(base, ".caravel");
}

/**
 * Create (or ensure) the `.caravel/` directory and all required feature files.
 *
 * - If `.caravel/` does not exist, it is created and `created` is `true`.
 * - If `.caravel/` already exists, `created` is `false` (idempotent).
 * - All feature files are created as empty JSON objects (`{}`) if missing.
 * - The `checkpoints/` subdirectory is ensured if missing.
 */
export function initializeFleetConfig(cwd?: string): FleetInitResult {
  const dir = caravelDir(cwd);
  const existing = fs.existsSync(dir);

  // Ensure the base directory exists
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [dir];

  // Create / ensure each feature file (empty JSON object)
  for (const fname of FEATURE_FILES) {
    const fpath = path.join(dir, fname);
    if (!fs.existsSync(fpath)) {
      fs.writeFileSync(fpath, "{}", "utf-8");
    }
    files.push(fpath);
  }

  // Ensure checkpoints directory
  const checkpointsPath = path.join(dir, CHECKPOINTS_DIR);
  fs.mkdirSync(checkpointsPath, { recursive: true });
  files.push(checkpointsPath);

  return {
    created: !existing,
    files,
  };
}
