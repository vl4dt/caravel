/**
 * Tests for caravel-config (DEFAULT_CONFIG, getConfig, updateConfig,
 * initializeConfig, persistence).
 *
 * Run with:  npx tsx extensions/caravel-config.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_CONFIG,
  getConfig,
  updateConfig,
  initializeConfig,
  resetConfig,
  type CaravelConfig,
  type HealthThresholds,
} from "./caravel-config.js";
import {
  initializeFleetConfig,
  type FleetInitResult,
} from "./caravel-init.js";

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create a temporary directory with `.caravel` pre-created. */
function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-config-test-"));
  fs.mkdirSync(path.join(dir, ".caravel"), { recursive: true });
  return dir;
}

/** Clean up a test directory. */
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run a callback with the process cwd changed to `dir` so that all
 * relative `.caravel/` reads/writes target the test directory.
 * Resets in-memory config state before running the callback.
 */
function withCwd(dir: string, fn: () => void): void {
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    resetConfig();
    fn();
  } finally {
    process.chdir(origCwd);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n🧪 Testing caravel-config\n");

// ── 1. DEFAULT_CONFIG ─────────────────────────────────────────────────────────

console.log("1. DEFAULT_CONFIG structure:");
{
  assert(DEFAULT_CONFIG.identity === false, `identity defaults to false`);
  assert(DEFAULT_CONFIG.health === false, `health defaults to false`);
  assert(DEFAULT_CONFIG.messaging === false, `messaging defaults to false`);
  assert(DEFAULT_CONFIG.seance === false, `seance defaults to false`);
  assert(typeof DEFAULT_CONFIG.thresholds === "object", `thresholds is an object`);
  assert(
    DEFAULT_CONFIG.thresholds!.stuck === 120,
    `thresholds.stuck === 120`,
  );
  assert(
    DEFAULT_CONFIG.thresholds!.zombie === 300,
    `thresholds.zombie === 300`,
  );
  assert(
    DEFAULT_CONFIG.thresholds!.healthInterval === 30,
    `thresholds.healthInterval === 30`,
  );
  assert(
    DEFAULT_CONFIG.thresholds!.checkpointInterval === 60,
    `thresholds.checkpointInterval === 60`,
  );
  assert(typeof DEFAULT_CONFIG.defaults === "object", `defaults is an object`);
  assert(
    DEFAULT_CONFIG.defaults!.healthThresholds!.stuck === 120,
    `defaults.healthThresholds.stuck === 120`,
  );
  assert(
    DEFAULT_CONFIG.defaults!.healthThresholds!.zombie === 300,
    `defaults.healthThresholds.zombie === 300`,
  );
}

// ── 2. getConfig — fresh (no persisted file) ─────────────────────────────────

console.log("\n2. getConfig — fresh (no persisted file):");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      const config = getConfig();
      assert(config.identity === false, `identity is false`);
      assert(config.health === false, `health is false`);
      assert(config.messaging === false, `messaging is false`);
      assert(config.seance === false, `seance is false`);
      assert(config.thresholds !== undefined, `thresholds is present`);
      assert(config.defaults !== undefined, `defaults is present`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 3. getConfig — with persisted file ───────────────────────────────────────

console.log("\n3. getConfig — with persisted file:");
{
  const dir = createTestDir();
  try {
    // Write a partial config
    const persistPath = path.join(dir, ".caravel", "config.json");
    const partialConfig: CaravelConfig = {
      identity: true,
      health: true,
      thresholds: {
        stuck: 200,
      },
    };
    fs.writeFileSync(persistPath, JSON.stringify(partialConfig, null, 2), "utf-8");

    withCwd(dir, () => {
      const config = getConfig();
      assert(config.identity === true, `identity loaded from file (true)`);
      assert(config.health === true, `health loaded from file (true)`);
      assert(config.messaging === false, `messaging still false (not in file)`);
      assert(config.thresholds!.stuck === 200, `thresholds.stuck merged to 200`);
      assert(
        config.thresholds!.zombie === 300,
        `thresholds.zombie kept default (300)`,
      );
    });
  } finally {
    cleanup(dir);
  }
}

// ── 4. getConfig — corrupt file falls back to DEFAULT_CONFIG ────────────────

console.log("\n4. getConfig — corrupt file falls back:");
{
  const dir = createTestDir();
  try {
    const persistPath = path.join(dir, ".caravel", "config.json");
    fs.writeFileSync(persistPath, "{ this is not valid json", "utf-8");

    withCwd(dir, () => {
      const config = getConfig();
      assert(config.identity === false, `identity is false (fallback)`);
      assert(config.thresholds!.stuck === 120, `thresholds.stuck is default (120)`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 5. updateConfig — merge booleans ────────────────────────────────────────

console.log("\n5. updateConfig — merge booleans:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      updateConfig({ identity: true });
      let config = getConfig();
      assert(config.identity === true, `identity updated to true`);
      assert(config.health === false, `health still false`);

      updateConfig({ health: true, messaging: true });
      config = getConfig();
      assert(config.identity === true, `identity preserved as true`);
      assert(config.health === true, `health updated to true`);
      assert(config.messaging === true, `messaging updated to true`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 6. updateConfig — merge thresholds ──────────────────────────────────────

console.log("\n6. updateConfig — merge thresholds:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      updateConfig({
        thresholds: { stuck: 180, zombie: 400 },
      });
      const config = getConfig();
      assert(config.thresholds!.stuck === 180, `stuck merged to 180`);
      assert(config.thresholds!.zombie === 400, `zombie merged to 400`);
      assert(
        config.thresholds!.healthInterval === 30,
        `healthInterval unchanged (30)`,
      );
      assert(
        config.thresholds!.checkpointInterval === 60,
        `checkpointInterval unchanged (60)`,
      );
    });
  } finally {
    cleanup(dir);
  }
}

// ── 7. updateConfig — merge defaults ────────────────────────────────────────

console.log("\n7. updateConfig — merge defaults:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      updateConfig({
        defaults: {
          healthThresholds: { stuck: 200, zombie: 500 },
        },
      });
      const config = getConfig();
      assert(
        config.defaults!.healthThresholds!.stuck === 200,
        `defaults.healthThresholds.stuck merged to 200`,
      );
      assert(
        config.defaults!.healthThresholds!.zombie === 500,
        `defaults.healthThresholds.zombie merged to 500`,
      );
    });
  } finally {
    cleanup(dir);
  }
}

// ── 8. Persistence — file written to disk ────────────────────────────────────

console.log("\n8. Persistence — file written to disk:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      updateConfig({
        identity: true,
        health: true,
        thresholds: { stuck: 150 },
      });
      const persistPath = path.join(dir, ".caravel", "config.json");
      assert(
        fs.existsSync(persistPath),
        `config.json exists on disk`,
      );
      const raw = fs.readFileSync(persistPath, "utf-8");
      const parsed = JSON.parse(raw) as CaravelConfig;
      assert(parsed.identity === true, `identity persisted as true`);
      assert(parsed.health === true, `health persisted as true`);
      assert(parsed.thresholds!.stuck === 150, `stuck persisted as 150`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 9. Persistence — persisted values survive process restart (new getConfig) ─

console.log("\n9. Persistence — survives reload from disk:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      // Simulate: write config
      updateConfig({
        identity: true,
        thresholds: { zombie: 450 },
      });
    });

    // "Restart" — use initializeConfig to re-read from disk (simulates fresh process)
    const config = initializeConfig(dir);
    assert(config.identity === true, `identity reloaded from disk (true)`);
    assert(config.thresholds!.zombie === 450, `zombie reloaded as 450`);
    assert(config.identity === true, `identity reloaded from disk (true)`);
    assert(config.thresholds!.zombie === 450, `zombie reloaded as 450`);
  } finally {
    cleanup(dir);
  }
}

// ── 10. initializeConfig — idempotent ───────────────────────────────────────

console.log("\n10. initializeConfig — idempotent:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      // First call — no persisted file → defaults
      let config = initializeConfig();
      assert(config.identity === false, `1st call: identity false`);

      // Write a file
      const persistPath = path.join(dir, ".caravel", "config.json");
      fs.writeFileSync(
        persistPath,
        JSON.stringify({ identity: true, health: true }, null, 2),
        "utf-8",
      );

      // Second call — should re-read from disk (same result)
      config = initializeConfig();
      assert(config.identity === true, `2nd call: identity true from file`);
      assert(config.health === true, `2nd call: health true from file`);

      // Third call — should be identical
      const config3 = initializeConfig();
      assert(config3.identity === true, `3rd call: identity still true`);
      assert(config3.health === true, `3rd call: health still true`);

      // Values must be equal, not just truthy
      assert(
        JSON.stringify(config) === JSON.stringify(config3),
        `configs equal after repeated init`,
      );
    });
  } finally {
    cleanup(dir);
  }
}

// ── 11. initializeConfig — no file → defaults ───────────────────────────────

console.log("\n11. initializeConfig — no file → defaults:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      // Ensure no config file exists
      assert(!fs.existsSync(path.join(dir, ".caravel", "config.json")), `no config file`);
      const config = initializeConfig();
      assert(config.identity === false, `identity is false`);
      assert(config.health === false, `health is false`);
      assert(config.messaging === false, `messaging is false`);
      assert(config.seance === false, `seance is false`);
      assert(config.thresholds!.stuck === 120, `stuck is 120`);
      assert(config.thresholds!.zombie === 300, `zombie is 300`);
      assert(config.thresholds!.healthInterval === 30, `healthInterval is 30`);
      assert(config.thresholds!.checkpointInterval === 60, `checkpointInterval is 60`);
      assert(config.defaults!.healthThresholds!.stuck === 120, `defaults stuck 120`);
      assert(config.defaults!.healthThresholds!.zombie === 300, `defaults zombie 300`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 12. getConfig returns a copy (no mutation leak) ─────────────────────────

console.log("\n12. getConfig returns a defensive copy:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      const config1 = getConfig();
      (config1 as any).identity = true; // mutate the returned object
      const config2 = getConfig();
      assert(config2.identity === false, `mutation didn't leak — identity still false`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 13. updateConfig persists booleans to disk ──────────────────────────────

console.log("\n13. updateConfig persists booleans to disk:");
{
  const dir = createTestDir();
  try {
    withCwd(dir, () => {
      updateConfig({ messaging: true, seance: true });
      const persistPath = path.join(dir, ".caravel", "config.json");
      const raw = fs.readFileSync(persistPath, "utf-8");
      const parsed = JSON.parse(raw) as CaravelConfig;
      assert(parsed.messaging === true, `messaging persisted true`);
      assert(parsed.seance === true, `seance persisted true`);
    });
  } finally {
    cleanup(dir);
  }
}

// ── 14. initializeFleetConfig — creates .caravel/ and files ──────────────────

console.log("\n14. initializeFleetConfig — creates .caravel/ and files:");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-init-test-"));
  try {
    const result = initializeFleetConfig(dir);

    assert(result.created === true, `created is true on first call`);
    assert(Array.isArray(result.files), `files is an array`);
    assert(result.files.length >= 7, `files has >= 7 entries (dir + 5 files + checkpoints)`);

    // Directory exists
    assert(
      fs.existsSync(path.join(dir, ".caravel")),
      `.caravel directory exists`,
    );

    // All feature files exist and are valid JSON
    const featureFiles = ["agents.json", "history.json", "health.json", "messages.json", "seances.json"];
    for (const f of featureFiles) {
      const fpath = path.join(dir, ".caravel", f);
      assert(fs.existsSync(fpath), `${f} exists`);
      const content = fs.readFileSync(fpath, "utf-8");
      const parsed = JSON.parse(content);
      assert(
        typeof parsed === "object" && Object.keys(parsed).length === 0,
        `${f} is empty {}`,
      );
    }

    // Checkpoints directory exists
    assert(
      fs.existsSync(path.join(dir, ".caravel", "checkpoints")),
      `checkpoints directory exists`,
    );

    // files list includes all expected paths
    const filePaths = result.files.map((f) => f);
    for (const f of featureFiles) {
      const expected = path.join(dir, ".caravel", f);
      assert(
        filePaths.includes(expected),
        `files list includes ${f}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 15. initializeFleetConfig — idempotent (second call: created = false) ────

console.log("\n15. initializeFleetConfig — idempotent (second call):");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-init-test-"));
  try {
    // First call
    const r1 = initializeFleetConfig(dir);
    assert(r1.created === true, `1st call: created is true`);
    const filesAfter1 = r1.files;

    // Second call
    const r2 = initializeFleetConfig(dir);
    assert(r2.created === false, `2nd call: created is false (idempotent)`);

    // File counts unchanged
    assert(
      r2.files.length === filesAfter1.length,
      `same number of files after 2nd call`,
    );

    // Same files are reported
    const paths1 = filesAfter1.sort();
    const paths2 = r2.files.sort();
    for (let i = 0; i < paths1.length; i++) {
      assert(
        paths1[i] === paths2[i],
        `files[${i}] unchanged`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 16. initializeFleetConfig — returns created files list ──────────────────

console.log("\n16. initializeFleetConfig — returns created files list:");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-init-test-"));
  try {
    const result = initializeFleetConfig(dir);

    assert(
      result.created === true,
      `created is true`,
    );
    assert(
      Array.isArray(result.files),
      `files is an array`,
    );
    assert(
      result.files.length >= 7,
      `files list has >= 7 entries (dir + 5 files + checkpoints)`,
    );

    // Verify each file path is absolute
    for (const f of result.files) {
      assert(
        path.isAbsolute(f),
        `${f} is absolute`,
      );
    }

    // Verify all files/dirs actually exist on disk
    for (const f of result.files) {
      assert(
        fs.existsSync(f),
        `${f} exists on disk`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 17. initializeFleetConfig — partial pre-existing .caravel/ ──────────────

console.log("\n17. initializeFleetConfig — partial pre-existing .caravel/:");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-init-test-"));
  try {
    // Pre-create .caravel/ with only agents.json
    const caravelDir = path.join(dir, ".caravel");
    fs.mkdirSync(caravelDir, { recursive: true });
    fs.writeFileSync(path.join(caravelDir, "agents.json"), "{}", "utf-8");

    // Also pre-create checkpoints (should not overwrite)
    fs.mkdirSync(path.join(caravelDir, "checkpoints"), { recursive: true });

    const result = initializeFleetConfig(dir);

    // Should still report created=false because .caravel/ already existed
    assert(
      result.created === false,
      `created is false (dir already existed)`,
    );

    // All feature files should now exist
    const featureFiles = ["agents.json", "history.json", "health.json", "messages.json", "seances.json"];
    for (const f of featureFiles) {
      const fpath = path.join(caravelDir, f);
      assert(
        fs.existsSync(fpath),
        `${f} exists after init`,
      );
    }

    // agents.json should still be the original (not clobbered)
    const agentsContent = fs.readFileSync(path.join(caravelDir, "agents.json"), "utf-8");
    assert(agentsContent === "{}", `agents.json preserved as {}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${"=".repeat(50)}`);
console.log(`Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""}`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  console.error("\nFailed tests:");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}
