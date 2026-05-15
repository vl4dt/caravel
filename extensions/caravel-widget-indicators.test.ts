/**
 * Tests for caravel-widget-indicators module.
 *
 * Test groups:
 * 1. buildMessagingIndicators — enabled/disabled, various counts
 * 2. formatIndicatorLine — formatting and color application
 * 3. Conditional rendering — enabled vs disabled, zero counts
 * 4. Edge cases — large counts, pluralization, disabled overrides
 * 5. setMessagingCounts — module-level state management
 * 6. Integration — buildWidgetLines integration (mocked)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  buildMessagingIndicators,
  formatIndicatorLine,
  setMessagingCounts,
  createMockTheme,
  MessagingIndicatorConfig,
  IndicatorEntry,
} from "./caravel-widget-indicators";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let errors: Array<{ test: string; error: string }> = [];

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    errors.push({ test: currentTest(), error: `ASSERT: ${msg}` });
    console.error(`  ✗ ${msg}`);
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

// ── Helper: create a default config ──────────────────────────────────────────

function defaultConfig(overrides?: Partial<MessagingIndicatorConfig>): MessagingIndicatorConfig {
  return {
    enabled: true,
    unread: 0,
    escalations: 0,
    ...overrides,
  };
}

// ── Group 1: buildMessagingIndicators ─────────────────────────────────────────

runTest("Group 1: buildMessagingIndicators", () => {
  runTest("  1.1 Returns empty array when disabled", () => {
    const indicators = buildMessagingIndicators({ enabled: false, unread: 5, escalations: 2 });
    assertEqual(indicators.length, 0, "empty array when disabled");
  });

  runTest("  1.2 Returns empty array when enabled but no counts", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 0 });
    assertEqual(indicators.length, 0, "empty array when no counts");
  });

  runTest("  1.3 Returns single unread indicator", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 0 });
    assertEqual(indicators.length, 1, "1 indicator for 3 unread");
    assertEqual(indicators[0].text, "[3 unread]", "text is '[3 unread]'");
    assertEqual(indicators[0].color, "success", "color is 'success'");
  });

  runTest("  1.4 Returns single escalation indicator", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 1 });
    assertEqual(indicators.length, 1, "1 indicator for 1 escalation");
    assertEqual(indicators[0].text, "[1 escalation]", "text is '[1 escalation]' (singular)");
    assertEqual(indicators[0].color, "warning", "color is 'warning'");
  });

  runTest("  1.5 Returns plural escalation indicator", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 3 });
    assertEqual(indicators.length, 1, "1 indicator for 3 escalations");
    assertEqual(indicators[0].text, "[3 escalations]", "text is '[3 escalations]' (plural)");
    assertEqual(indicators[0].color, "warning", "color is 'warning'");
  });

  runTest("  1.6 Returns both indicators when both counts > 0", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 1 });
    assertEqual(indicators.length, 2, "2 indicators for 3 unread + 1 escalation");
    assertEqual(indicators[0].text, "[3 unread]", "first indicator is unread");
    assertEqual(indicators[0].color, "success", "unread color is 'success'");
    assertEqual(indicators[1].text, "[1 escalation]", "second indicator is escalation");
    assertEqual(indicators[1].color, "warning", "escalation color is 'warning'");
  });

  runTest("  1.7 Unread indicator uses singular when count is 1", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 1, escalations: 0 });
    assertEqual(indicators[0].text, "[1 unread]", "text is '[1 unread]' (singular)");
  });

  runTest("  1.8 Both indicators use correct pluralization", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 2, escalations: 3 });
    assertEqual(indicators[0].text, "[2 unread]", "unread uses plural");
    assertEqual(indicators[1].text, "[3 escalations]", "escalation uses plural");
  });

  runTest("  1.9 Large counts render correctly", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 42, escalations: 7 });
    assertEqual(indicators[0].text, "[42 unread]", "large unread count renders");
    assertEqual(indicators[1].text, "[7 escalations]", "large escalation count renders");
  });

  runTest("  1.10 Zero counts produce no indicators even when enabled", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 0 });
    assertEqual(indicators.length, 0, "zero counts → no indicators");
  });

  runTest("  1.11 Negative counts treated as zero (no indicators)", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: -5, escalations: -2 });
    assertEqual(indicators.length, 0, "negative counts produce no indicators");
  });
});

// ── Group 2: formatIndicatorLine ──────────────────────────────────────────────

runTest("Group 2: formatIndicatorLine", () => {
  const theme = createMockTheme();

  runTest("  2.1 Returns empty string for empty array", () => {
    const result = formatIndicatorLine([], theme);
    assertEqual(result, "", "empty array → empty string");
  });

  runTest("  2.2 Formats single indicator with color", () => {
    const entries: IndicatorEntry[] = [{ text: "[3 unread]", color: "success" }];
    const result = formatIndicatorLine(entries, theme);
    assertEqual(result, "  [3 unread]", "single indicator formatted with leading space");
    assertEqual(theme.lastColor, "success", "theme color set to 'success'");
    assertEqual(theme.lastText, "[3 unread]", "theme text set to indicator text");
  });

  runTest("  2.3 Formats multiple indicators with separator", () => {
    const entries: IndicatorEntry[] = [
      { text: "[3 unread]", color: "success" },
      { text: "[1 escalation]", color: "warning" },
    ];
    const result = formatIndicatorLine(entries, theme);
    assert(
      result.includes("[3 unread]") && result.includes("[1 escalation]"),
      "both indicators present in formatted string",
    );
    assert(
      result.includes("·") || result.includes("·"),
      "separator present between indicators",
    );
  });

  runTest("  2.4 Leading space ensures visual separation from widget content", () => {
    const entries: IndicatorEntry[] = [{ text: "[5 unread]", color: "success" }];
    const result = formatIndicatorLine(entries, theme);
    assert(result.startsWith("  "), "starts with two spaces for widget bar padding");
  });
});

// ── Group 3: Conditional rendering ────────────────────────────────────────────

runTest("Group 3: Conditional rendering", () => {
  const theme = createMockTheme();

  runTest("  3.1 Disabled feature → no indicators regardless of counts", () => {
    const indicators = buildMessagingIndicators({ enabled: false, unread: 10, escalations: 5 });
    assertEqual(indicators.length, 0, "disabled feature → empty indicators");
  });

  runTest("  3.2 Enabled feature with counts → indicators shown", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 1 });
    assertEqual(indicators.length, 2, "enabled + counts → indicators rendered");
  });

  runTest("  3.3 Enabled feature with zero counts → no indicators", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 0 });
    assertEqual(indicators.length, 0, "enabled + zero counts → no indicators");
  });

  runTest("  3.4 Only unread indicator when no escalations", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 0 });
    assertEqual(indicators.length, 1, "only unread indicator");
    assertEqual(indicators[0].text, "[3 unread]", "unread text correct");
  });

  runTest("  3.5 Only escalation indicator when no unread", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 2 });
    assertEqual(indicators.length, 1, "only escalation indicator");
    assertEqual(indicators[0].text, "[2 escalations]", "escalation text correct");
  });

  runTest("  3.6 Widget bar integration: indicator line only when messaging enabled", () => {
    // Simulate the widget bar logic
    const disabledIndicators = buildMessagingIndicators({ enabled: false, unread: 3, escalations: 1 });
    const disabledLine = formatIndicatorLine(disabledIndicators, theme);
    assertEqual(disabledLine, "", "disabled → empty line (no rendering)");

    const enabledIndicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 1 });
    const enabledLine = formatIndicatorLine(enabledIndicators, theme);
    assertNotEqual(enabledLine, "", "enabled + counts → non-empty line");
  });

  function assertNotEqual(actual: unknown, expected: unknown, msg: string): void {
    if (actual !== expected) {
      passed++;
      console.log(`  ✓ ${msg}`);
    } else {
      failed++;
      errors.push({ test: currentTest(), error: `EXPECTED NOT EQUAL ${expected} GOT ${actual}: ${msg}` });
      console.error(`  ✗ ${msg} (expected NOT equal, but got equal)`);
    }
  }
});

// ── Group 4: Edge cases ──────────────────────────────────────────────────────

runTest("Group 4: Edge cases", () => {
  runTest("  4.1 Exactly 1 escalation uses singular", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 1 });
    assertEqual(indicators[0].text, "[1 escalation]", "singular 'escalation'");
  });

  runTest("  4.2 Exactly 2 escalations use plural", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 2 });
    assertEqual(indicators[0].text, "[2 escalations]", "plural 'escalations'");
  });

  runTest("  4.3 Exactly 1 unread uses singular", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 1, escalations: 0 });
    assertEqual(indicators[0].text, "[1 unread]", "singular 'unread'");
  });

  runTest("  4.4 Exactly 2 unread use plural", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 2, escalations: 0 });
    assertEqual(indicators[0].text, "[2 unread]", "'unread' is invariant (no plural form)");
  });

  runTest("  4.5 Order: unread always before escalation", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 1, escalations: 1 });
    assert(indicators[0].text.includes("unread"), "first indicator is unread");
    assert(indicators[1].text.includes("escalation"), "second indicator is escalation");
  });

  runTest("  4.6 Indicators disabled override module-level counts", () => {
    // Even if module-level counts are non-zero, disabled feature returns empty
    const indicators = buildMessagingIndicators({ enabled: false, unread: 99, escalations: 99 });
    assertEqual(indicators.length, 0, "disabled overrides counts");
  });

  runTest("  4.7 Undefined unread falls back to module-level", () => {
    // Set module-level count
    setMessagingCounts({ unread: 7, escalations: 0 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators[0].text, "[7 unread]", "falls back to module-level unread");
  });

  runTest("  4.8 Undefined escalations falls back to module-level", () => {
    setMessagingCounts({ unread: 0, escalations: 4 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators[0].text, "[4 escalations]", "falls back to module-level escalations");
  });

  runTest("  4.9 Explicit counts override module-level", () => {
    setMessagingCounts({ unread: 999, escalations: 999 });
    const indicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 1 });
    assertEqual(indicators[0].text, "[3 unread]", "explicit unread overrides module-level");
    assertEqual(indicators[1].text, "[1 escalation]", "explicit escalation overrides module-level");
  });
});

// ── Group 5: setMessagingCounts ───────────────────────────────────────────────

runTest("Group 5: setMessagingCounts", () => {
  runTest("  5.1 Sets module-level unread count", () => {
    setMessagingCounts({ unread: 5, escalations: 0 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators[0].text, "[5 unread]", "unread count set correctly");
  });

  runTest("  5.2 Sets module-level escalation count", () => {
    setMessagingCounts({ unread: 0, escalations: 3 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators[0].text, "[3 escalations]", "escalation count set correctly");
  });

  runTest("  5.3 Sets both counts simultaneously", () => {
    setMessagingCounts({ unread: 3, escalations: 1 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators.length, 2, "both counts set");
    assertEqual(indicators[0].text, "[3 unread]", "unread count correct");
    assertEqual(indicators[1].text, "[1 escalation]", "escalation count correct");
  });

  runTest("  5.4 Negative counts clamped to zero (no indicators)", () => {
    setMessagingCounts({ unread: -10, escalations: -5 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators.length, 0, "negative counts → no indicators");
  });

  runTest("  5.5 Zero counts produces no indicators", () => {
    setMessagingCounts({ unread: 0, escalations: 0 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators.length, 0, "zero counts → no indicators");
  });

  runTest("  5.6 Large counts work correctly", () => {
    setMessagingCounts({ unread: 100, escalations: 42 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators.length, 2, "large counts produce 2 indicators");
    assertEqual(indicators[0].text, "[100 unread]", "large unread count");
    assertEqual(indicators[1].text, "[42 escalations]", "large escalation count");
  });

  runTest("  5.7 Multiple setMessagingCounts calls are idempotent for same values", () => {
    setMessagingCounts({ unread: 3, escalations: 1 });
    const indicators1 = buildMessagingIndicators({ enabled: true });
    setMessagingCounts({ unread: 3, escalations: 1 });
    const indicators2 = buildMessagingIndicators({ enabled: true });
    assertEqual(indicators1.length, indicators2.length, "same length after repeated set");
    assertEqual(indicators1[0].text, indicators2[0].text, "same unread text");
    assertEqual(indicators1[1].text, indicators2[1].text, "same escalation text");
  });
});

// ── Group 6: Integration with widget bar ──────────────────────────────────────

runTest("Group 6: Widget bar integration", () => {
  const theme = createMockTheme();

  runTest("  6.1 Widget bar shows indicators when messaging enabled + counts > 0", () => {
    setMessagingCounts({ unread: 3, escalations: 1 });
    const indicators = buildMessagingIndicators({ enabled: true });
    const line = formatIndicatorLine(indicators, theme);
    assert(line.length > 0, "indicator line is non-empty");
    assert(line.includes("[3 unread]"), "unread count in line");
    assert(line.includes("[1 escalation]"), "escalation count in line");
  });

  runTest("  6.2 Widget bar hides indicators when messaging disabled", () => {
    setMessagingCounts({ unread: 3, escalations: 1 });
    const indicators = buildMessagingIndicators({ enabled: false });
    const line = formatIndicatorLine(indicators, theme);
    assertEqual(line, "", "disabled → empty line");
  });

  runTest("  6.3 Widget bar shows no indicators when counts are zero", () => {
    setMessagingCounts({ unread: 0, escalations: 0 });
    const indicators = buildMessagingIndicators({ enabled: true });
    const line = formatIndicatorLine(indicators, theme);
    assertEqual(line, "", "zero counts → empty line");
  });

  runTest("  6.4 Only unread shown when no escalations", () => {
    setMessagingCounts({ unread: 5, escalations: 0 });
    const indicators = buildMessagingIndicators({ enabled: true });
    const line = formatIndicatorLine(indicators, theme);
    assert(line.includes("[5 unread]"), "unread in line");
    assert(!line.includes("escalation"), "no escalation in line");
  });

  runTest("  6.5 Only escalation shown when no unread", () => {
    setMessagingCounts({ unread: 0, escalations: 2 });
    const indicators = buildMessagingIndicators({ enabled: true });
    const line = formatIndicatorLine(indicators, theme);
    assert(line.includes("[2 escalations]"), "escalation in line");
    assert(!line.includes("unread"), "no unread in line");
  });

  runTest("  6.6 Indicator order is stable: unread first, escalation second", () => {
    setMessagingCounts({ unread: 3, escalations: 1 });
    const indicators = buildMessagingIndicators({ enabled: true });
    assert(indicators.length >= 2, "at least 2 indicators");
    assert(
      indicators.findIndex((i) => i.text.includes("unread")) <
        indicators.findIndex((i) => i.text.includes("escalation")),
      "unread appears before escalation",
    );
  });
});

// ── Group 7: Color consistency ────────────────────────────────────────────────

runTest("Group 7: Color consistency", () => {
  runTest("  7.1 Unread indicator always uses 'success' color", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 1, escalations: 0 });
    assertEqual(indicators[0].color, "success", "unread uses 'success' color");
  });

  runTest("  7.2 Escalation indicator always uses 'warning' color", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 0, escalations: 1 });
    assertEqual(indicators[0].color, "warning", "escalation uses 'warning' color");
  });

  runTest("  7.3 Combined indicators have correct color assignment", () => {
    const indicators = buildMessagingIndicators({ enabled: true, unread: 3, escalations: 2 });
    assertEqual(indicators[0].color, "success", "unread uses 'success'");
    assertEqual(indicators[1].color, "warning", "escalation uses 'warning'");
  });

  runTest("  7.4 Mock theme captures color correctly", () => {
    const mock = createMockTheme();
    mock.fg("success", "[test]");
    assertEqual(mock.lastColor, "success", "mock captures color");
    assertEqual(mock.lastText, "[test]", "mock captures text");
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`${"─".repeat(60)}`);
console.log(` Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(" ❌ Some tests failed:");
  for (const e of errors) {
    console.error(`    ${e.test}: ${e.error}`);
  }
  process.exit(1);
} else {
  console.log(" ✅ All tests passed!");
}
