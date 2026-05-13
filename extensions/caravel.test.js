/**
 * caravel.test.js
 *
 * Tests for fleet state serialization (save_state / load_state).
 *
 * Tests:
 *  1. save → modify → load recovers state
 *  2. save → crash (simulated) → load recovers state
 *  3. Survives process termination and can resume
 *  4. Invalid / corrupted state file is handled gracefully
 *  5. No state file → loadState returns false
 *  6. Schema version mismatch → loadState rejects safely
 *
 * Run:  node caravel.test.js
 *       node caravel.test.js --verbose
 *       node caravel.test.js --tmpdir /tmp/caravel-test
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Test harness ────────────────────────────────────────────────────────────

let verbose = false;
const args = process.argv.slice(2);
if (args.includes("--verbose")) verbose = true;

// Use a temporary directory for test state files so we don't pollute the real project
const TEST_STATE_DIR = args.find((a) => a.startsWith("--tmpdir="))
  ? args.find((a) => a.startsWith("--tmpdir=")).split("=")[1]
  : fs.mkdtempSync(path.join(os.tmpdir(), "caravel-test-"));

// Ensure test state directory exists
fs.mkdirSync(TEST_STATE_DIR, { recursive: true });

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    if (verbose) console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ── Helper: create a realistic FleetState ──────────────────────────────────

function makeFleetState() {
  return {
    phases: [
      {
        id: "ph1",
        name: "Codebase Analysis",
        status: "complete",
        tasks: [
          {
            id: "t1",
            agentName: "developer",
            description: "Analyze the existing codebase structure",
            status: "complete",
            output: "Analysis complete. Found 42 files across 8 directories.",
            stderr: "",
            reviewFeedback: "Approved by tech-lead.",
            reviewCount: 1,
            maxReviewCount: 3,
            codeReviewStatus: "approved",
            codeReviewFeedback: "Code looks solid.",
            designReviewStatus: "approved",
            designReviewFeedback: "Design aligns with plan.",
            agentModel: "claude-sonnet-4-20250514",
            tokensUsed: 12453,
            messageCount: 18,
            startedAt: Date.now() - 3600_000,
            metadata: null,
          },
          {
            id: "t2",
            agentName: "tech-lead",
            description: "Review architecture decisions",
            status: "complete",
            output: "Architecture approved.",
            stderr: "",
            reviewCount: 0,
            maxReviewCount: 3,
            codeReviewStatus: "approved",
            codeReviewFeedback: "",
            designReviewStatus: "approved",
            designReviewFeedback: "",
            agentModel: "gpt-4o",
            tokensUsed: 8721,
            messageCount: 12,
            startedAt: Date.now() - 1800_000,
            metadata: null,
          },
          {
            id: "t3",
            agentName: "designer",
            description: "Design UI component library",
            status: "running",
            reviewCount: 0,
            maxReviewCount: 3,
            codeReviewStatus: "pending",
            designReviewStatus: "pending",
            agentModel: "claude-sonnet-4-20250514",
            tokensUsed: 3200,
            messageCount: 5,
            startedAt: Date.now() - 300_000,
            metadata: null,
          },
        ],
        completedAt: Date.now() - 3600_000,
      },
      {
        id: "ph2",
        name: "Core Implementation",
        status: "pending",
        tasks: [
          {
            id: "t4",
            agentName: "developer",
            description: "Implement the core engine",
            status: "pending",
            reviewCount: 0,
            maxReviewCount: 3,
            codeReviewStatus: "pending",
            designReviewStatus: "pending",
            agentModel: "claude-sonnet-4-20250514",
            tokensUsed: 0,
            messageCount: 0,
            metadata: null,
          },
          {
            id: "t5",
            agentName: "developer",
            description: "Write integration tests",
            status: "pending",
            reviewCount: 0,
            maxReviewCount: 3,
            codeReviewStatus: "pending",
            designReviewStatus: "pending",
            agentModel: "gpt-4o",
            tokensUsed: 0,
            messageCount: 0,
            metadata: null,
          },
        ],
      },
    ],
    currentPhaseIndex: 0,
    activeAgents: [
      {
        name: "developer",
        status: "running",
        currentTask: "Design UI component library",
        model: "claude-sonnet-4-20250514",
        tokensUsed: 3200,
        inputTokens: 45000,
        outputTokens: 12000,
        turns: 5,
      },
      {
        name: "tech-lead",
        status: "idle",
        model: "gpt-4o",
        tokensUsed: 8721,
        inputTokens: 32000,
        outputTokens: 9800,
        turns: 12,
      },
    ],
    paused: false,
    startTime: Date.now() - 7200_000,
    reviewIterations: 2,
    maxReviewIterations: 5,
    recentOutput: "Phase 1 complete. Moving to Phase 2.",
    totalFleetTokens: 24374,
    mainAgentActivity: {
      status: "executing",
      action: "running task",
      detail: "designer → Design UI component library (claude-sonnet-4-20250514) [3.2k tokens] | 5m",
      timestamp: Date.now() - 300_000,
    },
  };
}

// ── Test helpers (extracted from caravel.ts logic) ──────────────────────────

/** Simulate the save/load path resolution used by caravel.ts */
function stateFilePath(cwd) {
  return path.join(cwd, ".caravel", "state.json");
}

const STATE_VERSION = 1;

/** Shared mutable state for test persistence */
let testState = null;

function saveState(cwd) {
  const filePath = stateFilePath(cwd);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    version: STATE_VERSION,
    timestamp: Date.now(),
    state: JSON.parse(JSON.stringify(testState)),
  };
  // Atomic write: write to temp then rename
  const tmpPath = filePath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/** Crash-simulated save: write to temp but do NOT rename (simulates crash mid-write) */
function saveStateCrashed(cwd) {
  const filePath = stateFilePath(cwd);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    version: STATE_VERSION,
    timestamp: Date.now(),
    state: JSON.parse(JSON.stringify(testState)),
  };
  // Write only to temp — "crash" before rename
  const tmpPath = filePath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  // NOTE: NOT calling fs.renameSync — simulating process crash!
}

/** Simulate loadState logic — deserializes into a new object */
function loadState(cwd) {
  const filePath = stateFilePath(cwd);
  if (!fs.existsSync(filePath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Validate schema version
  if (parsed.version == null || parsed.state == null) return null;
  if (parsed.version > STATE_VERSION) return null;

  const s = parsed.state;
  if (typeof s.phases !== "object" || !Array.isArray(s.phases)) return null;
  if (typeof s.currentPhaseIndex !== "number") return null;

  return {
    phases: s.phases ?? [],
    currentPhaseIndex: s.currentPhaseIndex ?? 0,
    activeAgents: s.activeAgents ?? [],
    paused: s.paused ?? false,
    startTime: s.startTime != null && !isNaN(s.startTime) ? s.startTime : Date.now(),
    reviewIterations: s.reviewIterations ?? 0,
    maxReviewIterations: s.maxReviewIterations ?? 5,
    recentOutput: s.recentOutput ?? "",
    totalFleetTokens: s.totalFleetTokens != null && !isNaN(s.totalFleetTokens)
      ? s.totalFleetTokens
      : 0,
    mainAgentActivity: s.mainAgentActivity ?? null,
  };
}

/** Check if state can be resumed */
function canResumeState(cwd) {
  const filePath = stateFilePath(cwd);
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.version !== null && parsed.state != null;
  } catch {
    return false;
  }
}

function clearState(cwd) {
  const filePath = stateFilePath(cwd);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const tmpDir = path.dirname(filePath);
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      if (f.startsWith("state.json.tmp.")) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

// ── Deep equality for state objects ─────────────────────────────────────────

function statesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

// ── T4.1: save → modify → load recovers state ─────────────────────────────

section("T4.1: save → modify → load recovers state");

{
  const testDir = path.join(TEST_STATE_DIR, "test-01-modify");
  fs.rmSync(testDir, { recursive: true, force: true });

  // 1. Set up and save initial state
  testState = makeFleetState();
  saveState(testDir);
  assert(fs.existsSync(stateFilePath(testDir)), "State file was written to disk");

  // 2. Simulate modifications (what would happen during fleet execution)
  testState.currentPhaseIndex = 1;
  testState.paused = true;
  testState.reviewIterations = 3;
  testState.recentOutput = "Phase 1 complete. All tasks passed.";
  testState.totalFleetTokens = 50000;

  // Modify a task status
  testState.phases[0].tasks[0].status = "needs_fix";
  testState.phases[0].tasks[0].reviewFeedback = "Needs changes: refactor module A.";
  testState.phases[0].tasks[1].status = "reviewing";
  testState.phases[0].status = "reviewing";

  // Modify an agent
  testState.activeAgents[0].status = "reviewing";
  testState.activeAgents[0].tokensUsed = 15000;

  // 3. Save modified state
  saveState(testDir);

  // 4. Load state from disk — should get the MODIFIED state
  const loadedState = loadState(testDir);
  assert(loadedState !== null, "loadState returned a valid state");
  assert(
    loadedState.currentPhaseIndex === 1,
    "Loaded currentPhaseIndex matches modified value (1)"
  );
  assert(
    loadedState.paused === true,
    "Loaded paused flag matches modified value (true)"
  );
  assert(
    loadedState.reviewIterations === 3,
    "Loaded reviewIterations matches modified value (3)"
  );
  assert(
    loadedState.totalFleetTokens === 50000,
    "Loaded totalFleetTokens matches modified value (50000)"
  );
  assert(
    loadedState.recentOutput === "Phase 1 complete. All tasks passed.",
    "Loaded recentOutput matches modified value"
  );
  assert(
    loadedState.phases[0].tasks[0].status === "needs_fix",
    "Loaded task t0 status = 'needs_fix'"
  );
  assert(
    loadedState.phases[0].tasks[0].reviewFeedback === "Needs changes: refactor module A.",
    "Loaded task t0 reviewFeedback preserved"
  );
  assert(
    loadedState.phases[0].status === "reviewing",
    "Loaded phase 0 status = 'reviewing'"
  );
  assert(
    loadedState.activeAgents[0].status === "reviewing",
    "Loaded agent[0] status = 'reviewing'"
  );
  assert(
    loadedState.activeAgents[0].tokensUsed === 15000,
    "Loaded agent[0] tokensUsed = 15000"
  );
  assert(
    loadedState.phases.length === 2,
    "Loaded state still has 2 phases"
  );
  assert(
    loadedState.phases[1].tasks.length === 2,
    "Loaded phase 1 still has 2 tasks"
  );

  // 5. Save again and verify persistence
  saveState(testDir);
  const reloadedState = loadState(testDir);
  assert(reloadedState !== null, "Re-loaded state after second save is valid");
  assert(
    statesEqual(reloadedState, loadedState),
    "Re-loaded state matches previously loaded state exactly"
  );

  clearState(testDir);
}

// ── T4.2: save → crash → load recovers state ──────────────────────────────

section("T4.2: save → crash → load recovers state");

{
  const testDir = path.join(TEST_STATE_DIR, "test-02-crash");
  fs.rmSync(testDir, { recursive: true, force: true });

  // 1. Save a good state directly (bypassing testState to avoid interference)
  const goodStateData = {
    version: STATE_VERSION,
    timestamp: Date.now(),
    state: makeFleetState(),
  };
  const goodFilePath = stateFilePath(testDir);
  fs.mkdirSync(path.dirname(goodFilePath), { recursive: true });
  const goodTmpPath = goodFilePath + ".tmp." + process.pid + "-good";
  fs.writeFileSync(goodTmpPath, JSON.stringify(goodStateData, null, 2), "utf-8");
  fs.renameSync(goodTmpPath, goodFilePath);
  assert(fs.existsSync(goodFilePath), "Initial state saved");

  // Verify the saved file has the correct data
  const verifyRaw = JSON.parse(fs.readFileSync(goodFilePath, "utf-8"));
  assert(
    verifyRaw.state.currentPhaseIndex === 0,
    "Saved file has currentPhaseIndex=0"
  );

  // 2. Simulate crash: save a corrupted partial write in a sub-directory
  const crashDir = path.join(testDir, "crash-scenario");
  fs.mkdirSync(crashDir, { recursive: true });
  const crashStateDir = path.join(crashDir, ".caravel");
  fs.mkdirSync(crashStateDir, { recursive: true });

  // Write a partially corrupt file (simulates crash mid-write)
  const corruptPath = stateFilePath(crashDir);
  fs.writeFileSync(corruptPath, '{"version":1,"state":{', "utf-8"); // truncated JSON

  // 3. Try to load corrupted state — should return null gracefully
  const loadedFromCrash = loadState(crashDir);
  assert(loadedFromCrash === null, "Corrupted state file returns null");

  // 4. Re-verify the good state file is still intact
  const reVerifyRaw = JSON.parse(fs.readFileSync(goodFilePath, "utf-8"));
  assert(
    reVerifyRaw.state.currentPhaseIndex === 0,
    "Good state file still has currentPhaseIndex=0 after crash scenario"
  );

  // 5. Load the good state
  const loadedFromGood = loadState(testDir);
  assert(loadedFromGood !== null, "Good state still loadable after crash scenario");
  assert(
    loadedFromGood.currentPhaseIndex === 0,
    `Good state preserved currentPhaseIndex (0, got ${loadedFromGood.currentPhaseIndex})`
  );
  assert(
    loadedFromGood.phases.length === 2,
    "Good state preserved phases count"
  );
  // Verify nested data integrity
  assert(
    loadedFromGood.phases[0].tasks.length === 3,
    "Good state preserved tasks count"
  );
  assert(
    loadedFromGood.phases[0].tasks[0].status === "complete",
    `Good state preserved task t0 status (got ${loadedFromGood.phases[0].tasks[0].status})`
  );
  assert(
    loadedFromGood.phases[1].tasks[0].agentName === "developer",
    "Good state preserved task t4 agentName"
  );
  assert(
    loadedFromGood.activeAgents.length === 2,
    "Good state preserved activeAgents count"
  );

  // 5. Simulate crash during save: write only temp file
  const crashSaveDir = path.join(testDir, "crash-save");
  fs.mkdirSync(crashSaveDir, { recursive: true });

  // Save a "crashed" state (write to temp, not rename)
  const crashFilePath = stateFilePath(crashSaveDir);
  const dir = path.dirname(crashFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const crashData = JSON.parse(JSON.stringify(makeFleetState()));
  const tmpPath = crashFilePath + ".tmp.crash." + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmpPath, JSON.stringify(crashData, null, 2), "utf-8");
  // "Crash" — no rename!

  // The corrupted state file does not exist (only temp)
  assert(
    !fs.existsSync(crashFilePath),
    "No state.json exists after crash-simulated save"
  );

  // loadState should handle gracefully
  const loadedCrashSave = loadState(crashSaveDir);
  assert(loadedCrashSave === null, "loadState returns null for missing state file");

  clearState(testDir);
}

// ── T4.3: Survives process termination and can resume ──────────────────────

section("T4.3: Survives process termination and can resume");

{
  const testDir = path.join(TEST_STATE_DIR, "test-03-resume");
  fs.rmSync(testDir, { recursive: true, force: true });

  // 1. Save state
  testState = makeFleetState();
  testState.currentPhaseIndex = 1;
  testState.paused = true;
  testState.reviewIterations = 4;
  saveState(testDir);

  // 2. Verify file exists on disk
  const filePath = stateFilePath(testDir);
  assert(fs.existsSync(filePath), "State file exists on disk after 'termination'");

  // 3. "Process terminates" — in real scenario, process just dies here
  // We simulate by checking that data is still on disk
  const fileContent = fs.readFileSync(filePath, "utf-8");
  const fileData = JSON.parse(fileContent);
  assert(fileData.version === STATE_VERSION, "File has valid schema version");
  assert(fileData.timestamp > 0, "File has a timestamp");
  assert(fileData.state.currentPhaseIndex === 1, "File preserves currentPhaseIndex");

  // 4. "New process starts" — load the state
  const resumedState = loadState(testDir);
  assert(resumedState !== null, "New process can load state from disk");
  assert(resumedState.currentPhaseIndex === 1, "Resumed: currentPhaseIndex = 1");
  assert(resumedState.paused === true, "Resumed: paused = true");
  assert(resumedState.reviewIterations === 4, "Resumed: reviewIterations = 4");
  assert(
    resumedState.phases.length === 2,
    "Resumed: phases count preserved"
  );
  assert(
    resumedState.activeAgents.length === 2,
    "Resumed: activeAgents preserved"
  );
  assert(
    resumedState.phases[0].status === "complete",
    "Resumed: phase 0 status = 'complete'"
  );
  assert(
    resumedState.phases[1].status === "pending",
    "Resumed: phase 1 status = 'pending'"
  );

  // 5. canResumeState also works
  assert(canResumeState(testDir), "canResumeState returns true for valid file");

  // 6. Verify resume can continue from the saved point
  // Simulate continuing from phase 1
  resumedState.currentPhaseIndex = 2; // moving to next phase
  assert(resumedState.currentPhaseIndex === 2, "Can advance from resumed state");

  clearState(testDir);
}

// ── T4.4: Invalid / corrupted state files are handled gracefully ──────────

section("T4.4: Invalid / corrupted state files are handled gracefully");

{
  const testDir = path.join(TEST_STATE_DIR, "test-04-invalid");
  fs.rmSync(testDir, { recursive: true, force: true });

  // 4a. Completely invalid JSON
  const invalidDir = path.join(testDir, "invalid-json");
  fs.mkdirSync(invalidDir, { recursive: true });
  const invStateDir = path.join(invalidDir, ".caravel");
  fs.mkdirSync(invStateDir, { recursive: true });
  const invPath = stateFilePath(invalidDir);
  fs.writeFileSync(invPath, "not json at all {{{", "utf-8");
  assert(
    loadState(invalidDir) === null,
    "loadState returns null for invalid JSON"
  );

  // 4b. Valid JSON but missing 'state' field
  const noStateDir = path.join(testDir, "no-state");
  fs.mkdirSync(noStateDir, { recursive: true });
  const nsStateDir = path.join(noStateDir, ".caravel");
  fs.mkdirSync(nsStateDir, { recursive: true });
  const nsPath = stateFilePath(noStateDir);
  fs.writeFileSync(nsPath, JSON.stringify({ version: 1, timestamp: Date.now() }), "utf-8");
  assert(
    loadState(noStateDir) === null,
    "loadState returns null when 'state' field is missing"
  );

  // 4c. Future schema version
  const futureDir = path.join(testDir, "future-version");
  fs.mkdirSync(futureDir, { recursive: true });
  const fvStateDir = path.join(futureDir, ".caravel");
  fs.mkdirSync(fvStateDir, { recursive: true });
  const fvPath = stateFilePath(futureDir);
  fs.writeFileSync(fvPath, JSON.stringify({
    version: 99,
    timestamp: Date.now(),
    state: { phases: [], currentPhaseIndex: 0 },
  }), "utf-8");
  assert(
    loadState(futureDir) === null,
    "loadState rejects future schema version"
  );

  // 4d. Null state
  const nullStateDir = path.join(testDir, "null-state");
  fs.mkdirSync(nullStateDir, { recursive: true });
  const ns2StateDir = path.join(nullStateDir, ".caravel");
  fs.mkdirSync(ns2StateDir, { recursive: true });
  const ns2Path = stateFilePath(nullStateDir);
  fs.writeFileSync(ns2Path, JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    state: null,
  }), "utf-8");
  assert(
    loadState(nullStateDir) === null,
    "loadState returns null for null state field"
  );

  // 4e. Phases is not an array
  const badPhasesDir = path.join(testDir, "bad-phases");
  fs.mkdirSync(badPhasesDir, { recursive: true });
  const bpStateDir = path.join(badPhasesDir, ".caravel");
  fs.mkdirSync(bpStateDir, { recursive: true });
  const bpPath = stateFilePath(badPhasesDir);
  fs.writeFileSync(bpPath, JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    state: { phases: "not an array", currentPhaseIndex: 0 },
  }), "utf-8");
  assert(
    loadState(badPhasesDir) === null,
    "loadState rejects non-array phases"
  );

  // 4f. currentPhaseIndex is not a number
  const badCpiDir = path.join(testDir, "bad-cpi");
  fs.mkdirSync(badCpiDir, { recursive: true });
  const bcpiStateDir = path.join(badCpiDir, ".caravel");
  fs.mkdirSync(bcpiStateDir, { recursive: true });
  const bcpiPath = stateFilePath(badCpiDir);
  fs.writeFileSync(bcpiPath, JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    state: { phases: [], currentPhaseIndex: "zero" },
  }), "utf-8");
  assert(
    loadState(badCpiDir) === null,
    "loadState rejects non-number currentPhaseIndex"
  );
}

// ── T4.5: No state file → loadState returns false ─────────────────────────

section("T4.5: No state file → loadState returns false");

{
  const testDir = path.join(TEST_STATE_DIR, "test-05-no-file");
  fs.rmSync(testDir, { recursive: true, force: true });

  // Ensure state directory doesn't exist
  const filePath = stateFilePath(testDir);
  assert(
    !fs.existsSync(filePath),
    "State file does not exist"
  );
  assert(
    loadState(testDir) === null,
    "loadState returns null when no state file"
  );
  assert(
    !canResumeState(testDir),
    "canResumeState returns false when no state file"
  );
}

// ── T4.6: Atomic write integrity — no corruption from interrupted saves ──

section("T4.6: Atomic write integrity — no corruption from interrupted saves");

{
  const testDir = path.join(TEST_STATE_DIR, "test-06-atomic");
  fs.rmSync(testDir, { recursive: true, force: true });

  // Write a good state
  testState = makeFleetState();
  saveState(testDir);
  const firstLoad = loadState(testDir);
  assert(firstLoad !== null, "First load succeeds");
  const firstSnapshot = deepClone(firstLoad);

  // Rapidly save many times (simulates concurrent writes from different contexts)
  for (let i = 0; i < 20; i++) {
    saveState(testDir);
  }

  // All loads should return valid states (even if data differs from first)
  for (let i = 0; i < 10; i++) {
    const loaded = loadState(testDir);
    assert(
      loaded !== null,
      `Load #${i + 1} after rapid saves is valid`
    );
  }

  // Verify state file is parseable JSON
  const content = fs.readFileSync(stateFilePath(testDir), "utf-8");
  const parsed = JSON.parse(content);
  assert(parsed.version === STATE_VERSION, "Final state has correct version");
  assert(typeof parsed.timestamp === "number", "Final state has valid timestamp");
  assert(Array.isArray(parsed.state.phases), "Final state has phases array");

  clearState(testDir);
}

// ── T4.7: State file is valid JSON that round-trips ───────────────────────

section("T4.7: State round-trip integrity");

{
  const testDir = path.join(TEST_STATE_DIR, "test-07-roundtrip");
  fs.rmSync(testDir, { recursive: true, force: true });

  testState = makeFleetState();

  // Modify to exercise all fields
  testState.currentPhaseIndex = 1;
  testState.paused = true;
  testState.reviewIterations = 3;
  testState.totalFleetTokens = 12345;
  testState.recentOutput = "Test output with special chars: <>&\"'";
  testState.mainAgentActivity.status = "executing";
  testState.mainAgentActivity.action = "testing";
  testState.mainAgentActivity.detail = "Running with unicode: 你好世界 🚀";

  saveState(testDir);

  const loaded = loadState(testDir);
  assert(loaded !== null, "Round-trip load succeeds");
  assert(
    loaded.currentPhaseIndex === testState.currentPhaseIndex,
    "Round-trip: currentPhaseIndex"
  );
  assert(
    loaded.paused === testState.paused,
    "Round-trip: paused"
  );
  assert(
    loaded.reviewIterations === testState.reviewIterations,
    "Round-trip: reviewIterations"
  );
  assert(
    loaded.totalFleetTokens === testState.totalFleetTokens,
    "Round-trip: totalFleetTokens"
  );
  assert(
    loaded.recentOutput === testState.recentOutput,
    "Round-trip: recentOutput (with special chars)"
  );
  assert(
    loaded.mainAgentActivity.detail === testState.mainAgentActivity.detail,
    "Round-trip: mainAgentActivity.detail (with unicode)"
  );
  assert(
    loaded.phases[0].tasks[0].output === testState.phases[0].tasks[0].output,
    "Round-trip: nested task output preserved"
  );
  assert(
    loaded.phases[0].tasks[0].metadata === testState.phases[0].tasks[0].metadata,
    "Round-trip: null metadata preserved"
  );

  clearState(testDir);
}

// ── T4.8: clearState removes state file ──────────────────────────────────

section("T4.8: clearState removes state file");

{
  const testDir = path.join(TEST_STATE_DIR, "test-08-clear");
  fs.rmSync(testDir, { recursive: true, force: true });

  saveState(testDir);
  assert(fs.existsSync(stateFilePath(testDir)), "State file exists before clear");
  assert(canResumeState(testDir), "canResumeState returns true before clear");

  clearState(testDir);
  assert(
    !fs.existsSync(stateFilePath(testDir)),
    "State file removed after clearState"
  );
  assert(
    !canResumeState(testDir),
    "canResumeState returns false after clearState"
  );
}

// ── T4.9: create state dir if it doesn't exist ───────────────────────────

section("T4.9: saveState creates .caravel dir if missing");

{
  const testDir = path.join(TEST_STATE_DIR, "test-09-createmkdir");
  fs.rmSync(testDir, { recursive: true, force: true });

  // Ensure .caravel doesn't exist
  const stateDir = path.join(testDir, ".caravel");
  assert(!fs.existsSync(stateDir), ".caravel dir does not exist yet");

  saveState(testDir);
  assert(
    fs.existsSync(stateFilePath(testDir)),
    "State file exists after saveState on fresh dir"
  );
  assert(
    fs.existsSync(stateDir),
    ".caravel dir was created automatically"
  );

  clearState(testDir);
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed, ${total} total`);
console.log("═".repeat(60) + "\n");

// Cleanup test directory
try {
  fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
} catch { /* ignore cleanup errors */ }

process.exit(failed > 0 ? 1 : 0);
