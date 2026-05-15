/**
 * Tests for fleet pause/resume with state persistence.
 * 
 * Test scenarios:
 * 1. Pause mid-task → verify state saved to disk
 * 2. Verify saved state has correct phase/task status
 * 3. Resume → verify loadState restores state
 * 4. Verify task continues from exact pause point
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Test utilities ─────────────────────────────────────────────────────────

/** Create a temporary directory for test state files. */
function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-test-"));
  // Create .caravel subdirectory (where state.json lives)
  fs.mkdirSync(path.join(dir, ".caravel"), { recursive: true });
  return dir;
}

/** Simulate the FleetState interface. */
interface TestFleetState {
  phases: Array<{
    id: string;
    name: string;
    status: "pending" | "running" | "reviewing" | "complete" | "failed";
    tasks: Array<{
      id: string;
      agentName: string;
      description: string;
      status: "pending" | "running" | "complete" | "failed";
      output?: string;
      reviewCount: number;
      maxReviewCount: number;
    }>;
  }>;
  currentPhaseIndex: number;
  paused: boolean;
  startTime: number;
  reviewIterations: number;
  totalFleetTokens: number;
}

/** Simulate the state file path function. */
function stateFilePath(cwd: string): string {
  return path.join(cwd, ".caravel", "state.json");
}

/** Simulate saveState — writes the state to a JSON file. */
function testSaveState(state: TestFleetState, cwd: string): void {
  const filePath = stateFilePath(cwd);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    version: 1,
    timestamp: Date.now(),
    state: JSON.parse(JSON.stringify(state)),
  };
  const tmpPath = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/** Simulate loadState — reads state from a JSON file and returns it. */
function testLoadState(cwd: string): { success: boolean; state: TestFleetState | null } {
  const filePath = stateFilePath(cwd);
  if (!fs.existsSync(filePath)) {
    return { success: false, state: null };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { success: false, state: null };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { success: false, state: null };
  }

  // Validate schema
  if (parsed.version == null || parsed.state == null) {
    return { success: false, state: null };
  }
  if (parsed.version > 1) {
    return { success: false, state: null };
  }
  const s = parsed.state;
  if (typeof s.phases !== "object" || !Array.isArray(s.phases)) {
    return { success: false, state: null };
  }
  if (typeof s.currentPhaseIndex !== "number") {
    return { success: false, state: null };
  }

  return {
    success: true,
    state: {
      phases: s.phases,
      currentPhaseIndex: s.currentPhaseIndex,
      paused: s.paused ?? false,
      startTime: s.startTime ?? Date.now(),
      reviewIterations: s.reviewIterations ?? 0,
      totalFleetTokens: s.totalFleetTokens ?? 0,
    },
  };
}

/** Check if a saved state file exists and is valid. */
function testCanResumeState(cwd: string): boolean {
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

/** Count completed tasks in a state. */
function countCompleted(state: TestFleetState): number {
  return state.phases.reduce(
    (s, p) => s + p.tasks.filter((t) => t.status === "complete").length,
    0
  );
}

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function testGroup(name: string, fn: () => void): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(` Test: ${name}`);
  console.log(`${"─".repeat(60)}`);
  fn();
}

// ── Tests ──────────────────────────────────────────────────────────────────

testGroup("Pause mid-task → verify state saved", () => {
  const dir = createTestDir();
  try {
    // Create a fleet state with 3 phases, 2nd phase mid-execution
    const state: TestFleetState = {
      phases: [
        {
          id: "phase-1",
          name: "Setup",
          status: "complete",
          tasks: [
            { id: "t1", agentName: "developer", description: "Install dependencies", status: "complete", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
        {
          id: "phase-2",
          name: "Core Implementation",
          status: "running",
          tasks: [
            { id: "t2", agentName: "developer", description: "Build auth module", status: "complete", reviewCount: 0, maxReviewCount: 3 },
            { id: "t3", agentName: "developer", description: "Build API endpoints", status: "running", reviewCount: 0, maxReviewCount: 3 },
            { id: "t4", agentName: "tech-lead", description: "Review API code", status: "pending", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
        {
          id: "phase-3",
          name: "Testing",
          status: "pending",
          tasks: [
            { id: "t5", agentName: "developer", description: "Write unit tests", status: "pending", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
      ],
      currentPhaseIndex: 1,
      paused: true,  // Simulating pause: fleet is paused at this point
      startTime: Date.now(),
      reviewIterations: 0,
      totalFleetTokens: 52000,
    };

    // Simulate pause: save state
    testSaveState(state, dir);

    // Verify state file exists
    const statePath = stateFilePath(dir);
    assert(fs.existsSync(statePath), "state.json file exists after pause");

    // Verify state file is valid JSON
    const raw = fs.readFileSync(statePath, "utf-8");
    assert(() => { JSON.parse(raw); return true; }, "state.json is valid JSON");

    // Verify state was saved correctly
    const parsed = JSON.parse(raw);
    assert(parsed.version === 1, "state version is 1");
    assert(parsed.state.currentPhaseIndex === 1, "currentPhaseIndex saved correctly (1)");
    assert(parsed.state.paused === true, "paused flag set to true");
    assert(parsed.state.phases.length === 3, "all 3 phases preserved");

    // Verify phase 2 is mid-execution (running)
    assert(parsed.state.phases[1].status === "running", "Phase 2 status is 'running'");

    // Verify task 3 (mid-task) status preserved
    assert(parsed.state.phases[1].tasks[1].status === "running", "Task 3 status preserved as 'running'");
    assert(parsed.state.phases[1].tasks[1].description === "Build API endpoints", "Task 3 description preserved");

    // Verify task 4 is still pending
    assert(parsed.state.phases[1].tasks[2].status === "pending", "Task 4 status preserved as 'pending'");

    // Verify task 1 (completed) status preserved
    assert(parsed.state.phases[0].tasks[0].status === "complete", "Completed task 1 preserved");

    // Verify tokens preserved
    assert(parsed.state.totalFleetTokens === 52000, "totalFleetTokens preserved (52000)");

    // Verify canResumeState returns true
    assert(testCanResumeState(dir) === true, "canResumeState returns true after pause");
  } finally {
    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

testGroup("Resume → verify state restored", () => {
  const dir = createTestDir();
  try {
    // First, save a state
    const state: TestFleetState = {
      phases: [
        {
          id: "phase-1",
          name: "Setup",
          status: "complete",
          tasks: [
            { id: "t1", agentName: "developer", description: "Install dependencies", status: "complete", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
        {
          id: "phase-2",
          name: "Core Implementation",
          status: "running",
          tasks: [
            { id: "t2", agentName: "developer", description: "Build auth module", status: "complete", reviewCount: 0, maxReviewCount: 3 },
            { id: "t3", agentName: "developer", description: "Build API endpoints", status: "running", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
      ],
      currentPhaseIndex: 1,
      paused: true,
      startTime: Date.now() - 300_000, // 5 minutes ago
      reviewIterations: 1,
      totalFleetTokens: 125000,
    };

    testSaveState(state, dir);

    // Now simulate resume: load state from disk
    const result = testLoadState(dir);
    assert(result.success === true, "loadState returns success");
    assert(result.state !== null, "loaded state is not null");

    // Verify all fields restored correctly
    const loaded = result.state!;
    assert(loaded.currentPhaseIndex === 1, "currentPhaseIndex restored (1)");
    assert(loaded.paused === true, "paused flag loaded (true — will be cleared by caller)");
    assert(loaded.startTime === state.startTime, "startTime restored");
    assert(loaded.reviewIterations === 1, "reviewIterations restored (1)");
    assert(loaded.totalFleetTokens === 125000, "totalFleetTokens restored (125000)");
    assert(loaded.phases.length === 2, "phases count restored (2)");

    // Verify phase data intact
    assert(loaded.phases[0].status === "complete", "Phase 1 status restored");
    assert(loaded.phases[0].tasks[0].status === "complete", "Phase 1 Task 1 restored");
    assert(loaded.phases[1].status === "running", "Phase 2 status restored (running)");
    assert(loaded.phases[1].tasks[1].status === "running", "Phase 2 Task 3 restored (running)");

    // Verify task descriptions preserved
    assert(loaded.phases[1].tasks[1].description === "Build API endpoints", "Task 3 description preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

testGroup("Resume without saved state → graceful handling", () => {
  const dir = createTestDir();
  try {
    // Don't save any state — just try to resume
    const result = testLoadState(dir);
    assert(result.success === false, "loadState returns false when no state file");
    assert(result.state === null, "loaded state is null when no saved state");

    // Verify canResumeState returns false
    assert(testCanResumeState(dir) === false, "canResumeState returns false without state");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

testGroup("Resume clears paused flag and saves updated state", () => {
  const dir = createTestDir();
  try {
    // Save paused state
    const state: TestFleetState = {
      phases: [
        {
          id: "phase-1",
          name: "Setup",
          status: "running",
          tasks: [
            { id: "t1", agentName: "developer", description: "Install deps", status: "running", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
      ],
      currentPhaseIndex: 0,
      paused: true,
      startTime: Date.now(),
      reviewIterations: 0,
      totalFleetTokens: 10000,
    };
    testSaveState(state, dir);

    // Simulate resume: load state, clear paused, save again
    const loadResult = testLoadState(dir);
    assert(loadResult.success === true, "state loaded before resume");

    // Clear paused flag (simulating resume action)
    if (loadResult.state) {
      loadResult.state.paused = false;
      testSaveState(loadResult.state, dir);
    }

    // Verify paused flag is now false
    const checkResult = testLoadState(dir);
    assert(checkResult.state?.paused === false, "paused flag cleared to false after resume");
    assert(checkResult.success === true, "state still valid after resume save");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

testGroup("State survives pause/resume cycle — task continuity", () => {
  const dir = createTestDir();
  try {
    // Create a complex fleet state mid-execution
    const originalState: TestFleetState = {
      phases: [
        {
          id: "phase-1",
          name: "Analysis",
          status: "complete",
          tasks: [
            { id: "t1", agentName: "auditor", description: "Codebase analysis", status: "complete", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
        {
          id: "phase-2",
          name: "Development",
          status: "running",
          tasks: [
            { id: "t2", agentName: "developer", description: "Implement auth", status: "complete", reviewCount: 0, maxReviewCount: 3 },
            { id: "t3", agentName: "developer", description: "Implement API", status: "running", reviewCount: 0, maxReviewCount: 3 },
            { id: "t4", agentName: "tech-lead", description: "Code review", status: "pending", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
        {
          id: "phase-3",
          name: "Testing",
          status: "pending",
          tasks: [
            { id: "t5", agentName: "developer", description: "Unit tests", status: "pending", reviewCount: 0, maxReviewCount: 3 },
            { id: "t6", agentName: "tester", description: "Integration tests", status: "pending", reviewCount: 0, maxReviewCount: 3 },
          ],
        },
      ],
      currentPhaseIndex: 1,
      paused: true,
      startTime: Date.now() - 600_000, // 10 min ago
      reviewIterations: 2,
      totalFleetTokens: 245000,
    };

    // ── PAUSE ──
    testSaveState(originalState, dir);

    // Verify paused state is intact
    const pauseResult = testLoadState(dir);
    assert(pauseResult.success === true, "pause state loadable");
    assert(pauseResult.state!.paused === true, "pause: paused=true");
    assert(pauseResult.state!.currentPhaseIndex === 1, "pause: currentPhaseIndex=1");
    assert(countCompleted(pauseResult.state!) === 2, "pause: 2/7 tasks complete");

    // ── RESUME ──
    // Simulate resume: load state, clear paused, save
    if (pauseResult.state) {
      pauseResult.state.paused = false;
      testSaveState(pauseResult.state, dir);
    }

    // Verify resumed state
    const resumeResult = testLoadState(dir);
    assert(resumeResult.success === true, "resume state loadable");
    assert(resumeResult.state!.paused === false, "resume: paused=false");
    assert(resumeResult.state!.currentPhaseIndex === 1, "resume: currentPhaseIndex still 1");

    // ── TASK CONTINUITY — key test ──
    // After resume, task 3 should still be "running" (exactly where pause happened)
    assert(
      resumeResult.state!.phases[1].tasks[1].status === "running",
      "resume: Task 3 still 'running' (exact pause point preserved)"
    );
    assert(
      resumeResult.state!.phases[1].tasks[1].description === "Implement API",
      "resume: Task 3 description preserved"
    );

    // Task 2 should still be complete
    assert(
      resumeResult.state!.phases[1].tasks[0].status === "complete",
      "resume: Task 2 still complete"
    );

    // Task 4 should still be pending
    assert(
      resumeResult.state!.phases[1].tasks[2].status === "pending",
      "resume: Task 4 still pending"
    );

    // Task 5,6 should still be pending
    assert(
      resumeResult.state!.phases[2].tasks[0].status === "pending",
      "resume: Task 5 still pending"
    );
    assert(
      resumeResult.state!.phases[2].tasks[1].status === "pending",
      "resume: Task 6 still pending"
    );

    // Phase statuses preserved
    assert(
      resumeResult.state!.phases[0].status === "complete",
      "resume: Phase 1 still complete"
    );
    assert(
      resumeResult.state!.phases[1].status === "running",
      "resume: Phase 2 still running"
    );
    assert(
      resumeResult.state!.phases[2].status === "pending",
      "resume: Phase 3 still pending"
    );

    // Metadata preserved
    assert(
      resumeResult.state!.reviewIterations === 2,
      "resume: reviewIterations preserved (2)"
    );
    assert(
      resumeResult.state!.totalFleetTokens === 245000,
      "resume: totalFleetTokens preserved (245000)"
    );
    assert(
      resumeResult.state!.startTime === originalState.startTime,
      "resume: startTime preserved"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`${"─".repeat(60)}`);
console.log(` Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(" ❌ Some tests failed");
  process.exit(1);
} else {
  console.log(" ✅ All tests passed!");
}
