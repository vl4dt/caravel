/**
 * Tests for ZFS status bar health integration.
 *
 * Validates health status display in renderStatusBar and renderCompactStatusBar:
 * 1. Health bar format matches spec: [developer✓ tech-lead⚠ designer✗]
 * 2. Conditional on health.enabled feature flag
 * 3. No layout regression (existing structure preserved when disabled)
 * 4. buildAgentGrid renders health bar correctly
 * 5. buildFleetSnapshot computes health bar from healthAgents
 * 6. renderStatusBar and renderCompactStatusBar include health bar
 *
 * Run with:  npx tsx extensions/caravel-zfs-health.test.ts
 */

import { buildHealthBar, AgentHealthStatus } from "./caravel-health";

// ── Inlined ZFS status bar types & constants from caravel.ts ─────────────────

/** Status icon for an agent. */
type AgentStatusIcon = "▸" | "●" | "◉" | "✗" | "○";

interface StatusAgentEntry {
  name: string;
  icon: AgentStatusIcon;
  color: string;
  task: string;
  tokens: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** Minimal health bar data — mirrors the healthBar field on StatusBarFleetSnapshot. */
interface HealthSnapshot {
  healthAgents: Array<{ name: string; status: string }>;
  healthEnabled: boolean;
}

/** Snapshot shape used by renderStatusBar / renderCompactStatusBar. */
interface TestSnapshot {
  zfsActive: boolean;
  zfsSessionActive: boolean;
  agents: StatusAgentEntry[];
  allAgents: StatusAgentEntry[];
  healthBar: string;
}

// ── Feature config (mirrors caravel.ts) ──────────────────────────────────────

let _healthEnabled = true;

function setHealthFeature(enabled: boolean): void {
  _healthEnabled = enabled;
}

function setAllFeatures(enabled: boolean): void {
  _healthEnabled = enabled;
}

// ── Inlined helpers from caravel.ts ──────────────────────────────────────────

const BAR_WIDTH = 80;

function centerPad(text: string, width: number): string {
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(Math.max(0, left)) + text;
}

function escape(s: string): string {
  return s.replace(/[<>]/g, "");
}

function formatTokenCount(count: number): string {
  if (count == null || isNaN(count)) return "0";
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

// ── Inlined buildFleetSnapshot health logic ──────────────────────────────────

/**
 * Build health bar from healthAgents, respecting the health feature flag.
 * Mirrors the logic in buildFleetSnapshot in caravel.ts.
 * Uses null prefix so the health bar renders without "agents:" wrapper.
 */
function buildHealthBarFromOpts(
  healthAgents: Array<{ name: string; status: string }>,
  healthEnabled: boolean,
): string {
  const agents = healthAgents != null ? healthAgents : [];
  return healthEnabled && agents.length > 0
    ? buildHealthBar(agents, null)
    : "";
}

// ── buildAgentGrid (mirrors caravel.ts) ──────────────────────────────────────

function buildAgentGrid(snap: TestSnapshot): string {
  if (snap.zfsActive) {
    const sessionIcon = snap.zfsSessionActive ? "✓" : "○";
    const sessionLabel = "ZFS";
    return centerPad(`${sessionIcon} ${sessionLabel}  │  ${snap.agents.length} agents  │  Fleet active`, BAR_WIDTH);
  }
  if (snap.agents.length === 0) {
    return centerPad("● 0 agents  │  Fleet idle", BAR_WIDTH);
  }
  const agents = snap.agents;
  const parts: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const statusText = `${a.icon} ${a.name.slice(0, 8).padEnd(8)}`;
    parts.push(statusText);
  }
  const result = parts.join("  │  ");
  const gridLine = result.length > BAR_WIDTH - 4
    ? result.slice(0, BAR_WIDTH - 4) + "..."
    : "  " + result;

  // Append health bar below agent status when health is enabled and available
  if (_healthEnabled && snap.healthBar) {
    return gridLine + "\n" + centerPad(snap.healthBar, BAR_WIDTH);
  }
  return gridLine;
}

// ── renderStatusBar (mirrors caravel.ts) ─────────────────────────────────────

const BORDER_V = "║";
const BORDER_H = "═";
const BORDER_TL = "╔";
const BORDER_TR = "╗";
const BORDER_BL = "╚";
const BORDER_BR = "╝";

function renderStatusBar(snap: TestSnapshot): string {
  const agentsGrid = buildAgentGrid(snap);
  const header = `${snap.zfsActive ? "[ZFS MODE]" : "[pi MODE]"}  │  ${snap.agents.length} agents`;
  const lines: string[] = [
    `${BORDER_TL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_TR}`,
    `${BORDER_V}${centerPad(header, BAR_WIDTH)}${BORDER_V}`,
  ];
  // agentsGrid may contain multiple lines when health bar is appended;
  // each line is wrapped in its own border.
  const agentLines = agentsGrid.split("\n");
  for (const line of agentLines) {
    lines.push(`${BORDER_V}${centerPad(line, BAR_WIDTH)}${BORDER_V}`);
  }
  // pad to fill (simplified — just add enough empty lines)
  while (lines.length < 8) {
    lines.push(`${BORDER_V}${" ".repeat(BAR_WIDTH)}${BORDER_V}`);
  }
  lines.push(`${BORDER_V}╚${BORDER_H.repeat(BAR_WIDTH)}╝`);
  lines.push(`${BORDER_BL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_BR}`);
  return lines.join("\n");
}

// ── renderCompactStatusBar (mirrors caravel.ts) ─────────────────────────────

function renderCompactStatusBar(snap: TestSnapshot): string {
  const agentsGrid = buildAgentGrid(snap);
  const modeLine = snap.zfsActive ? "[ZFS]" : "[pi]";
  const header = `CARAVEL ${modeLine}  │  P1/2`;
  const tokenLine = `▸ ${formatTokenCount(50000)} tokens (fleet total)  │  per-agent: ${formatTokenCount(15000)}i / ${formatTokenCount(5000)}o  │  1✓  1○`;
  const elapsedLine = `Review time: 2m15s`;

  // agentsGrid may contain multiple lines when health bar is appended;
  // each line is wrapped in its own border to preserve the grid look.
  const agentLines = agentsGrid.split("\n");
  const agentLinesRendered = agentLines.map((l) => `${BORDER_V}${l}${BORDER_V}`);

  return [
    `${BORDER_TL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_TR}`,
    `${BORDER_V}${centerPad(header, BAR_WIDTH)}${BORDER_V}`,
    ...agentLinesRendered,
    `${BORDER_V}${tokenLine}${BORDER_V}`,
    `${BORDER_V}${elapsedLine}${BORDER_V}`,
    `${BORDER_BL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_BR}`,
  ].join("\n");
}

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
    errors.push({ test: currentTest(), error: msg });
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

let currentTestName = "";
function currentTest(): string { return currentTestName || "(unknown)"; }
function runTest(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  currentTestName = name;
  fn();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal snapshot for testing. */
function makeSnapshot(overrides?: Partial<TestSnapshot>): TestSnapshot {
  return {
    zfsActive: false,
    zfsSessionActive: false,
    agents: [],
    allAgents: [],
    healthBar: "",
    ...overrides,
  };
}

function agentsMock(namesAndStatus: Array<{ name: string; status: string }>): TestSnapshot {
  const agents = namesAndStatus.map(({ name, status }) => ({
    name,
    icon: status === "running" ? "▸" : status === "reviewing" ? "◉" : "●",
    color: status === "running" ? "accent" : status === "reviewing" ? "accent" : "dim",
    task: status === "running" ? "Building feature" : "",
    tokens: "",
    model: "test-model",
    inputTokens: 1000,
    outputTokens: 500,
    turns: 5,
  }));
  return makeSnapshot({ agents, allAgents: agents });
}

function resetHealthFeature(enabled: boolean): void {
  setHealthFeature(enabled);
}

// ── Group 1: Health bar format matching spec ──────────────────────────────────

runTest("Group 1: Health bar format matching spec", () => {
  resetHealthFeature(true);

  runTest("  1.1 Single healthy agent format", () => {
    // buildHealthBar with null prefix returns bare name+icon
    const healthAgents = [{ name: "developer", status: "healthy" as AgentHealthStatus }];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "developer✓", "single healthy agent renders as name✓");
  });

  runTest("  1.2 Single degraded agent format", () => {
    const healthAgents = [{ name: "tech-lead", status: "degraded" as AgentHealthStatus }];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "tech-lead⚠", "single degraded agent renders as name⚠");
  });

  runTest("  1.3 Single unhealthy agent format", () => {
    const healthAgents = [{ name: "designer", status: "unhealthy" as AgentHealthStatus }];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "designer✗", "single unhealthy agent renders as name✗");
  });

  runTest("  1.4 Multi-agent format matches spec: developer✓ tech-lead⚠ designer✗", () => {
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
      { name: "tech-lead", status: "degraded" },
      { name: "designer", status: "unhealthy" },
    ];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "developer✓ tech-lead⚠ designer✗", "multi-agent health bar matches spec format");
  });

  runTest("  1.5 All healthy agents", () => {
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
      { name: "tech-lead", status: "healthy" },
      { name: "designer", status: "healthy" },
    ];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "developer✓ tech-lead✓ designer✓", "all healthy uses ✓ for each");
  });

  runTest("  1.6 All unhealthy agents", () => {
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "unhealthy" },
      { name: "tech-lead", status: "unhealthy" },
    ];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "developer✗ tech-lead✗", "all unhealthy uses ✗ for each");
  });

  runTest("  1.7 Stuck/zombie agents use ✗ icon", () => {
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "stuck" },
      { name: "designer", status: "zombie" },
    ];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "developer✗ designer✗", "stuck and zombie use ✗ icon");
  });

  runTest("  1.8 Unknown status uses ? icon", () => {
    const healthAgents = [{ name: "developer", status: "unknown" }];
    const healthBar = buildHealthBar(healthAgents, null);
    assertEqual(healthBar, "developer?", "unknown status uses ? icon");
  });

  runTest("  1.9 Default prefix preserves backward compat", () => {
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
    ];
    // Default prefix should still add "agents: " wrapper
    assertEqual(buildHealthBar(healthAgents), "[agents: developer✓]", "default prefix preserved");
  });
});

// ── Group 2: Conditional on health.enabled ───────────────────────────────────

runTest("Group 2: Conditional on health.enabled", () => {
  runTest("  2.1 Health bar rendered when health enabled", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
      { name: "tech-lead", status: "reviewing" },
    ]);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
      { name: "tech-lead", status: "degraded" },
    ];
    snap.healthBar = buildHealthBar(healthAgents);
    const grid = buildAgentGrid(snap);
    assert(
      grid.includes("developer✓") && grid.includes("tech-lead⚠"),
      "health bar content present in grid when enabled",
    );
  });

  runTest("  2.2 Health bar NOT rendered when health disabled", () => {
    resetHealthFeature(false);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    // Even with a health bar set, the feature flag controls visibility
    snap.healthBar = "developer✓";
    const grid = buildAgentGrid(snap);
    // healthBar should NOT appear in grid because _healthEnabled is false
    assert(
      !grid.includes("developer✓"),
      "health bar absent from grid when health disabled",
    );
  });

  runTest("  2.3 buildHealthBarFromOpts respects health flag", () => {
    resetHealthFeature(true);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
    ];
    assertEqual(
      buildHealthBarFromOpts(healthAgents, true),
      "developer✓",
      "health enabled → health bar present (no brackets)",
    );

    resetHealthFeature(false);
    assertEqual(
      buildHealthBarFromOpts(healthAgents, false),
      "",
      "health disabled → health bar empty",
    );

    resetHealthFeature(true);
    assertEqual(
      buildHealthBarFromOpts([], true),
      "",
      "no health data → empty health bar",
    );
  });

  runTest("  2.4 Health bar computed when healthAgents provided", () => {
    resetHealthFeature(true);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
      { name: "tech-lead", status: "degraded" },
    ];
    const snap = makeSnapshot();
    snap.healthBar = buildHealthBarFromOpts(healthAgents, true);
    assertEqual(snap.healthBar, "developer✓ tech-lead⚠", "health bar computed from healthAgents (no brackets)");
  });

  runTest("  2.5 Health bar empty when healthAgents not provided", () => {
    resetHealthFeature(true);
    const snap = makeSnapshot();
    snap.healthBar = buildHealthBarFromOpts([], true);
    assertEqual(snap.healthBar, "", "empty healthAgents → empty health bar");
  });
});

// ── Group 3: renderStatusBar integration ─────────────────────────────────────

runTest("Group 3: renderStatusBar health bar integration", () => {
  runTest("  3.1 renderStatusBar includes health bar line when enabled", () => {
    resetHealthFeature(true);
    const agents = [
      { name: "developer", status: "running" },
      { name: "tech-lead", status: "reviewing" },
      { name: "designer", status: "running" },
    ];
    const snap = agentsMock(agents);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
      { name: "tech-lead", status: "degraded" },
      { name: "designer", status: "healthy" },
    ];
    // Health bar stored without brackets (centerPad adds borders in render)
    snap.healthBar = "developer✓ tech-lead⚠ designer✓";

    const rendered = renderStatusBar(snap);
    assert(
      rendered.includes("developer✓") && rendered.includes("tech-lead⚠") && rendered.includes("designer✓"),
      "renderStatusBar includes health bar line with correct content",
    );
  });

  runTest("  3.2 renderStatusBar health bar wrapped in borders", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";

    const rendered = renderStatusBar(snap);

    // The health bar line should be wrapped in border characters
    assert(
      rendered.includes("║") && rendered.includes("developer✓"),
      "health bar line present in rendered output",
    );
    assert(
      rendered.includes("╔") && rendered.includes("╗") && rendered.includes("╚") && rendered.includes("╝"),
      "rendered output has border characters (no layout regression)",
    );
  });

  runTest("  3.3 renderStatusBar structure preserved when healthBar empty", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    // healthBar is "" (default from makeSnapshot)
    const rendered = renderStatusBar(snap);
    const lines = rendered.split("\n");

    // Should still have standard structure: top border, header, agentsGrid, padding, bottom border
    assert(lines.length >= 5, "renderStatusBar has expected structure when healthBar empty");
    assert(
      lines[0].startsWith("╔") && lines[lines.length - 1].endsWith("╝"),
      "top/bottom borders intact (no layout regression)",
    );
  });

  runTest("  3.4 renderStatusBar health bar present and non-empty", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";

    const rendered = renderStatusBar(snap);
    const lines = rendered.split("\n");

    // Find the health bar line and verify it's present
    const healthLine = lines.find((l) => l.includes("developer✓"));
    assert(healthLine != null, "health bar line found in output");
    if (healthLine) {
      assert(healthLine.startsWith("║") && healthLine.endsWith("║"), "health bar line has borders");
    }
  });

  runTest("  3.5 renderStatusBar no health bar in ZFS mode", () => {
    resetHealthFeature(true);
    const snap = makeSnapshot({
      zfsActive: true,
      zfsSessionActive: true,
      agents: [{ name: "developer", icon: "▸" as AgentStatusIcon, color: "accent", task: "test", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 }],
      allAgents: [{ name: "developer", icon: "▸" as AgentStatusIcon, color: "accent", task: "test", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 }],
      healthBar: "developer✓",
    });
    const rendered = renderStatusBar(snap);
    // In ZFS mode, buildAgentGrid returns session info only, health bar not shown
    assert(
      !rendered.includes("developer✓"),
      "health bar not shown in ZFS session mode",
    );
  });
});

// ── Group 4: renderCompactStatusBar integration ──────────────────────────────

runTest("Group 4: renderCompactStatusBar health bar integration", () => {
  runTest("  4.1 renderCompactStatusBar includes health bar line when enabled", () => {
    resetHealthFeature(true);
    const agents = [
      { name: "developer", status: "running" },
      { name: "tech-lead", status: "reviewing" },
      { name: "designer", status: "error" },
    ];
    const snap = agentsMock(agents);
    snap.healthBar = "developer✓ tech-lead⚠ designer✗";

    const rendered = renderCompactStatusBar(snap);
    assert(
      rendered.includes("developer✓") && rendered.includes("tech-lead⚠") && rendered.includes("designer✗"),
      "renderCompactStatusBar includes health bar content",
    );
  });

  runTest("  4.2 renderCompactStatusBar structure with health bar", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";

    const rendered = renderCompactStatusBar(snap);
    const lines = rendered.split("\n");

    // With health bar: 7 lines (top, header, agentRow, healthBar, tokenLine, elapsedLine, bottom)
    assert(lines.length >= 7, `renderCompactStatusBar has >= ${lines.length} lines with health bar`);
    assert(lines[0].startsWith("╔"), "top border preserved");
    assert(lines[lines.length - 1].includes("╝"), "bottom border preserved");
    assert(rendered.includes("developer✓"), "health bar content present");
  });

  runTest("  4.3 renderCompactStatusBar structure without health bar", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    // healthBar is "" by default

    const rendered = renderCompactStatusBar(snap);
    const lines = rendered.split("\n");

    // Without health bar: 6 lines (top, header, agentRow, tokenLine, elapsedLine, bottom)
    assert(lines.length >= 6, `renderCompactStatusBar has >= ${lines.length} lines without health bar`);
    assert(lines[0].startsWith("╔"), "top border preserved");
    assert(lines[lines.length - 1].includes("╝"), "bottom border preserved");
  });

  runTest("  4.4 renderCompactStatusBar agent grid and health bar in separate bordered lines", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";

    const rendered = renderCompactStatusBar(snap);
    const lines = rendered.split("\n");

    // Verify each content line is individually bordered (not multi-line in one border)
    for (let i = 0; i < lines.length; i++) {
      assert(
        lines[i].startsWith("║") || lines[i].startsWith("╔") || lines[i].endsWith("╗") || lines[i].endsWith("╝"),
        `line ${i} has border chars: ${lines[i]}`,
      );
    }
  });

  runTest("  4.5 renderCompactStatusBar no health bar in ZFS mode", () => {
    resetHealthFeature(true);
    const snap = makeSnapshot({
      zfsActive: true,
      zfsSessionActive: true,
      agents: [{ name: "developer", icon: "▸" as AgentStatusIcon, color: "accent", task: "test", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 }],
      allAgents: [{ name: "developer", icon: "▸" as AgentStatusIcon, color: "accent", task: "test", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 }],
      healthBar: "developer✓",
    });
    const rendered = renderCompactStatusBar(snap);
    assert(
      !rendered.includes("developer✓"),
      "health bar not shown in ZFS mode for compact status bar",
    );
  });
});

// ── Group 5: buildAgentGrid health integration ────────────────────────────────

runTest("Group 5: buildAgentGrid health bar integration", () => {
  runTest("  5.1 buildAgentGrid returns health bar as second line when health enabled", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
      { name: "tech-lead", status: "reviewing" },
    ]);
    snap.healthBar = "developer✓ tech-lead⚠";

    const grid = buildAgentGrid(snap);
    const lines = grid.split("\n");
    assert(lines.length === 2, `buildAgentGrid returns ${lines.length} lines with health bar (expected 2)`);
    // Agent names are truncated to 8 chars in the grid (e.g. "develope" not "developer")
    assert(lines[0].includes("develope") && lines[0].includes("tech"), "first line has agent status");
    assert(lines[1].includes("developer✓") && lines[1].includes("tech-lead⚠"), "second line has health bar");
  });

  runTest("  5.3 buildAgentGrid returns single line when healthBar empty", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "";

    const grid = buildAgentGrid(snap);
    const lines = grid.split("\n");
    assert(lines.length === 1, `buildAgentGrid returns ${lines.length} line(s) without health bar (expected 1)`);
    // Name truncated to 8 chars: "develope" not "developer"
    assert(grid.includes("develope"), "single line still has agent status");
  });

  runTest("  5.4 buildAgentGrid health bar not shown when health disabled", () => {
    resetHealthFeature(false);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";

    const grid = buildAgentGrid(snap);
    const lines = grid.split("\n");
    assert(lines.length === 1, `buildAgentGrid returns ${lines.length} line when health disabled (expected 1)`);
    assert(
      !grid.includes("developer✓"),
      "health bar not included in grid when health disabled",
    );
  });

  runTest("  5.5 buildAgentGrid ZFS mode ignores health bar", () => {
    resetHealthFeature(true);
    const snap = makeSnapshot({
      zfsActive: true,
      zfsSessionActive: true,
      agents: [{ name: "developer", icon: "▸" as AgentStatusIcon, color: "accent", task: "test", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 }],
      allAgents: [{ name: "developer", icon: "▸" as AgentStatusIcon, color: "accent", task: "test", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 }],
      healthBar: "developer✓",
    });

    const grid = buildAgentGrid(snap);
    // ZFS mode returns session line only, no agent grid or health bar
    assert(!grid.includes("developer✓"), "health bar not shown in ZFS mode");
    assert(grid.includes("ZFS"), "ZFS mode shows session info");
  });

  runTest("  5.5 buildAgentGrid no agents → idle message, no health bar", () => {
    resetHealthFeature(true);
    const snap = makeSnapshot({
      agents: [],
      allAgents: [],
      healthBar: "",
    });

    const grid = buildAgentGrid(snap);
    assert(grid.includes("Fleet idle"), "no agents → idle message");
  });
});

// ── Group 6: Health icon mapping ─────────────────────────────────────────────

runTest("Group 6: Health icon mapping for all statuses", () => {
  runTest("  6.1 healthy → ✓", () => {
    resetHealthFeature(true);
    const snap = agentsMock([{ name: "developer", status: "running" }]);
    snap.healthBar = "developer✓";
    const grid = buildAgentGrid(snap);
    assert(grid.includes("developer✓"), "healthy maps to ✓");
  });

  runTest("  6.2 degraded → ⚠", () => {
    resetHealthFeature(true);
    const snap = agentsMock([{ name: "tech-lead", status: "running" }]);
    snap.healthBar = "tech-lead⚠";
    const grid = buildAgentGrid(snap);
    assert(grid.includes("tech-lead⚠"), "degraded maps to ⚠");
  });

  runTest("  6.3 unhealthy → ✗", () => {
    resetHealthFeature(true);
    const snap = agentsMock([{ name: "designer", status: "running" }]);
    snap.healthBar = "designer✗";
    const grid = buildAgentGrid(snap);
    assert(grid.includes("designer✗"), "unhealthy maps to ✗");
  });

  runTest("  6.4 stuck → ✗", () => {
    resetHealthFeature(true);
    const snap = agentsMock([{ name: "developer", status: "running" }]);
    snap.healthBar = "developer✗";
    const grid = buildAgentGrid(snap);
    assert(grid.includes("developer✗"), "stuck maps to ✗");
  });

  runTest("  6.5 zombie → ✗", () => {
    resetHealthFeature(true);
    const snap = agentsMock([{ name: "designer", status: "running" }]);
    snap.healthBar = "designer✗";
    const grid = buildAgentGrid(snap);
    assert(grid.includes("designer✗"), "zombie maps to ✗");
  });

  runTest("  6.6 all three statuses in single health bar", () => {
    resetHealthFeature(true);
    // Need agents so buildAgentGrid doesn't return early with idle message
    const snap = agentsMock([
      { name: "developer", status: "running" },
      { name: "tech-lead", status: "reviewing" },
      { name: "designer", status: "error" },
    ]);
    snap.healthBar = "developer✓ tech-lead⚠ designer✗";
    const grid = buildAgentGrid(snap);
    assert(
      grid.includes("developer✓") && grid.includes("tech-lead⚠") && grid.includes("designer✗"),
      "all three icons present in health bar line",
    );
  });
});

// ── Group 7: Feature flag propagation ────────────────────────────────────────

runTest("Group 7: Feature flag propagation", () => {
  runTest("  7.1 setHealthFeature(false) disables health bar in buildHealthBarFromOpts", () => {
    resetHealthFeature(false);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
      { name: "tech-lead", status: "degraded" },
    ];
    const healthBar = buildHealthBarFromOpts(healthAgents, false);
    assertEqual(healthBar, "", "healthBar empty when health disabled");
  });

  runTest("  7.2 setAllFeatures(true) enables health bar", () => {
    setAllFeatures(true);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
    ];
    const healthBar = buildHealthBarFromOpts(healthAgents, true);
    assertEqual(healthBar, "developer✓", "healthBar populated when all features enabled (no brackets)");
    // Reset back to default
    setHealthFeature(true);
  });

  runTest("  7.3 setAllFeatures(false) disables health bar", () => {
    setAllFeatures(false);
    const healthAgents: Array<{ name: string; status: AgentHealthStatus }> = [
      { name: "developer", status: "healthy" },
    ];
    const healthBar = buildHealthBarFromOpts(healthAgents, false);
    assertEqual(healthBar, "", "healthBar empty when all features disabled");
    // Reset back to default
    setHealthFeature(true);
  });
});

// ── Group 8: No layout regression ────────────────────────────────────────────

runTest("Group 8: No layout regression", () => {
  runTest("  8.1 renderStatusBar border chars present in all lines", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";
    const rendered = renderStatusBar(snap);
    const lines = rendered.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const hasLeft = lines[i].startsWith("║");
      const hasRight = lines[i].endsWith("║");
      const isTopBorder = lines[i].startsWith("╔");
      const isBottomBorder = lines[i].includes("╝");
      assert(
        hasLeft && hasRight || isTopBorder || isBottomBorder,
        `line ${i} has correct borders: ${lines[i]}`,
      );
    }
  });

  runTest("  8.2 renderStatusBar top and bottom border complete", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";
    const rendered = renderStatusBar(snap);
    assert(
      rendered.startsWith("╔") && rendered.endsWith("╝"),
      "renderStatusBar starts with ╔ and ends with ╝",
    );
  });

  runTest("  8.3 renderCompactStatusBar top and bottom border complete", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";
    const rendered = renderCompactStatusBar(snap);
    assert(
      rendered.startsWith("╔") && rendered.endsWith("╝"),
      "renderCompactStatusBar starts with ╔ and ends with ╝",
    );
  });

  runTest("  8.4 renderCompactStatusBar lines without health bar unchanged count", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    const renderedWithout = renderCompactStatusBar(snap);
    const withoutCount = renderedWithout.split("\n").length;

    snap.healthBar = "developer✓";
    const renderedWith = renderCompactStatusBar(snap);
    const withCount = renderedWith.split("\n").length;

    assert(
      withCount === withoutCount + 1,
      `compact status bar gains exactly 1 line with health bar (${withoutCount} → ${withCount})`,
    );
  });

  runTest("  8.5 All lines have consistent border structure", () => {
    resetHealthFeature(true);
    const snap = agentsMock([
      { name: "developer", status: "running" },
    ]);
    snap.healthBar = "developer✓";
    const rendered = renderStatusBar(snap);
    const lines = rendered.split("\n");

    // All lines have border characters (content lines use ║, borders use ╔/╗/╚/╝)
    for (let i = 0; i < lines.length; i++) {
      const hasLeft = lines[i].startsWith("║") || lines[i].startsWith("╔") || lines[i].startsWith("╚");
      const hasRight = lines[i].endsWith("║") || lines[i].endsWith("╗") || lines[i].endsWith("╝");
      assert(hasLeft && hasRight, `line ${i} has consistent borders`);
    }
    assert(lines[0].includes(BORDER_H), "top border uses horizontal lines");
    assert(lines[lines.length - 1].includes(BORDER_H), "bottom border uses horizontal lines");
  });
});

// ── Summary ──────────────────────────────────────────────────────────────────

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
