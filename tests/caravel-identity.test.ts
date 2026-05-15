/**
 * Tests for caravel-identity module.
 *
 * Test groups:
 * 1. Identity format — deterministic `caravel/<name>/primary`
 * 2. File persistence — read/write `.caravel/agents.json`
 * 3. Deterministic generation — same input -> same output
 * 4. Reset behavior — removal from persisted file
 * 5. recordWork — validation, persistence, file structure
 * 6. getAgentHistory — retrieval by identity
 * 7. getPhaseHistory — retrieval by phase
 * 8. Auto-rotate — 100-entry limit per agent
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  getAgentIdentity,
  listAgentIdentities,
  resetAgentIdentity,
  registerAgentIdentity,
  recordWork,
  getAgentHistory,
  getPhaseHistory,
} from "./caravel-identity";

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let errors: Array<{ test: string; error: string }> = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    failed++;
    errors.push({ test: currentTest(), error: `ASSERT: ${msg}` });
    console.error(`  ✗ ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    failed++;
    errors.push({ test: currentTest(), error: `EXPECTED ${expectedStr} GOT ${actualStr}: ${msg}` });
    console.error(`  ✗ ${msg} (expected ${expectedStr}, got ${actualStr})`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    failed++;
    errors.push({ test: currentTest(), error: `EXPECTED THROWS: ${msg}` });
    console.error(`  ✗ ${msg} (expected error, got none)`);
  } catch (e: any) {
    passed++;
    console.log(`  ✓ ${msg}: ${e.message}`);
  }
}

let currentTestName = "";
function currentTest(): string { return currentTestName || "(unknown)"; }
function runTest(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  currentTestName = name;
  fn();
}

// ── Test helpers ───────────────────────────────────────────────────────────────

/** Create a temporary directory for test state files. */
function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-identity-test-"));
  // Create .caravel subdirectory
  fs.mkdirSync(path.join(dir, ".caravel"), { recursive: true });
  return dir;
}

/** Delete a test directory and all its contents. */
function removeTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Test groups ────────────────────────────────────────────────────────────────

// ── Group 1: Identity format ──────────────────────────────────────────────────

runTest("Group 1: Identity format", () => {
  runTest("  1.1 getAgentIdentity returns 'caravel/<name>/primary'", () => {
    const actual = getAgentIdentity("dev");
    assertEqual(actual, "caravel/dev/primary", "format matches caravel/<name>/primary");
  });

  runTest("  1.2 getAgentIdentity works with various names", () => {
    assertEqual(getAgentIdentity("alice"), "caravel/alice/primary", "alice");
    assertEqual(getAgentIdentity("bob"), "caravel/bob/primary", "bob");
    assertEqual(getAgentIdentity("coder-42"), "caravel/coder-42/primary", "with dash");
    assertEqual(getAgentIdentity("agent_X"), "caravel/agent_X/primary", "with underscore");
  });

  runTest("  1.3 getAgentIdentity rejects empty/whitespace names", () => {
    assertThrows(() => getAgentIdentity(""), "empty string");
    assertThrows(() => getAgentIdentity("   "), "whitespace-only string");
    assertThrows(() => getAgentIdentity(null as any), "null");
    assertThrows(() => getAgentIdentity(undefined as any), "undefined");
    assertThrows(() => getAgentIdentity(42 as any), "number");
  });

  runTest("  1.4 getAgentIdentity trims leading/trailing whitespace", () => {
    assertEqual(getAgentIdentity("  dev  "), "caravel/dev/primary", "trims whitespace");
  });
});

// ── Group 2: Deterministic generation ─────────────────────────────────────────

runTest("Group 2: Deterministic generation", () => {
  runTest("  2.1 Same name always produces same identity", () => {
    const a = getAgentIdentity("developer");
    const b = getAgentIdentity("developer");
    const c = getAgentIdentity("developer");
    assertEqual(a, b, "first two calls match");
    assertEqual(b, c, "second and third calls match");
    assertEqual(a, c, "first and third calls match");
  });

  runTest("  2.2 Different names produce different identities", () => {
    const ids = new Set<string>();
    for (const name of ["alice", "bob", "charlie", "dave"]) {
      ids.add(getAgentIdentity(name));
    }
    assertEqual(ids.size, 4, "all four identities are unique");
  });

  runTest("  2.3 No timestamps or randomness in identity string", () => {
    const calls = Array.from({ length: 100 }, () => getAgentIdentity("test-agent"));
    const unique = new Set(calls);
    assertEqual(unique.size, 1, "100 calls all return the same string");
  });
});

// ── Group 3: File persistence ─────────────────────────────────────────────────

runTest("Group 3: File persistence", () => {
  let testDir = "";

  runTest("  3.1 listAgentIdentities returns empty when no file exists", () => {
    testDir = createTestDir();
    const ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 0, "no agents before registration");
  });

  runTest("  3.2 registerAgentIdentity creates agents.json", () => {
    const filePath = path.join(testDir, ".caravel", "agents.json");
    registerAgentIdentity("dev", testDir);
    assert(fs.existsSync(filePath), "agents.json file exists");
  });

  runTest("  3.3 agents.json contains valid JSON", () => {
    const filePath = path.join(testDir, ".caravel", "agents.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert(false, "agents.json is valid JSON");
      return;
    }
    assertEqual(typeof parsed.version, "number", "has version field");
    assert(Array.isArray(parsed.agents), "has agents array");
    assertEqual(parsed.agents.length, 1, "contains 1 agent");
    assertEqual(parsed.agents[0].name, "dev", "agent name is dev");
    assertEqual(parsed.agents[0].identity, "caravel/dev/primary", "agent identity is correct");
    assert(typeof parsed.agents[0].createdAt === "number", "has createdAt timestamp");
    assert(typeof parsed.agents[0].updatedAt === "number", "has updatedAt timestamp");
  });

  runTest("  3.4 listAgentIdentities reads persisted identities", () => {
    const ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 1, "1 identity loaded");
    assertEqual(ids[0].name, "dev", "name matches");
    assertEqual(ids[0].identity, "caravel/dev/primary", "identity matches");
  });

  runTest("  3.5 registerAgentIdentity adds multiple agents", () => {
    registerAgentIdentity("alice", testDir);
    registerAgentIdentity("bob", testDir);
    const ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 3, "3 identities after adding 2 more");
    const names = ids.map((a) => a.name).sort();
    assertEqual(names, ["alice", "bob", "dev"], "names are alice, bob, dev");
  });

  runTest("  3.6 registerAgentIdentity updates existing entry", () => {
    const before = listAgentIdentities(testDir);
    const beforeLen = before.length;

    // Register again
    registerAgentIdentity("alice", testDir);

    const after = listAgentIdentities(testDir);
    assertEqual(after.length, beforeLen, "same number of entries after re-register");
    const aliceEntry = after.find((a) => a.name === "alice");
    assertEqual(aliceEntry?.identity, "caravel/alice/primary", "alice identity correct after re-register");
  });

  runTest("  3.7 agents.json file structure on disk", () => {
    const filePath = path.join(testDir, ".caravel", "agents.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    assertEqual(typeof parsed.version, "number", "version is number");
    assertEqual(parsed.version, 1, "version is 1");
    assert(Array.isArray(parsed.agents), "agents is array");
    assert(typeof parsed.updatedAt === "number", "updatedAt is number");
  });

  runTest("  3.8 Persistence survives reload from fresh load", () => {
    const testDir2 = createTestDir();

    // Register in testDir2
    registerAgentIdentity("persist-test", testDir2);

    // Force a fresh load (simulate re-import)
    const freshList = listAgentIdentities(testDir2);
    assertEqual(freshList.length, 1, "identity survives fresh load");
    assertEqual(freshList[0].name, "persist-test", "name survives fresh load");
    assertEqual(freshList[0].identity, "caravel/persist-test/primary", "identity survives fresh load");

    removeTestDir(testDir2);
  });
});

// ── Group 4: Reset behavior ───────────────────────────────────────────────────

runTest("Group 4: Reset behavior", () => {
  let testDir = "";

  runTest("  4.1 resetAgentIdentity returns false when identity doesn't exist", () => {
    testDir = createTestDir();
    const result = resetAgentIdentity("nonexistent", testDir);
    assertEqual(result, false, "returns false for unknown identity");
  });

  runTest("  4.2 resetAgentIdentity removes entry and updates file", () => {
    registerAgentIdentity("to-remove", testDir);
    let ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 1, "1 identity before reset");

    const result = resetAgentIdentity("to-remove", testDir);
    assertEqual(result, true, "returns true for existing identity");

    ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 0, "0 identities after reset");
  });

  runTest("  4.3 resetAgentIdentity removes specific identity, keeps others", () => {
    registerAgentIdentity("keep-me", testDir);
    registerAgentIdentity("remove-me", testDir);

    resetAgentIdentity("remove-me", testDir);

    const ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 1, "1 identity remains");
    assertEqual(ids[0].name, "keep-me", "the remaining identity is 'keep-me'");
  });

  runTest("  4.4 Multiple resets on same name are idempotent", () => {
    registerAgentIdentity("idem", testDir);

    let result = resetAgentIdentity("idem", testDir);
    assertEqual(result, true, "first reset succeeds");

    result = resetAgentIdentity("idem", testDir);
    assertEqual(result, false, "second reset returns false");

    const ids = listAgentIdentities(testDir);
    assertEqual(ids.length, 1, "1 identity remains (keep-me from earlier)");
  });

  runTest("  4.5 resetAgentIdentity after re-register works", () => {
    registerAgentIdentity("re-reg", testDir);
    assertEqual(listAgentIdentities(testDir).length, 2, "2 identities after re-register");

    resetAgentIdentity("re-reg", testDir);
    assertEqual(listAgentIdentities(testDir).length, 1, "1 identity after reset");

    // Re-register should add it back
    registerAgentIdentity("re-reg", testDir);
    assertEqual(listAgentIdentities(testDir).length, 2, "2 identities after re-register again");
  });

  runTest("  4.6 resetAgentIdentity preserves file validity", () => {
    registerAgentIdentity("valid-test", testDir);
    const beforeLen = listAgentIdentities(testDir).length;
    resetAgentIdentity("valid-test", testDir);

    const filePath = path.join(testDir, ".caravel", "agents.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert(false, "agents.json still valid JSON after reset");
      return;
    }
    assertEqual(Array.isArray(parsed.agents), true, "agents is still an array");
    assertEqual(parsed.agents.length, beforeLen - 1, "one fewer entry after reset");
    assertEqual(parsed.version, 1, "version preserved");
  });
});

// ── Group 5: recordWork ───────────────────────────────────────────────────────

runTest("Group 5: recordWork", () => {
  const rwDir = createTestDir();

  runTest("  5.1 recordWork creates history.json on first call", () => {
    const identity = "caravel/dev/primary";
    recordWork(identity, "task-1", "design", "Initial design work", rwDir);
    const filePath = path.join(rwDir, ".caravel", "history.json");
    assert(fs.existsSync(filePath), "history.json file exists");
  });

  runTest("  5.2 recordWork appends a WorkEntry with correct fields", () => {
    const identity = "caravel/dev/primary";
    recordWork(identity, "task-2", "implement", "Write core module", rwDir);
    const history = getAgentHistory(identity, rwDir);
    assertEqual(history.length, 2, "2 entries (1 from 5.1 + 1 new)");
    // history[0] is from 5.1 (older), history[1] is the new entry from this test
    assertEqual(history[0].taskId, "task-1", "older entry taskId matches");
    assertEqual(history[1].identity, identity, "identity matches");
    assertEqual(history[1].taskId, "task-2", "taskId matches");
    assertEqual(history[1].phase, "implement", "phase matches");
    assertEqual(history[1].summary, "Write core module", "summary matches");
    assert(typeof history[1].timestamp === "number", "timestamp is a number");
  });

  runTest("  5.3 recordWork accepts custom cwd", () => {
    const identity = "caravel/bob/primary";
    recordWork(identity, "task-3", "test", "Write unit tests", rwDir);
    const history = getAgentHistory(identity, rwDir);
    assertEqual(history.length, 1, "1 entry for bob");
    assertEqual(history[0].taskId, "task-3", "taskId saved correctly");
  });

  runTest("  5.4 Multiple recordWork calls accumulate entries", () => {
    const identity = "caravel/dev/primary";
    recordWork(identity, "task-4", "review", "Code review pass 1", rwDir);
    recordWork(identity, "task-5", "review", "Code review pass 2", rwDir);
    const history = getAgentHistory(identity, rwDir);
    assertEqual(history.length, 4, "4 total entries (2 from 5.1/5.2 + 2 new)");
  });

  runTest("  5.5 recordWork rejects invalid identity", () => {
    assertThrows(() => recordWork("", "t", "p", "s"), "empty identity");
    assertThrows(() => recordWork("  ", "t", "p", "s"), "whitespace identity");
    assertThrows(() => recordWork(null as any, "t", "p", "s"), "null identity");
  });

  runTest("  5.6 recordWork rejects invalid taskId", () => {
    assertThrows(() => recordWork("caravel/dev/primary", "", "p", "s"), "empty taskId");
    assertThrows(() => recordWork("caravel/dev/primary", null as any, "p", "s"), "null taskId");
  });

  runTest("  5.7 recordWork rejects invalid phase", () => {
    assertThrows(() => recordWork("caravel/dev/primary", "t", "", "s"), "empty phase");
    assertThrows(() => recordWork("caravel/dev/primary", "t", null as any, "s"), "null phase");
  });

  runTest("  5.8 recordWork rejects invalid summary", () => {
    assertThrows(() => recordWork("caravel/dev/primary", "t", "p", ""), "empty summary");
    assertThrows(() => recordWork("caravel/dev/primary", "t", "p", null as any), "null summary");
  });

  runTest("  5.9 history.json file structure", () => {
    const filePath = path.join(rwDir, ".caravel", "history.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    assertEqual(typeof parsed.version, "number", "version is number");
    assertEqual(parsed.version, 1, "version is 1");
    assert(typeof parsed.work === "object", "work is an object");
    assert(typeof parsed.updatedAt === "number", "updatedAt is number");
  });
});

// ── Group 6: getAgentHistory ──────────────────────────────────────────────────

runTest("Group 6: getAgentHistory", () => {
  let testDir = "";

  runTest("  6.1 getAgentHistory returns empty for unknown identity", () => {
    testDir = createTestDir();
    const history = getAgentHistory("caravel/ghost/primary", testDir);
    assertEqual(history.length, 0, "no entries for unknown identity");
  });

  runTest("  6.2 getAgentHistory returns entries for known identity", () => {
    const identity = "caravel/alice/primary";
    recordWork(identity, "alice-1", "design", "Design task", testDir);
    recordWork(identity, "alice-2", "implement", "Implement task", testDir);
    const history = getAgentHistory(identity, testDir);
    assertEqual(history.length, 2, "2 entries for alice");
  });

  runTest("  6.3 getAgentHistory returns entries sorted by timestamp ascending", () => {
    const identity = "caravel/bob/primary";
    recordWork(identity, "b-3", "design", "third", testDir);
    // Use a tiny delay to ensure ordering
    const before = Date.now();
    // Note: in practice timestamps are usually distinct; verify order
    const history = getAgentHistory(identity, testDir);
    if (history.length >= 2) {
      assert(history[history.length - 2].taskId !== history[history.length - 1].taskId, "entries are not all identical");
    }
    assert(history[0].timestamp <= history[history.length - 1].timestamp, "sorted ascending");
  });

  runTest("  6.4 getAgentHistory returns a copy (mutations don't affect storage)", () => {
    const identity = "caravel/alice/primary";
    const before = getAgentHistory(identity, testDir);
    before.length = 0; // Mutate the returned array
    const after = getAgentHistory(identity, testDir);
    assertEqual(after.length, 2, "array was mutated but storage unaffected");
  });

  runTest("  6.5 Different agents have separate histories", () => {
    const identity1 = "caravel/alice/primary";
    const identity2 = "caravel/bob/primary";
    const history1 = getAgentHistory(identity1, testDir);
    const history2 = getAgentHistory(identity2, testDir);
    for (const entry of history1) {
      assert(!history2.some((e) => e.taskId === entry.taskId), "no cross-agent leakage for " + entry.taskId);
    }
  });
});

// ── Group 7: getPhaseHistory ──────────────────────────────────────────────────

runTest("Group 7: getPhaseHistory", () => {
  let testDir = "";

  runTest("  7.1 getPhaseHistory returns empty for non-existent phase", () => {
    testDir = createTestDir();
    const history = getPhaseHistory("nonexistent", testDir);
    assertEqual(history.length, 0, "no entries for non-existent phase");
  });

  runTest("  7.2 getPhaseHistory returns entries for matching phase", () => {
    const identity1 = "caravel/alice/primary";
    const identity2 = "caravel/bob/primary";

    recordWork(identity1, "ph-1", "design", "alice design", testDir);
    recordWork(identity1, "ph-2", "implement", "alice implement", testDir);
    recordWork(identity2, "ph-3", "design", "bob design", testDir);
    recordWork(identity2, "ph-4", "test", "bob test", testDir);

    const designHistory = getPhaseHistory("design", testDir);
    assertEqual(designHistory.length, 2, "2 design entries across agents");
    assert(designHistory.every((e) => e.phase === "design"), "all entries have phase 'design'");
    assertEqual(designHistory[0].taskId, "ph-1", "first is alice's design");
    assertEqual(designHistory[1].taskId, "ph-3", "second is bob's design");
  });

  runTest("  7.3 getPhaseHistory returns entries sorted by timestamp ascending", () => {
    const identity = "caravel/alice/primary";
    recordWork(identity, "ph-5", "implement", "impl task", testDir);
    recordWork(identity, "ph-6", "implement", "impl task 2", testDir);
    const history = getPhaseHistory("implement", testDir);
    if (history.length >= 2) {
      assert(history[0].timestamp <= history[history.length - 1].timestamp, "sorted ascending");
    }
  });

  runTest("  7.4 getPhaseHistory filters correctly across multiple phases", () => {
    const identity = "caravel/bob/primary";
    const testHistory = getPhaseHistory("test", testDir);
    assertEqual(testHistory.length, 1, "1 test entry for bob");
    assertEqual(testHistory[0].taskId, "ph-4", "correct test entry");
  });
});

// ── Group 8: Auto-rotate ──────────────────────────────────────────────────────

runTest("Group 8: Auto-rotate (100 entries per agent limit)", () => {
  let testDir = "";

  runTest("  8.1 Auto-rotate drops oldest entries when exceeding 100", () => {
    testDir = createTestDir();
    const identity = "caravel/rotator/primary";

    // Record 110 entries
    for (let i = 0; i < 110; i++) {
      recordWork(identity, `auto-${i}`, "design", `Auto task ${i}`, testDir);
    }

    const history = getAgentHistory(identity, testDir);
    assertEqual(history.length, 100, "capped at 100 entries");

    // Verify oldest 10 were dropped (entries 0-9 should be gone, entries 10-109 remain)
    const taskIds = history.map((e) => e.taskId);
    assert(!taskIds.includes("auto-0"), "oldest entry auto-0 was dropped");
    assert(!taskIds.includes("auto-9"), "entry auto-9 was dropped");
    assert(taskIds.includes("auto-10"), "entry auto-10 is the new oldest");
    assert(taskIds.includes("auto-109"), "newest entry auto-109 is present");
  });

  runTest("  8.2 Auto-rotate does not trigger at exactly 100", () => {
    const identity = "caravel/exact/primary";

    for (let i = 0; i < 100; i++) {
      recordWork(identity, `exact-${i}`, "implement", `Exact task ${i}`, testDir);
    }

    const history = getAgentHistory(identity, testDir);
    assertEqual(history.length, 100, "exactly 100 entries, no drop");
  });

  runTest("  8.3 Auto-rotate per-agent: each agent has its own 100 limit", () => {
    const identityA = "caravel/agent-a/primary";
    const identityB = "caravel/agent-b/primary";

    // Agent A: 120 entries
    for (let i = 0; i < 120; i++) {
      recordWork(identityA, `a-${i}`, "design", `Agent A task ${i}`, testDir);
    }

    // Agent B: 50 entries (should be untouched)
    for (let i = 0; i < 50; i++) {
      recordWork(identityB, `b-${i}`, "implement", `Agent B task ${i}`, testDir);
    }

    const historyA = getAgentHistory(identityA, testDir);
    const historyB = getAgentHistory(identityB, testDir);
    assertEqual(historyA.length, 100, "agent A capped at 100");
    assertEqual(historyB.length, 50, "agent B unchanged at 50");
  });

  runTest("  8.4 Auto-rotate preserves file validity after rotation", () => {
    const identity = "caravel/fresh-rotate/primary";

    for (let i = 0; i < 150; i++) {
      recordWork(identity, `rot-fresh-${i}`, "test", `Fresh rotate task ${i}`, testDir);
    }

    const filePath = path.join(testDir, ".caravel", "history.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert(false, "history.json still valid JSON after heavy rotation");
      return;
    }
    assertEqual(parsed.version, 1, "version preserved after rotation");
    assert(typeof parsed.work === "object", "work object preserved");
    assert(parsed.work[identity]?.length === 100, "agent still has 100 entries");
  });

  runTest("  8.5 getPhaseHistory respects auto-rotate (only sees remaining entries)", () => {
    const identity = "caravel/phase-rotate/primary";

    for (let i = 0; i < 105; i++) {
      recordWork(identity, `pr-${i}`, "review", `Review task ${i}`, testDir);
    }

    const phaseHistory = getPhaseHistory("review", testDir);
    assertEqual(phaseHistory.length, 100, "phase history respects 100-entry cap");
    assert(phaseHistory.every((e) => e.phase === "review"), "all phase entries are 'review'");
  });
});

// ── Summary ────────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════");
const total = passed + failed;
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);

if (errors.length > 0) {
  console.error("\nFailures:");
  for (const e of errors) {
    console.error(`  ✗ ${e.test}: ${e.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
