/**
 * Tests for the testability enforcement module.
 *
 * Test coverage:
 * - Criterion 1: Test files or verification commands detection
 * - Criterion 2: Acceptance criteria detection
 * - Criterion 3: Measurable outcome detection
 * - Combined: All three criteria together
 * - Block message generation for failed tasks
 * - Empty plan handling
 * - Edge cases and boundary conditions
 */

import {
  hasTestsOrVerification,
  hasAcceptanceCriteria,
  hasMeasurableOutcome,
  validateTask,
  validatePlan,
  enforceTestability,
  type TaskValidationResult,
  type PlanValidationResult,
} from "./testability-enforcement";

// ── Test runner ───────────────────────────────────────────────────────────

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

// ── Criterion 1: Test files or verification commands ─────────────────────

testGroup("Criterion 1: hasTestsOrVerification", () => {
  assert(
    hasTestsOrVerification("Create src/Button.test.ts with snapshot tests"),
    "Detects .test. file pattern"
  );
  assert(
    hasTestsOrVerification("Write __tests__/AuthController.spec.ts"),
    "Detects __tests__/ and .spec. patterns"
  );
  assert(
    hasTestsOrVerification("Run npm test --coverage"),
    "Detects 'npm test' command"
  );
  assert(
    hasTestsOrVerification("Execute pytest for module X"),
    "Detects 'pytest' command"
  );
  assert(
    hasTestsOrVerification("Write unit tests for auth module"),
    "Detects 'unit test' text"
  );
  assert(
    hasTestsOrVerification("Add integration tests for API endpoints"),
    "Detects 'integration test' text"
  );
  assert(
    hasTestsOrVerification("Run e2e tests with npx vitest"),
    "Detects 'e2e test' and 'npx vitest'"
  );
  assert(
    hasTestsOrVerification("Execute test suite with cargo test"),
    "Detects 'cargo test' command"
  );
  assert(
    hasTestsOrVerification("Add verification command: make test"),
    "Detects 'verification' and 'make test'"
  );
  assert(
    hasTestsOrVerification("Run go test ./..."),
    "Detects 'go test'"
  );
  // Negative cases
  assert(
    !hasTestsOrVerification("Build the auth module for production"),
    "Rejects task without test mentions"
  );
  assert(
    !hasTestsOrVerification("Create a new user registration form"),
    "Rejects vague task without tests"
  );
  assert(
    !hasTestsOrVerification("Implement a basic button component"),
    "Rejects minimal task without test intent"
  );
});

// ── Criterion 2: Acceptance criteria ─────────────────────────────────────

testGroup("Criterion 2: hasAcceptanceCriteria", () => {
  assert(
    hasAcceptanceCriteria("Create Button. Done when: renders primary color, handles click events, responds to disabled prop"),
    "Detects 'Done when:' pattern"
  );
  assert(
    hasAcceptanceCriteria("Acceptance: component renders with props A, B, C"),
    "Detects 'Acceptance:' prefix"
  );
  assert(
    hasAcceptanceCriteria("Verify that the API returns 200 status for valid requests"),
    "Detects 'verify that' pattern"
  );
  assert(
    hasAcceptanceCriteria("Ensure the form validates all required fields before submission"),
    "Detects 'Ensure' keyword"
  );
  assert(
    hasAcceptanceCriteria("The function should return true when input is valid"),
    "Detects 'should' keyword"
  );
  assert(
    hasAcceptanceCriteria("Expected output: a JSON object with 'id', 'name', and 'status' fields"),
    "Detects 'Expected' pattern"
  );
  assert(
    hasAcceptanceCriteria("Given a valid token, when requesting /api/profile, then return user data"),
    "Detects Given/When/Then pattern"
  );
  assert(
    hasAcceptanceCriteria("Required: must handle edge case of empty string input"),
    "Detects 'Required' keyword"
  );
  // Negative case
  assert(
    !hasAcceptanceCriteria("Create a basic button component for the UI"),
    "Rejects vague task without acceptance criteria"
  );
  assert(
    !hasAcceptanceCriteria("Implement the login form"),
    "Rejects minimal task without criteria"
  );
});

// ── Criterion 3: Measurable outcome ──────────────────────────────────────

testGroup("Criterion 3: hasMeasurableOutcome", () => {
  assert(
    hasMeasurableOutcome("Create src/components/Button.tsx with TypeScript types"),
    "Detects .tsx file extension"
  );
  assert(
    hasMeasurableOutcome("Build the API layer in src/api/ with Express routes"),
    "Detects 'src/' directory pattern"
  );
  assert(
    hasMeasurableOutcome("Generate the database schema in migrations/001_initial.sql"),
    "Detects 'migrations/' and .sql extension"
  );
  assert(
    hasMeasurableOutcome("Create a new React component with TypeScript"),
    "Detects 'new' + component context"
  );
  assert(
    hasMeasurableOutcome("Implement a function that returns a Promise<string>"),
    "Detects 'function' and output type"
  );
  assert(
    hasMeasurableOutcome("Add a REST endpoint POST /api/users that returns 201"),
    "Detects 'endpoint' and 'returns'"
  );
  assert(
    hasMeasurableOutcome("Create the auth module in lib/auth.ts"),
    "Detects 'lib/' and .ts extension"
  );
  assert(
    hasMeasurableOutcome("Build the dist output bundle under 100kb"),
    "Detects 'dist/' and numeric threshold"
  );
  assert(
    hasMeasurableOutcome("Write a documentation report in docs/architecture.md"),
    "Detects 'document', 'report' keywords"
  );
  // Negative case
  assert(
    !hasMeasurableOutcome("Improve the overall system performance"),
    "Rejects vague task with no concrete deliverable"
  );
  assert(
    !hasMeasurableOutcome("Make the UI look better"),
    "Rejects subjective task without measurable outcome"
  );
});

// ── validateTask: single task validation ─────────────────────────────────

testGroup("validateTask: single task validation", () => {
  // Task that passes all criteria
  const result1 = validateTask("t1", "Create src/Button.test.ts and src/Button.tsx. Done when: button renders with primary color and click handler returns true.");
  assert(result1.passed, "Task passes all three criteria");
  assert(result1.failures.length === 0, "No failures when all criteria met");

  // Task that fails all criteria
  const result2 = validateTask("t2", "Build a button");
  assert(!result2.passed, "Task fails when all criteria missing");
  assert(result2.failures.length === 3, "All three criteria fail: " + result2.failures.map(f => f.criterion).join(", "));
  assert(result2.failures[0].criterion === "test_files", "First failure is test_files");
  assert(result2.failures[1].criterion === "acceptance_criteria", "Second failure is acceptance_criteria");
  assert(result2.failures[2].criterion === "measurable_outcome", "Third failure is measurable_outcome");

  // Task that fails one criterion (missing acceptance criteria)
  const result3 = validateTask("t3", "Create src/Button.tsx and add Button.test.ts. Implement the button component.");
  assert(!result3.passed, "Task fails when missing one criterion");
  assert(result3.failures.length === 1, "Exactly one failure: " + result3.failures.map(f => f.criterion).join(", "));
  assert(result3.failures[0].criterion === "acceptance_criteria", "Missing acceptance criteria");

  // Task with tests + outcome but no acceptance
  const result4 = validateTask("t4", "Create auth.test.ts for auth module and implement the auth service.");
  assert(!result4.passed, "Fails with only tests + outcome");
  assert(result4.failures.length === 1, "One failure for missing acceptance: " + result4.failures.map(f => f.criterion).join(", "));
  assert(result4.failures[0].criterion === "acceptance_criteria", "Missing acceptance criteria");

  // Task with acceptance + outcome but no tests
  const result5 = validateTask("t5", "Create the auth service. Done when it returns a valid token.");
  assert(!result5.passed, "Fails with only acceptance + outcome");
  assert(result5.failures.length === 1, "One failure for missing tests");
});

// ── validatePlan: multi-task validation ──────────────────────────────────

testGroup("validatePlan: multi-task validation", () => {
  // All tasks pass
  const allPass = validatePlan([
    {
      name: "Phase 1",
      tasks: [
        { id: "t1", task: "Create src/Button.test.ts and Button.tsx. Done when: renders primary and click returns true." },
      ],
    },
  ]);
  assert(allPass.allPassed, "Plan passes when all tasks pass");
  assert(allPass.blockMessage === null, "No block message when all pass");
  assert(allPass.taskResults.length === 1, "One task result");
  assert(allPass.allFailures.length === 0, "No failures");

  // One task fails all three criteria
  const someFail = validatePlan([
    {
      name: "Phase 1",
      tasks: [
        { id: "t1", task: "do stuff" },
        { id: "t2", task: "Create Button.test.ts and Button.tsx. Done when: renders and click works." },
      ],
    },
  ]);
  assert(!someFail.allPassed, "Plan blocked when one task fails");
  assert(someFail.blockMessage !== null, "Block message present");
  assert(someFail.allFailures.length === 3, "3 failures from the one bad task: " + someFail.allFailures.map(f => f.criterion).join(", "));
  assert(someFail.taskResults[0].failures.length === 3, "First task has all 3 failures");
  assert(someFail.taskResults[1].failures.length === 0, "Second task has no failures");

  // Both tasks fail
  const allFail = validatePlan([
    {
      name: "Phase 1",
      tasks: [
        { id: "t1", task: "Build the thing" },
      ],
    },
  ]);
  assert(!allFail.allPassed, "Plan blocked when all tasks fail");
  assert(allFail.blockMessage !== null, "Block message present");
  assert(allFail.taskResults.length === 1, "One task result");
  assert(allFail.taskResults[0].failures.length === 3, "Task has 3 failures");
  assert(allFail.allFailures.length === 3, "Three total failures");
});

// ── enforceTestability: public API ───────────────────────────────────────

testGroup("enforceTestability: public API", () => {
  // Valid plan
  const valid = enforceTestability([
    {
      name: "Setup",
      tasks: [
        { id: "t1", task: "Create package.json. npm test verifies build. Done when package installs." },
      ],
    },
    {
      name: "Implementation",
      tasks: [
        { id: "t2", task: "Create src/index.tsx. Implement the main component. Add src/index.test.ts. Done when component renders." },
      ],
    },
  ]);
  assert(valid.allPassed, "Valid plan passes enforcement");
  assert(valid.blockMessage === null, "No block message for valid plan");
  assert(valid.taskResults.length === 2, "Two task results");

  // Invalid plan
  const invalid = enforceTestability([
    {
      name: "Setup",
      tasks: [
        { id: "t1", task: "Make the thing" },
      ],
    },
  ]);
  assert(!invalid.allPassed, "Invalid plan fails enforcement");
  assert(invalid.blockMessage !== null, "Block message present for invalid plan");
});

// ── Block message content verification ───────────────────────────────────

testGroup("Block message content", () => {
  const result = validatePlan([
    {
      name: "Bad Phase",
      tasks: [
        { id: "t1", task: "do stuff" },
      ],
    },
  ]);
  assert(result.blockMessage !== null, "Block message exists");
  assert(result.blockMessage!.includes("BLOCKED"), "Contains 'BLOCKED' keyword");
  assert(result.blockMessage!.includes("testability"), "Contains 'testability' reference");
  assert(result.blockMessage!.includes("test_files"), "References test_files criterion");
  assert(result.blockMessage!.includes("acceptance_criteria"), "References acceptance_criteria criterion");
  assert(result.blockMessage!.includes("measurable_outcome"), "References measurable_outcome criterion");
  assert(result.blockMessage!.includes("Fix"), "Contains fix instruction");
  assert(result.blockMessage!.includes("retry"), "Contains retry instruction");
});

// ── Edge cases ───────────────────────────────────────────────────────────

testGroup("Edge cases", () => {
  // Empty string task
  const empty = validateTask("e1", "");
  assert(!empty.passed, "Empty string fails all criteria");
  assert(empty.failures.length === 3, "Empty string: 3 failures");

  // Very short valid task
  const short = validateTask("s1", "Create file.md. npm test passes. Done when file exists.");
  assert(short.passed, "Short but complete task passes");

  // Long descriptive task without any criteria
  const longVague = validateTask(
    "lv1",
    "This is a very long description that talks a lot about building something great and making the system better overall for users who use the application on a daily basis and want to get things done quickly and efficiently without any problems or issues that could slow them down"
  );
  assert(!longVague.passed, "Long but vague task fails all criteria");
  assert(longVague.failures.length === 3, "Long vague task: 3 failures");

  // Task with all three criteria using different patterns
  const mixed = validateTask(
    "m1",
    "Create src/auth.test.ts — Run pytest for auth module. Done when: authentication returns valid JWT token for valid credentials. Output: auth service in src/auth.ts with export function login()."
  );
  assert(mixed.passed, "Mixed criteria patterns all pass");
  assert(mixed.failures.length === 0, "No failures for mixed valid criteria");
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`${"─".repeat(60)}`);
console.log(` Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(" ❌ Some tests failed");
  process.exit(1);
} else {
  console.log(" ✅ All tests passed!");
}
