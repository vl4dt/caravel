/**
 * Testability Enforcement Module
 *
 * Enforces testability criteria on every task before it enters the fleet.
 * Each task MUST have:
 *   (1) Test files or verification commands
 *   (2) Acceptance criteria
 *   (3) Measurable outcome
 *
 * When a task fails any criterion, plan_project() is BLOCKED and returns
 * a structured report with actionable suggestions for each missing item.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** A single criterion that failed validation. */
export interface CriterionFailure {
  /** Which criterion: "test_files" | "acceptance_criteria" | "measurable_outcome" */
  criterion: "test_files" | "acceptance_criteria" | "measurable_outcome";
  /** Human-readable description of what's missing */
  missing: string;
  /** Suggestion for how to fix it */
  suggestion: string;
}

/** Validation result for a single task. */
export interface TaskValidationResult {
  taskId: string;
  taskDescription: string;
  /** All failures for this task (empty = all criteria pass) */
  failures: CriterionFailure[];
  /** True when all criteria pass */
  passed: boolean;
}

/** Full validation result for a plan_project call. */
export interface PlanValidationResult {
  /** True when ALL tasks pass ALL criteria */
  allPassed: boolean;
  /** Per-task results */
  taskResults: TaskValidationResult[];
  /** All failures flattened across all tasks */
  allFailures: CriterionFailure[];
  /** A block message to show the user if blocked */
  blockMessage: string | null;
}

// ── Criterion 1: Test Files or Verification Commands ──────────────────────

/**
 * Checks whether a task description mentions test files, test commands,
 * verification commands, or explicit testing intent.
 */
export function hasTestsOrVerification(taskDescription: string): boolean {
  const lower = taskDescription.toLowerCase();

  // Explicit test file mentions
  const testFilePatterns = [
    /\.test\./, /_test\./, /\.spec\./, /test\//,
    "test_", "__tests__", "tests/", "tests\\",
    "create test", "write test", "add test", "implement test",
    "unit test", "integration test", "e2e test", "end-to-end test",
    "test file", "test case", "test suite",
  ];
  for (const pat of testFilePatterns) {
    if (typeof pat === "string") {
      if (lower.includes(pat)) return true;
    } else {
      if (pat.test(taskDescription)) return true;
    }
  }
  // Catch "tests" as a standalone word (e.g. "with tests", "needs tests")
  if (/(\b|with|needs|add|write|create)\s*tests?\b/i.test(taskDescription)) return true;
  for (const pat of testFilePatterns) {
    if (typeof pat === "string") {
      if (lower.includes(pat)) return true;
    } else {
      if (pat.test(taskDescription)) return true;
    }
  }

  // Verification / validation commands
  const verifPatterns = [
    "npm test", "yarn test", "pnpm test", "npx jest", "npx vitest",
    "npx mocha", "cargo test", "go test", "pytest", "make test",
    "run tests", "run verification", "execute test",
    "verify", "check", "assert", "validate",
    "--coverage", "--ci", "test --", "test/",
    "test command", "test script", "test runner",
  ];
  for (const pat of verifPatterns) {
    if (lower.includes(pat)) return true;
  }

  return false;
}

// ── Criterion 2: Acceptance Criteria ──────────────────────────────────────

/**
 * Checks whether a task description includes acceptance criteria.
 * Acceptance criteria are explicit conditions that define "done".
 */
export function hasAcceptanceCriteria(taskDescription: string): boolean {
  const lower = taskDescription.toLowerCase();

  // Explicit criterion markers
  const criterionPatterns = [
    "acceptance", "accept ", "done when", "definition of done",
    "must ", "should ", "shall ", "will ",
    "if and only if", "when .* then", "as long as",
    "given", "when.*then", "verify that", "ensure",
    "guarantee", "requirement", "condition",
    "expected .*:", "expected output", "expected behavior",
    "must .*:", "should .*:", "will .*:",
  ];
  for (const pat of criterionPatterns) {
    if (lower.includes(pat)) return true;
  }

  // List-like structures (bullet points, numbered lists, dashes)
  const listPatterns = [
    /^\s*[-*•]\s+\S.*:/m, // "- item: ..."
    /^\s*\d+\.\s+\S.*:/m, // "1. item: ..."
    /^\s*>\s+\S/m,        // "> item"
  ];
  for (const pat of listPatterns) {
    if (pat.test(taskDescription)) return true;
  }

  // Key-value style: "parameter: value" or "field: description"
  if (/: .{3,}$/.test(taskDescription.trim())) return true;

  return false;
}

// ── Criterion 3: Measurable Outcome ───────────────────────────────────────

/**
 * Checks whether a task description specifies a measurable outcome.
 * Measurable outcomes include file creation, output format, metrics,
 * performance bounds, or concrete deliverables.
 *
 * Generic verbs (create, build, add) alone are NOT sufficient — they
 * must be followed by a concrete target (file path, type, endpoint, etc).
 */
export function hasMeasurableOutcome(taskDescription: string): boolean {
  // File extension targets — concrete deliverables
  if (/\.(tsx?|js|ts|py|go|rs|html|css|scss|json|yaml|yml|md|sql|graphql)(\b|\s|$)/i.test(taskDescription)) return true;

  // Directory targets — concrete file locations
  if (/src\//i.test(taskDescription) || /lib\//i.test(taskDescription) || /dist\//i.test(taskDescription) || /migrations\//i.test(taskDescription)) return true;

  // Concrete file/directory name patterns
  if (/\b(create|add|write|generate|implement|build|generate|produce)\s+\S+\.(tsx?|js|ts|py|go|rs|html|css|scss|json|yaml|yml|md|sql|graphql)/i.test(taskDescription)) return true;

  // Numeric / quantitative outcomes
  if (/\d+\s*(%|ms|s|m|kb|mb|gb)/.test(taskDescription)) return true;
  if (/(less than|greater than|at most|at least|under |above |within )\s+\d/i.test(taskDescription)) return true;
  if (/(complexity|latency|throughput|memory|speed|duration|size|length|count|number)/i.test(taskDescription)) return true;

  // Output format markers
  if (/(return|output|result|response|status code|api endpoint|endpoint|route)/i.test(taskDescription)) return true;
  if (/(export|export default|function|class|interface|type|enum|const)\s+\w+/i.test(taskDescription)) return true;

  // Structured deliverable
  if (/\b(plan|document|report|spec|design|architecture|schema|config|interface|type)\b/i.test(taskDescription)) return true;

  // New file/component/module patterns — flexible: just need the keyword and a component type nearby
  if (/(\bcreate\b|\bnew\b)/i.test(taskDescription) && /(\bfile\b|\bcomponent\b|\bmodule\b|\bclass\b|\bfunction\b|\binterface\b|\btype\b|\bschema\b|\bendpoint\b|\broute\b)/i.test(taskDescription)) return true;

  return false;
}

// ── Validation Engine ─────────────────────────────────────────────────────

/**
 * Validate a single task against all three testability criteria.
 */
export function validateTask(
  taskId: string,
  taskDescription: string
): TaskValidationResult {
  const failures: CriterionFailure[] = [];

  // Criterion 1: Tests / verification
  if (!hasTestsOrVerification(taskDescription)) {
    failures.push({
      criterion: "test_files",
      missing: "No test files or verification commands mentioned",
      suggestion: "Add test-related language: 'Create src/component.test.ts', 'Run npm test', 'Include pytest for module X', or specify verification commands.",
    });
  }

  // Criterion 2: Acceptance criteria
  if (!hasAcceptanceCriteria(taskDescription)) {
    failures.push({
      criterion: "acceptance_criteria",
      missing: "No acceptance criteria or done conditions specified",
      suggestion: "Add done conditions: 'Done when: X works, Y passes, Z is created', 'Acceptance: component renders with props A, B, C', or use bullet lists with checkable items.",
    });
  }

  // Criterion 3: Measurable outcome
  if (!hasMeasurableOutcome(taskDescription)) {
    failures.push({
      criterion: "measurable_outcome",
      missing: "No measurable or concrete deliverable specified",
      suggestion: "Specify what concrete artifact will exist after: 'File X is created', 'Function Y returns Z', 'Endpoint /api/X responds with status 200', 'Component renders with props A and B'.",
    });
  }

  return {
    taskId,
    taskDescription,
    failures,
    passed: failures.length === 0,
  };
}

/**
 * Validate an entire plan_project call's tasks.
 * Returns a block message if any task fails.
 */
export function validatePlan(
  phases: Array<{ name: string; tasks: Array<{ id?: string; task: string }> }>
): PlanValidationResult {
  const taskResults: TaskValidationResult[] = [];
  const allFailures: CriterionFailure[] = [];

  let taskIdCounter = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      const id = task.id ?? `task-${taskIdCounter++}`;
      const result = validateTask(id, task.task);
      taskResults.push(result);
      allFailures.push(...result.failures);
    }
  }

  const allPassed = allFailures.length === 0;
  const blockMessage = allPassed
    ? null
    : buildBlockMessage(taskResults, allFailures);

  return {
    allPassed,
    taskResults,
    allFailures,
    blockMessage,
  };
}

// ── Block message builder ─────────────────────────────────────────────────

function buildBlockMessage(
  taskResults: TaskValidationResult[],
  allFailures: CriterionFailure[]
): string {
  const lines: string[] = [];
  lines.push("⛔ Task creation BLOCKED — testability enforcement");
  lines.push("");
  lines.push("Every task MUST have: (1) tests/verification, (2) acceptance criteria, (3) measurable outcome.");
  lines.push("");

  // Group failures by task
  const grouped = new Map<string, CriterionFailure[]>();
  for (const r of taskResults) {
    if (r.failures.length > 0) {
      grouped.set(r.taskDescription, r.failures);
    }
  }

  let taskIdx = 1;
  for (const [desc, failures] of grouped) {
    lines.push(`Task ${taskIdx}: "${truncate(desc, 60)}"`);
    for (const f of failures) {
      const icon = f.criterion === "test_files" ? "🧪" :
        f.criterion === "acceptance_criteria" ? "✅" : "📏";
      lines.push(`  ${icon} ${f.criterion}: ${f.missing}`);
      lines.push(`     → ${f.suggestion}`);
    }
    lines.push("");
    taskIdx++;
  }

  lines.push("Fix the tasks above and retry plan_project().");
  return lines.join("\n");
}

/** Truncate a string to maxLen characters with ellipsis. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// ── Exported validation entry point (called from caravel.ts plan_project) ─

/**
 * Validate phases and return null if all pass, or a block message if not.
 * This is the main API surface for integration into plan_project().
 */
export function enforceTestability(
  phases: Array<{ name: string; tasks: Array<{ id?: string; task: string }> }>
): PlanValidationResult {
  return validatePlan(phases);
}
