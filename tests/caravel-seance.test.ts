/**
 * Tests for generateRecoveryContext
 * Run: npx tsx extensions/caravel-seance.test.ts
 */

import { generateRecoveryContext } from "./caravel-seance.js";
import type { SeanceRecord } from "./caravel-seance.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function buildSeance(overrides: Partial<SeanceRecord> = {}): SeanceRecord {
  return {
    id: "test-seance-id",
    agentIdentity: "caravel/developer/primary",
    taskId: "task-1",
    phase: "coding",
    terminatedAt: Date.now(),
    reason: "timeout",
    workSummary: "Implemented the recovery context feature with deterministic output",
    filesModified: ["extensions/caravel-seance.ts", "extensions/caravel-seance.test.ts"],
    toolCallHistory: [
      { tool: "write", args: '{"path":"caravel-seance.ts"}', result: "ok" },
      { tool: "read", args: '{"path":"caravel-seance.ts"}', result: "read ok" },
    ],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

console.log("\n🧪 Testing generateRecoveryContext\n");

// 1. ≤500 chars
console.log("1. Length check:");
const normalSeance = buildSeance();
const ctx = generateRecoveryContext(normalSeance);
assert(ctx.length <= 500, `output length ${ctx.length} ≤ 500`);

// 2. Includes workSummary
console.log("2. workSummary included:");
assert(ctx.includes("workSummary:"), `output contains workSummary content`);
assert(ctx.includes("Implemented"), `output contains workSummary text`);

// 3. Includes filesModified
console.log("3. filesModified included:");
assert(ctx.includes("filesModified:["), `output contains filesModified marker`);
assert(ctx.includes("caravel-seance.ts"), `output contains file path`);
assert(ctx.includes("caravel-seance.test.ts"), `output contains file path 2`);

// 4. Includes toolCallHistory
console.log("4. toolCallHistory included:");
assert(ctx.includes("toolCallHistory:["), `output contains toolCallHistory marker`);
assert(ctx.includes("write"), `output contains tool name 'write'`);
assert(ctx.includes("read"), `output contains tool name 'read'`);

// 5. Determinism — same input → same output twice
console.log("\n5. Determinism:");
const ctx1 = generateRecoveryContext(buildSeance());
const ctx2 = generateRecoveryContext(buildSeance());
assert(ctx1 === ctx2, "same input produces same output twice");

// 6. Determinism with different records
console.log("\n6. Different inputs produce different output:");
const differentSeance = buildSeance({ workSummary: "Different summary" });
const ctxDiff = generateRecoveryContext(differentSeance);
assert(ctx1 !== ctxDiff, "different inputs produce different outputs");

// 7. Empty seance still produces valid output
console.log("\n7. Empty seance:");
const emptySeance = buildSeance({ workSummary: undefined, filesModified: undefined, toolCallHistory: undefined });
const ctxEmpty = generateRecoveryContext(emptySeance);
assert(typeof ctxEmpty === "string", `empty seance returns string`);
assert(ctxEmpty.length === 0, `empty seance returns empty string`);
assert(ctxEmpty.length <= 500, `empty seance ≤ 500 chars`);

// 8. Long content trimmed to ≤500
console.log("\n8. Truncation to ≤500:");
const longSeance = buildSeance({
  workSummary: "A".repeat(600),
  filesModified: ["B".repeat(200), "C".repeat(200)],
});
const ctxLong = generateRecoveryContext(longSeance);
assert(ctxLong.length <= 500, `truncated output ${ctxLong.length} ≤ 500`);

// ── Summary ────────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""}`);
console.log(`${"=".repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
