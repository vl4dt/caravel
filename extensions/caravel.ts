/**
 * Caravel Fleet Orchestrator
 *
 * Multi-agent fleet orchestration with supervisor-worker pattern, two-stage review loops.
 * Works with any model provider (local or cloud).
 *
 * UI:
 *   - Fleet status: persistent 3-line widget bar above the editor
 *   - Line 1: CARAVEL FLEET | <status> | progress | agents | elapsed
 *   - Line 2: reviews: passed N / failed N | last: <action>
 *   - Line 3: agent lights: [●] name │ tokens │ status/task
 *   - Agent lights turn on (bright ●) when active, dim (●) when idle
 *   - /caravel-fleet command: toggle the widget bar visibility
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  theme,
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  truncateToWidth,
  matchesKey,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentIdentity } from "./caravel-identity";
import { buildHealthBar, buildHealthBarFromFleet } from "./caravel-health";
import { buildMessagingIndicators, formatIndicatorLine, setMessagingCounts as setMessagingCountsInternal } from "./caravel-widget-indicators";
import { recordTerminatedAgent, getSeanceRecordsForTask, generateRecoveryContext } from "./caravel-seance";
import { startPeriodicCheckpointing, stopPeriodicCheckpointing } from "./caravel-checkpoints";
import { startHealthChecks, stopHealthChecks } from "./caravel-health";
import { saveCheckpoint } from "./caravel-checkpoints";

// ============================================================================
// Feature Configuration ──────────────────────────────────────────────────────
//
// All feature hooks in runPhaseInternal are gated by this config object.
// Each flag controls one or more integration hooks.  Set via the
// corresponding `set*` functions below.
// ===========================================================================

/** Feature config for all Caravel integration hooks. */
interface FeatureConfig {
  /** Enable/disable health monitoring (health-check interval during tasks). */
  health: boolean;
  /** Enable/disable periodic checkpointing (periodic save of agent checkpoints during tasks). */
  periodicCheckpoint: boolean;
  /** Enable/disable seance (session) recording on task completion/failure. */
  seance: boolean;
  /** Enable/disable checkpoint loading on task retry (inject recovered context). */
  checkpoint: boolean;
  /** Enable/disable agent identity resolution at task start. */
  identity: boolean;
  /** Enable/disable messaging indicators in the widget bar. */
  messaging: boolean;
}

const defaultFeatureConfig: FeatureConfig = {
  health: true,
  periodicCheckpoint: true,
  seance: true,
  checkpoint: true,
  identity: true,
  messaging: false,
};

let featureConfig: FeatureConfig = { ...defaultFeatureConfig };

/** Enable or disable all features at once. */
export function setAllFeatures(enabled: boolean): void {
  featureConfig.health = enabled;
  featureConfig.periodicCheckpoint = enabled;
  featureConfig.seance = enabled;
  featureConfig.checkpoint = enabled;
  featureConfig.identity = enabled;
  featureConfig.messaging = enabled;
}

/** Get a deep copy of the current feature configuration. */
export function getFeatureConfig(): FeatureConfig {
  return { ...featureConfig };
}

/** Update individual feature flags. */
export function setHealthFeature(enabled: boolean): void {
  featureConfig.health = enabled;
}

export function setPeriodicCheckpointFeature(enabled: boolean): void {
  featureConfig.periodicCheckpoint = enabled;
}

/**
 * Enable or disable session history recording.
 * This is an alias for setSeanceFeature (seance = session history).
 */
export function setHistoryEnabled(ctx: ExtensionContext, enabled: boolean): void {
  setSeanceFeature(enabled);
  if (ctx.hasUI) {
    refreshWidget(ctx);
  }
}

/** Check if session history recording is enabled. */
export function isHistoryEnabled(): boolean {
  return featureConfig.seance;
}

/** Enable or disable seance (session) recording on task completion/failure. */
export function setSeanceFeature(enabled: boolean): void {
  featureConfig.seance = enabled;
}

export function isSeanceFeatureEnabled(): boolean {
  return featureConfig.seance;
}

/** Enable or disable checkpoint loading on task retry. */
export function setCheckpointFeature(enabled: boolean): void {
  featureConfig.checkpoint = enabled;
}

export function isCheckpointFeatureEnabled(): boolean {
  return featureConfig.checkpoint;
}

/** Enable or disable agent identity resolution at task start. */
export function setIdentityFeature(enabled: boolean): void {
  featureConfig.identity = enabled;
}

export function isIdentityFeatureEnabled(): boolean {
  return featureConfig.identity;
}

/** Enable or disable the messaging feature (controls widget bar indicators). */
export function setMessagingEnabled(ctx: ExtensionContext, enabled: boolean): void {
  featureConfig.messaging = enabled;
  if (ctx.hasUI) {
    refreshWidget(ctx);
  }
}

/** Check if messaging is enabled. */
export function isMessagingEnabled(): boolean {
  return featureConfig.messaging;
}

/**
 * Set the current messaging counts for the widget bar.
 * Call this each refresh cycle with live counts from the messaging subsystem.
 */
export function setMessagingCounts(unread: number, escalations: number): void {
  setMessagingCountsInternal({ unread, escalations });
}

/**
 * Enable or disable messaging indicators in the widget bar.
 *
 * @param enabled   - true to show unread/escalation counts in the widget bar
 * @param ctx       - ExtensionContext for UI refresh (optional)
 */
export function toggleMessaging(ctx?: ExtensionContext): void {
  featureConfig.messaging = !featureConfig.messaging;
  if (ctx?.hasUI) {
    refreshWidget(ctx);
    ctx.ui.notify(`Messaging indicators ${featureConfig.messaging ? "enabled" : "disabled"}`, "info");
  }
}

// ============================================================================
// Feature Hooks Tracking ──────────────────────────────────────────────────────
//
// Module-level state for tracking which hooks were invoked.  Used by tests
// to verify that each hook fires at the right time with the correct config.
// ===========================================================================

/** Tracks which integration hooks were invoked and their config state. */
export interface FeatureHooksSnapshot {
  /** Hook 1 (Phase start): config loaded, features initialized. */
  phaseStarted: boolean;
  /** Hook 2 (Task start): identity resolved, periodic checkpointing started. */
  taskStarted: boolean;
  /** Hook 3 (Task progress): health check triggered. */
  healthCheckRun: boolean;
  /** Hook 4 (Task complete): seance recorded, checkpoint saved. */
  taskCompleted: boolean;
  /** Hook 5 (Task retry): seance context injected. */
  taskRetryInjected: boolean;
  /** Hook 6 (Phase end): health checks stopped, periodic checkpointing stopped. */
  phaseEnded: boolean;
  /** Feature config state at the time each hook fired. */
  configSnapshot: FeatureConfig;
}

/** The latest hooks snapshot.  Reset between test runs. */
let _hooksSnapshot: FeatureHooksSnapshot | null = null;

/** Reset the hooks snapshot to initial state (called between test runs). */
export function resetHooksSnapshot(): void {
  _hooksSnapshot = {
    phaseStarted: false,
    taskStarted: false,
    healthCheckRun: false,
    taskCompleted: false,
    taskRetryInjected: false,
    phaseEnded: false,
    configSnapshot: getFeatureConfig(),
  };
}

/** Get a copy of the current hooks snapshot. Returns null if never captured. */
export function getHooksSnapshot(): FeatureHooksSnapshot | null {
  return _hooksSnapshot ? { ..._hooksSnapshot } : null;
}

/** Check whether hooks snapshot has been captured. */
export function hasHooksSnapshot(): boolean {
  return _hooksSnapshot !== null;
}

// ============================================================================
// Inline: Testability Enforcement Module ──────────────────────────────────────

interface CriterionFailure {
  criterion: "test_files" | "acceptance_criteria" | "measurable_outcome";
  missing: string;
  suggestion: string;
}

interface TaskValidationResult {
  taskId: string;
  taskDescription: string;
  failures: CriterionFailure[];
  passed: boolean;
}

interface PlanValidationResult {
  allPassed: boolean;
  taskResults: TaskValidationResult[];
  allFailures: CriterionFailure[];
  blockMessage: string | null;
}

function enforceTestability(
  phases: Array<{ name: string; tasks: Array<{ id?: string; task: string }> }>
): PlanValidationResult {
  const taskResults: TaskValidationResult[] = [];
  const allFailures: CriterionFailure[] = [];
  let taskIdCounter = 0;

  function hasTestsOrVerification(desc: string): boolean {
    const lower = desc.toLowerCase();
    const testFilePatterns = [/\.test\./, /_test\./, /\.spec\./, /test\//, "test_", "__tests__", "tests/", "tests\\", "create test", "write test", "add test", "implement test", "unit test", "integration test", "e2e test", "end-to-end test", "test file", "test case", "test suite"];
    for (const p of testFilePatterns) {
      if (typeof p === "string") { if (lower.includes(p)) return true; } else { if (p.test(desc)) return true; }
    }
    if (/(\b|with|needs|add|write|create)\s*tests?\b/i.test(desc)) return true;
    for (const p of testFilePatterns) {
      if (typeof p === "string") { if (lower.includes(p)) return true; } else { if (p.test(desc)) return true; }
    }
    const verifPatterns = ["npm test", "yarn test", "pnpm test", "npx jest", "npx vitest", "npx mocha", "cargo test", "go test", "pytest", "make test", "run tests", "run verification", "execute test", "verify", "check", "assert", "validate", "--coverage", "--ci", "test --", "test/", "test command", "test script", "test runner"];
    for (const p of verifPatterns) { if (lower.includes(p)) return true; }
    return false;
  }

  function hasAcceptanceCriteria(desc: string): boolean {
    const lower = desc.toLowerCase();
    const criterionPatterns = ["acceptance", "accept ", "done when", "definition of done", "must ", "should ", "shall ", "will ", "if and only if", "when .* then", "as long as", "given", "when.*then", "verify that", "ensure", "guarantee", "requirement", "condition", "expected.*:", "expected output", "expected behavior", "must.*:", "should.*:", "will.*:"];
    for (const p of criterionPatterns) { if (lower.includes(p)) return true; }
    if (/^\s*[-*•]\s+\S.*:/m.test(desc)) return true;
    if (/^\s*\d+\.\s+\S.*:/m.test(desc)) return true;
    if (/^\s*>\s+\S/m.test(desc)) return true;
    if (/: .{3,}$/.test(desc.trim())) return true;
    return false;
  }

  function hasMeasurableOutcome(desc: string): boolean {
    if (/\.(tsx?|js|ts|py|go|rs|html|css|scss|json|yaml|yml|md|sql|graphql)(\b|\s|$)/i.test(desc)) return true;
    if (/src\//i.test(desc) || /lib\//i.test(desc) || /dist\//i.test(desc) || /migrations\//i.test(desc)) return true;
    if (/\b(create|add|write|generate|implement|build|generate|produce)\s+\S+\.(tsx?|js|ts|py|go|rs|html|css|scss|json|yaml|yml|md|sql|graphql)/i.test(desc)) return true;
    if (/\d+\s*(%|ms|s|m|kb|mb|gb)/.test(desc)) return true;
    if (/(less than|greater than|at most|at least|under |above |within )\s+\d/i.test(desc)) return true;
    if (/(complexity|latency|throughput|memory|speed|duration|size|length|count|number)/i.test(desc)) return true;
    if (/(return|output|result|response|status code|api endpoint|endpoint|route)/i.test(desc)) return true;
    if (/(export|export default|function|class|interface|type|enum|const)\s+\w+/i.test(desc)) return true;
    if (/\b(plan|document|report|spec|design|architecture|schema|config|interface|type)\b/i.test(desc)) return true;
    if (/(\bcreate\b|\bnew\b)/i.test(desc) && /(\bfile\b|\bcomponent\b|\bmodule\b|\bclass\b|\bfunction\b|\binterface\b|\btype\b|\bschema\b|\bendpoint\b|\broute\b)/i.test(desc)) return true;
    return false;
  }

  for (const phase of phases) {
    for (const task of phase.tasks) {
      const id = task.id ?? `task-${taskIdCounter++}`;
      const failures: CriterionFailure[] = [];
      if (!hasTestsOrVerification(task.task)) {
        failures.push({ criterion: "test_files", missing: "No test files or verification commands mentioned", suggestion: "Add test-related language: 'Create src/component.test.ts', 'Run npm test', 'Include pytest for module X', or specify verification commands." });
      }
      if (!hasAcceptanceCriteria(task.task)) {
        failures.push({ criterion: "acceptance_criteria", missing: "No acceptance criteria or done conditions specified", suggestion: "Add done conditions: 'Done when: X works, Y passes, Z is created', 'Acceptance: component renders with props A, B, C', or use bullet lists with checkable items." });
      }
      if (!hasMeasurableOutcome(task.task)) {
        failures.push({ criterion: "measurable_outcome", missing: "No measurable or concrete deliverable specified", suggestion: "Specify what concrete artifact will exist after: 'File X is created', 'Function Y returns Z', 'Endpoint /api/X responds with status 200', 'Component renders with props A and B'." });
      }
      taskResults.push({ taskId: id, taskDescription: task.task, failures, passed: failures.length === 0 });
      allFailures.push(...failures);
    }
  }

  const allPassed = allFailures.length === 0;
  const blockMessage = allPassed
    ? null
    : buildBlockMessage(taskResults, allFailures);

  return { allPassed, taskResults, allFailures, blockMessage };
}

function buildBlockMessage(taskResults: TaskValidationResult[], allFailures: CriterionFailure[]): string {
  const lines: string[] = [];
  lines.push("⛔ Task creation BLOCKED - testability enforcement");
  lines.push("");
  lines.push("Every task MUST have: (1) tests/verification, (2) acceptance criteria, (3) measurable outcome.");
  lines.push("");
  const grouped = new Map<string, CriterionFailure[]>();
  for (const r of taskResults) {
    if (r.failures.length > 0) grouped.set(r.taskDescription, r.failures);
  }
  let taskIdx = 1;
  for (const [desc, failures] of grouped) {
    lines.push(`Task ${taskIdx}: "${truncate(desc, 60)}"`);
    for (const f of failures) {
      const icon = f.criterion === "test_files" ? "🧪" : f.criterion === "acceptance_criteria" ? "✅" : "📏";
      lines.push(`  ${icon} ${f.criterion}: ${f.missing}`);
      lines.push(`     → ${f.suggestion}`);
    }
    lines.push("");
    taskIdx++;
  }
  lines.push("Fix the tasks above and retry plan_project().");
  return lines.join("\n");
}

// ── End Inline Testability Enforcement ──────────────────────────────────────

// ===========================================================================
// Progress output helpers
// ===========================================================================

/** Remove garbage tokens (JSON fragments, control chars, etc.) from raw chunk text. */
function cleanChunkText(chunk: string): string {
  // Split into lines, filter noise, take last meaningful line
  const lines = chunk.split("\n").filter((l) => {
    const trimmed = l.trim();
    // Skip empty, pure whitespace, control chars
    if (!trimmed || /^\s*$/.test(trimmed)) return false;
    // Skip lines that are entirely JSON-like garbage (no spaces, all braces/brackets/commas)
    if (/^[\{\}\[\],:"\-0-9.\/_]+$/.test(trimmed)) return false;
    // Skip lines that are pure JSON fragments (start with { or [ and have no real content)
    if (/^\s*[\{\[]\s*$/.test(trimmed)) return false;
    // Skip lines that are purely whitespace + a single punctuation char
    if (/^\s*[:\-\.,;!?()]+\s*$/.test(trimmed)) return false;
    // Skip very short noise lines
    if (trimmed.length < 2) return false;
    return true;
  });
  if (lines.length === 0) return "";
  return lines[lines.length - 1].trim();
}

/** Format task progress output: T2 [RUN] developer → Build all gauge... (model) [72k tokens] | 16m */
function formatTaskProgress(
  theme: any,
  taskIndex: number,
  taskStatus: string,
  agentName: string,
  model: string,
  tokensUsed: number,
  elapsedMs: number,
  description?: string,
): string {
  const icon = taskStatus === "complete" ? theme.fg("success", "✓") : taskStatus === "failed" ? theme.fg("error", "✗") : taskStatus === "waiting" ? theme.fg("muted", "○") : theme.fg("accent", "▸");
  const statusLabel = taskStatus === "complete" ? "OK" : taskStatus === "reviewing" ? "REV" : taskStatus === "waiting" ? "WAIT" : "RUN";
  const statusColor = taskStatus === "reviewing" ? "accent" : taskStatus === "complete" ? "success" : taskStatus === "failed" ? "error" : taskStatus === "waiting" ? "muted" : "accent";
  const statusText = theme.fg(statusColor, statusLabel);
  const truncatedDesc = truncate(description || "", 28);
  const elapsedStr = elapsedMs >= 60_000 ? `${Math.floor(elapsedMs / 60_000)}m` : `${Math.floor(elapsedMs / 1000)}s`;
  return `${icon} T${taskIndex + 1} [${statusText}] ${agentName} → ${truncatedDesc} (${model}) [${formatTokens(tokensUsed)} tokens] | ${elapsedStr}`;
}

// ===========================================================================
// INLINE: ZFS Status Bar (from zfs_status_bar.ts)
// ===========================================================================

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

interface StatusBarFleetSnapshot {
  zfsActive: boolean;
  zfsSessionActive: boolean;
  fleetName: string;
  currentPhaseIndex: number;
  totalPhases: number;
  currentPhaseName: string;
  currentPhaseStatus: string;
  completedTasks: number;
  totalTasks: number;
  progress: number;
  elapsed: string;
  agents: StatusAgentEntry[];
  allAgents: StatusAgentEntry[];
  reviewIterations: number;
  totalFleetTokens: number;
  phaseCodeReviewsApproved: number;
  phaseCodeReviewsPending: number;
  phaseDesignReviewsApproved: number;
  phaseDesignReviewsPending: number;
  totalAgentInputTokens: number;
  totalAgentOutputTokens: number;
  mainAgentActivity?: { status: string; action: string; detail: string; timestamp: number } | null;
  paused: boolean;
  lastAction?: string;
  lastActionAgo?: string;
  platform?: "windows" | "linux" | "macos" | "unix";
  platformShell?: string;
  tokensPerSec: number;
  etaSeconds: number;
  /** Rendered health bar string (e.g. `[developer✓ tech-lead⚠ designer✗]`).
   *  Empty string when health feature is disabled or no health data available. */
  healthBar: string;
}

const BAR_WIDTH = 80;
const BAR_H = 10;
const BORDER_V = "║";
const BORDER_TL = "╔";
const BORDER_TR = "╗";
const BORDER_BL = "╚";
const BORDER_BR = "╝";
const BORDER_H = "═";

function formatTokenCount(count: number): string {
  if (count == null || isNaN(count)) return "0";
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

/** Format token rate: tokens/sec, e.g. "1.2k/s" or "42/s" */
function formatTokenRate(tokensPerSec: number): string {
  if (tokensPerSec < 10) return `${tokensPerSec}/s`;
  if (tokensPerSec < 1000) return `${tokensPerSec}/s`;
  return `${(tokensPerSec / 1000).toFixed(1)}k/s`;
}

/** Format elapsed time into a short string */
function formatElapsedShort(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000)}m`;
}

function progressBar(filled: number, total: number, width: number): string {
  const ratio = total > 0 ? filled / total : 0;
  const bars = Math.round(ratio * width);
  return "█".repeat(Math.max(0, bars)) + "░".repeat(Math.max(0, width - bars));
}

function centerPad(text: string, width: number): string {
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(Math.max(0, left)) + text;
}

function escape(s: string): string {
  return s.replace(/[<>]/g, "");
}

function sanitizeDisplay(text: string): string {
  return escape(text)
    .replace(/["']\s*:\s*["']?[a-zA-Z0-9]{8,16}["']?\s*/g, "")
    .replace(/["']\s*(id|responseModel|requestId|reqId|respId|response_id|request_id|req_id)\s*:\s*"[^"]*"/gi, "")
    .replace(/,\s*(["'])\s*/g, "$1")
    .replace(/[{}\[\]]/g, "")
    .replace(/["']?[a-f0-9]{8,16}["']?\s*,\s*["']?[a-f0-9]{8,16}["']?/g, "")
    .replace(/"[^"]*",\s*"[^"]*":/g, ":")
    .trim();
}

function safeAppend(buf: string, chunk: string, maxBytes: number): string {
  const combined = buf + chunk;
  if (combined.length <= maxBytes) return combined;
  // Keep the tail - useful for follow/scrollback
  return combined.slice(-(maxBytes - 100)) + "...[truncated]";
}

function buildAgentGrid(snap: StatusBarFleetSnapshot): string {
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
  const gridLine = result.length > BAR_WIDTH - 4 ? result.slice(0, BAR_WIDTH - 4) + "..." : "  " + result;
  // Append health bar below agent status when health is enabled and available
  if (snap.healthBar) {
    return gridLine + "\n" + centerPad(snap.healthBar, BAR_WIDTH);
  }
  return gridLine;
}

function buildAgentDetails(snap: StatusBarFleetSnapshot): string {
  const active = snap.agents.filter(a => a.task !== "");
  if (active.length === 0) {
    if (snap.mainAgentActivity && snap.mainAgentActivity.action !== "idle") {
      const ma = snap.mainAgentActivity;
      const icon = ma.status === "executing" ? "▸" : "◇";
      return `  ${icon} ${ma.action} → ${sanitizeDisplay(ma.detail).slice(0, 50)}`;
    }
    if (snap.lastAction) {
      const ago = snap.lastActionAgo || "";
      return `  ● last: ${sanitizeDisplay(snap.lastAction)}${ago ? ` (${ago})` : ""}`;
    }
    return "  ● idle - waiting for work";
  }
  const lines: string[] = [];
  const show = active.slice(0, 3);
  for (const a of show) {
    const icon = a.icon;
    const name = a.name.slice(0, 10).padEnd(10);
    const task = escape(a.task).slice(0, 30);
    const model = a.model ? `[${a.model.slice(0, 12)}]` : "[?]";
    const tokens = a.task ? `│ ${a.tokens}` : "";
    lines.push(`  ${icon} ${name}  ${model}  ${task}${tokens}`);
  }
  return lines.join("\n");
}

function buildPhaseInfo(snap: StatusBarFleetSnapshot): string {
  if (snap.paused) {
    return centerPad(`⏸ PAUSED  │  P${snap.currentPhaseIndex + 1}/${snap.totalPhases}`, BAR_WIDTH);
  }
  // Strip embedded enumeration to avoid double-encoding
  const cleanName = snap.currentPhaseName?.replace(/^(Phase )?P\d+:\s*/i, "") ?? "";
  const phaseLabel = snap.currentPhaseName
    ? `P${snap.currentPhaseIndex + 1}/${snap.totalPhases}: ${cleanName}`
    : "No active phase";
  const pBar = snap.totalTasks > 0
    ? `[${progressBar(snap.completedTasks, snap.totalTasks, 15)} ${snap.progress}%]`
    : "[░░░░░░░░░░░░░░░ 0%]";
  return `${phaseLabel}  ${pBar}  ${snap.completedTasks}/${snap.totalTasks} tasks`;
}

/** Build review status string with per-phase ✓/○ icons. */
function buildReviewStatusLabel(codeApproved: number, codePending: number, designApproved: number, designPending: number): string {
  const parts: string[] = [];
  if (codeApproved > 0) parts.push(`${codeApproved}✓`);
  if (codePending > 0) parts.push(`${codePending}○`);
  if (designApproved > 0) parts.push(`${designApproved}✓`);
  if (designPending > 0) parts.push(`${designPending}○`);
  if (parts.length === 0) return "○ 0 approved  ○ 0 pending";
  return parts.join("  ");
}

/** Build review status from fleetState for the widget bar. */
function buildWidgetReviewStatus(state: FleetState): string {
  const phase = state.phases[state.currentPhaseIndex];
  if (!phase) return "";
  let codeApproved = 0, codePending = 0, designApproved = 0, designPending = 0;
  let codeNeedsFix = 0, designNeedsFix = 0;
  for (const t of phase.tasks) {
    if (t.codeReviewStatus === "approved") codeApproved++;
    else if (t.codeReviewStatus === "needs_fix") codeNeedsFix++;
    if (t.designReviewStatus === "approved") designApproved++;
    else if (t.designReviewStatus === "needs_fix") designNeedsFix++;
  }
  const totalApproved = codeApproved + designApproved;
  const totalNeedsFix = codeNeedsFix + designNeedsFix;
  const totalReviews = codeApproved + codePending + codeNeedsFix + designApproved + designPending + designNeedsFix;
  // All tasks have been through at least one review — show progress bar
  if (totalReviews > 0) {
    if (totalNeedsFix > 0) {
      const pct = Math.round((totalApproved / totalReviews) * 100);
      return `R${state.reviewIterations} · ${totalApproved}/${totalReviews} ✓  ${totalNeedsFix} needs fix`;
    }
    return `✓ R${state.reviewIterations} all approved`;
  }
  // No reviews yet — show phase progress
  const totalTasks = phase.tasks.length;
  const completed = phase.tasks.filter(t => t.status === "complete").length;
  if (completed < totalTasks) return `○ ${completed}/${totalTasks} tasks`;
  return "✓ all tasks";
}

function buildFooter(snap: StatusBarFleetSnapshot): string {
  const tokenStr = `▸ ${formatTokenCount(snap.totalAgentInputTokens)}i / ${formatTokenCount(snap.totalAgentOutputTokens)}o | fleet: ${formatTokenCount(snap.totalFleetTokens)} tokens`;
  // Per-phase review status
  const codeApproved = snap.phaseCodeReviewsApproved || 0;
  const codePending = snap.phaseCodeReviewsPending || 0;
  const designApproved = snap.phaseDesignReviewsApproved || 0;
  const designPending = snap.phaseDesignReviewsPending || 0;
  const reviewLabel = buildReviewStatusLabel(codeApproved, codePending, designApproved, designPending);
  const throughputStr = snap.tokensPerSec > 0 ? `│ ${formatTokenRate(snap.tokensPerSec)}` : "";
  const etaStr = snap.etaSeconds > 0 ? `│ ETA: ${formatElapsedShort(snap.etaSeconds * 1000)}` : "";
  const parts: string[] = [
    reviewLabel,
    `${snap.elapsed} elapsed`,
    snap.zfsActive ? "ZFS" : "pi",
  ];
  if (throughputStr) parts.push(throughputStr);
  if (etaStr) parts.push(etaStr);
  if (snap.platform) parts.push(snap.platform);
  const content = parts.join("  │  ");
  return content;
}

export function renderStatusBar(snap: StatusBarFleetSnapshot): string {
  const agentsGrid = buildAgentGrid(snap);
  const phaseInfo = buildPhaseInfo(snap);
  const agentDetails = buildAgentDetails(snap);
  const footer = buildFooter(snap);
  const header = `${snap.fleetName}  ${snap.zfsActive ? "[ZFS MODE]" : "[pi MODE]"}  │  ${snap.currentPhaseIndex + 1}/${snap.totalPhases}`;
  const lines: string[] = [
    `${BORDER_TL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_TR}`,
    `${BORDER_V}${centerPad(header, BAR_WIDTH)}${BORDER_V}`,
    `${BORDER_V}${agentsGrid}${BORDER_V}`,
    `${BORDER_V}${phaseInfo}${BORDER_V}`,
    `${BORDER_V}${agentDetails}${BORDER_V}`,
  ];
  const usedLines = lines.length;
  for (let i = usedLines; i < BAR_H - 1; i++) {
    lines.push(`${BORDER_V}${" ".repeat(BAR_WIDTH)}${BORDER_V}`);
  }
  lines.push(`${BORDER_V}${footer}${BORDER_V}`);
  lines.push(`${BORDER_BL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_BR}`);
  return lines.join("\n");
}

export function renderCompactStatusBar(snap: StatusBarFleetSnapshot): string {
  const agentsGrid = buildAgentGrid(snap);
  const phaseInfo = buildPhaseInfo(snap);
  const codeApproved = snap.phaseCodeReviewsApproved || 0;
  const codePending = snap.phaseCodeReviewsPending || 0;
  const designApproved = snap.phaseDesignReviewsApproved || 0;
  const designPending = snap.phaseDesignReviewsPending || 0;
  const throughputStr = snap.tokensPerSec > 0 ? `│ ${formatTokenRate(snap.tokensPerSec)}` : "";
  const etaStr = snap.etaSeconds > 0 ? `│ ETA: ${formatElapsedShort(snap.etaSeconds * 1000)}` : "";
  const tokenLine = `▸ ${formatTokenCount(snap.totalFleetTokens)} tokens${throughputStr}${etaStr}  │  ${formatTokenCount(snap.totalAgentInputTokens)}i / ${formatTokenCount(snap.totalAgentOutputTokens)}o  │  ${buildReviewStatusLabel(codeApproved, codePending, designApproved, designPending)}`;
  const elapsedLine = `${snap.elapsed} elapsed`;
  const modeLine = snap.zfsActive ? "[ZFS]" : "[pi]";
  const header = `${snap.fleetName}  ${modeLine}  │  P${snap.currentPhaseIndex + 1}/${snap.totalPhases}  │  ${snap.currentPhaseName || "idle"}`;
  // agentsGrid may contain multiple lines when health bar is appended;
  // each line is wrapped in its own border to preserve the grid look.
  const agentLines = agentsGrid.split("\n");
  const agentLinesRendered = agentLines.map((l) => `${BORDER_V}${l}${BORDER_V}`);
  return [
    `${BORDER_TL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_TR}`,
    `${BORDER_V}${centerPad(header, BAR_WIDTH)}${BORDER_V}`,
    ...agentLinesRendered,
    `${BORDER_V}${phaseInfo}${BORDER_V}`,
    `${BORDER_V}${tokenLine}${BORDER_V}`,
    `${BORDER_V}${elapsedLine}${BORDER_V}`,
    `${BORDER_BL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_BR}`,
  ].join("\n");
}

export function buildFleetSnapshot(opts: {
  phases: Array<{ id: string; name: string; status: string; tasks: Array<{ id: string; agentName: string; status: string; description?: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number; messageCount?: number; codeReviewStatus?: string; designReviewStatus?: string }> }>;
  currentPhaseIndex: number;
  activeAgents: Array<{ name: string; status: string; currentTask?: string; model?: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number; turns?: number }>;
  paused: boolean;
  startTime: number;
  reviewIterations: number;
  totalFleetTokens: number;
  mainAgentActivity?: { status: string; action: string; detail: string; timestamp: number } | null;
  zfsActive: boolean;
  zfsSessionActive: boolean;
  lastAction?: string;
  lastActionAgo?: string;
  healthAgents?: Array<{ name: string; status: string }>;}): StatusBarFleetSnapshot {
  const now = Date.now();
  const elapsed = formatDuration(now - opts.startTime);
  const currentPhase = opts.phases[opts.currentPhaseIndex];
  let phaseCodeApproved = 0, phaseCodePending = 0, phaseDesignApproved = 0, phaseDesignPending = 0;
  if (currentPhase) {
    for (const t of currentPhase.tasks) {
      if (t.codeReviewStatus === "approved") phaseCodeApproved++;
      else if (t.codeReviewStatus === "pending") phaseCodePending++;
      if (t.designReviewStatus === "approved") phaseDesignApproved++;
      else if (t.designReviewStatus === "pending") phaseDesignPending++;
    }
  }
  const totalTasks = opts.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = opts.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete" || t.status === "needs_fix").length, 0);
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const currentPhaseName = currentPhase?.name || "";
  const currentPhaseStatus = currentPhase?.status || "pending";
  const allAgentNames = new Set<string>();
  for (const phase of opts.phases) {
    for (const task of phase.tasks) allAgentNames.add(task.agentName);
  }
  for (const agent of opts.activeAgents) allAgentNames.add(agent.name);
  const activeAgentEntries: StatusAgentEntry[] = [];
  const allAgentEntries: StatusAgentEntry[] = [];
  for (const agent of opts.activeAgents) {
    const icon = agent.status === "running" ? "▸" :
      agent.status === "reviewing" ? "◉" : agent.status === "error" ? "✗" :
      agent.status === "idle" ? "●" : "○";
    const color = agent.status === "running" ? "accent" :
      agent.status === "error" ? "error" : agent.status === "reviewing" ? "accent" : "dim";
    activeAgentEntries.push({
      name: agent.name, icon: icon as AgentStatusIcon, color, task: agent.currentTask || "",
      tokens: agent.tokensUsed != null ? formatTokenCount(agent.tokensUsed) : "",
      model: agent.model || "", inputTokens: agent.inputTokens || 0,
      outputTokens: agent.outputTokens || 0, turns: agent.turns || 0,
    });
    allAgentEntries.push(activeAgentEntries[activeAgentEntries.length - 1]);
  }
  const knownNames = new Set(opts.activeAgents.map((a) => a.name));
  for (const name of allAgentNames) {
    if (!knownNames.has(name)) {
      allAgentEntries.push({ name, icon: "○", color: "muted", task: "", tokens: "", model: "", inputTokens: 0, outputTokens: 0, turns: 0 });
    }
  }
  const totalInputTokens = opts.activeAgents.reduce((s, a) => s + (a.inputTokens || 0), 0);
  const totalOutputTokens = opts.activeAgents.reduce((s, a) => s + (a.outputTokens || 0), 0);
  // Compute tokens/sec (only meaningful after ~5s of activity)
  const elapsedSec = (now - opts.startTime) / 1000;
  const tokensPerSec = elapsedSec > 5 ? Math.round(opts.totalFleetTokens / elapsedSec) : 0;
  // Compute ETA based on remaining work and current throughput
  const etaSeconds = elapsedSec > 5 && currentPhaseStatus !== "complete"
    ? Math.round((opts.totalFleetTokens * 0.5) / tokensPerSec)  // rough: assume ~2x more tokens needed
    : 0;
  // Build health bar when health feature is enabled and health data is available.
  // Pass null prefix so the health bar renders as "name✓ name⚠ name✗"
  // (without the "agents:" prefix) — the ZFS status bar adds its own borders.
  const healthAgents = opts.healthAgents != null ? opts.healthAgents : [];
  const healthBar = featureConfig.health && healthAgents.length > 0
    ? buildHealthBar(healthAgents, null)
    : "";

  return {
    zfsActive: opts.zfsActive, zfsSessionActive: opts.zfsSessionActive, fleetName: "CARAVEL FLEET",
    currentPhaseIndex: opts.currentPhaseIndex, totalPhases: opts.phases.length, currentPhaseName,
    currentPhaseStatus, completedTasks, totalTasks, progress, elapsed,
    agents: activeAgentEntries, allAgents: allAgentEntries, reviewIterations: opts.reviewIterations,
    totalFleetTokens: opts.totalFleetTokens, totalAgentInputTokens: totalInputTokens,
    totalAgentOutputTokens: totalOutputTokens, mainAgentActivity: opts.mainAgentActivity, paused: opts.paused,
    lastAction: opts.lastAction, lastActionAgo: opts.lastActionAgo, tokensPerSec, etaSeconds,
    phaseCodeReviewsApproved: phaseCodeApproved,
    phaseCodeReviewsPending: phaseCodePending,
    phaseDesignReviewsApproved: phaseDesignApproved,
    phaseDesignReviewsPending: phaseDesignPending,
    healthBar,
  };
}

// ===========================================================================
// INLINE: ZFS Status Bar Manager (from zfs_status_bar.ts)
// ===========================================================================

interface ZFSStatusBarManagerOptions {
  floatingPaneName: string;
  sessionName: string;
  cwd: string;
  getFleetState: () => StatusBarFleetSnapshot | null;
  getPlatformInfo: () => PlatformInfo;
}

class ZFSStatusBarManager {
  private floatingPaneName: string;
  private sessionName: string;
  private cwd: string;
  private getFleetState: () => StatusBarFleetSnapshot | null;
  private getPlatformInfo: () => PlatformInfo;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private paneId: string | null = null;

  constructor(opts: ZFSStatusBarManagerOptions) {
    this.floatingPaneName = opts.floatingPaneName;
    this.sessionName = opts.sessionName;
    this.cwd = opts.cwd;
    this.getFleetState = opts.getFleetState;
    this.getPlatformInfo = opts.getPlatformInfo;
    this.paneId = null;
  }

  private async createFloatingPane(): Promise<void> {
    const result = await new Promise<{ success: boolean; paneId?: string }>((resolve) => {
      const proc = spawn("zellij", [
        "action", "new-pane",
        "-s", this.sessionName,
        "-n", this.floatingPaneName,
        "-f",
        "--height", "8",
        "--pinned",
        "--",
        "cat",
      ], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      proc.stdout.on("data", (d: any) => { stdout += d.toString(); });
      proc.on("close", (code: number) => {
        const paneId = stdout.trim().match(/^(terminal_\d+)$/m)?.[1] || null;
        resolve({ success: code === 0 || code === null, paneId });
      });
      setTimeout(() => { resolve({ success: false, paneId: null }); }, 5000);
    });
    if (result.success && result.paneId) {
      this.paneId = result.paneId;
    }
  }

  private async updatePane(content: string): Promise<void> {
    if (!this.paneId) return;
    await this.sendZellijActionRaw("clear", ["-s", this.sessionName]);
    const lines = content.split("\n");
    for (const line of lines) {
      await this.sendZellijActionRaw("write-chars", [
        "-s", this.sessionName,
        "-n", this.paneId,
        line,
      ]);
      await this.sendZellijActionRaw("send-keys", [
        "-s", this.sessionName,
        "-n", this.paneId,
        "Enter",
      ]);
    }
  }

  private sendZellijActionRaw(action: string, extraArgs: string[] = []): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", [action, ...extraArgs], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      proc.on("close", (code: number) => { resolve(code === 0 || code === null); });
      proc.on("error", () => { resolve(false); });
      setTimeout(() => { resolve(false); }, 5000);
    });
  }

  async start(): Promise<void> {
    if (this.intervalId) return;
    await this.createFloatingPane();
    this.tick();
    this.intervalId = setInterval(() => this.tick(), 2000);
  }

  private async tick(): Promise<void> {
    const fleetState = this.getFleetState();
    if (!fleetState) return;
    const platform = this.getPlatformInfo();
    const snap = buildFleetSnapshot(fleetState);
    const content = renderStatusBar(snap);
    await this.updatePane(content);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  update(): void {
    // If interval is running, tick handles updates automatically
  }
}

// ===========================================================================
// INLINE: ZFS Process Manager (from zellij-fleet.ts)
// ===========================================================================

const FLEET_SESSION = "caravel";
const FLEET_LAYOUT_FILE = "zellij-layout.kdl";
const DEFAULT_PANE_WIDTH = 30;
const DEFAULT_PANE_HEIGHT = 20;
const PANE_ID_PREFIX = "caravel-pid-";

interface PlatformInfo {
  platform: "windows" | "linux" | "macos" | "unix";
  shell: "cmd" | "powershell" | "bash" | "zsh" | "fish" | "sh";
  shellArg: string;
  shellFlag: string;
  isWindows: boolean;
}

function detectPlatform(): PlatformInfo {
  const platform = os.platform();
  const isWindows = platform === "win32";
  let shell: PlatformInfo["shell"] = "bash";
  if (isWindows) {
    const ps = process.env["WSL_DISTRO_NAME"];
    if (ps) { shell = "bash"; }
    else {
      const pwsh = process.env["PROMPT_COMMAND"] ?? process.env["COMSPEC"] ?? "";
      if (/powershell/i.test(pwsh)) shell = "powershell";
      else if (/cmd/i.test(pwsh) || process.env["COMSPEC"]) shell = "cmd";
      else shell = "powershell";
    }
  } else {
    const sh = process.env["SHELL"] ?? "";
    if (sh.includes("zsh")) shell = "zsh";
    else if (sh.includes("fish")) shell = "fish";
    else if (sh.includes("bash")) shell = "bash";
    else shell = "sh";
  }
  const shellMap: Record<string, { flag: string; arg: string }> = {
    bash: { flag: "-c", arg: "bash" }, zsh: { flag: "-c", arg: "zsh" },
    fish: { flag: "-c", arg: "fish" }, sh: { flag: "-c", arg: "sh" },
    cmd: { flag: "/c", arg: "cmd" }, powershell: { flag: "-NoProfile", arg: "powershell" },
  };
  const config = shellMap[shell] ?? shellMap["bash"];
  return { platform: isWindows ? "windows" : (platform as "linux" | "macos" | "unix"), shell, shellArg: config.arg, shellFlag: config.flag, isWindows };
}

function checkCommand(cmd: string): boolean {
  try {
    if (os.platform() === "win32") {
      const proc = spawn("where", [cmd], { stdio: "ignore", shell: true });
      return (false as boolean); // async check below
    } else {
      const proc = spawn("which", [cmd], { stdio: "ignore", shell: true });
      return (false as boolean); // async check below
    }
  } catch { return false; }
}

async function checkCommandAsync(cmd: string): Promise<boolean> {
  try {
    if (os.platform() === "win32") {
      return new Promise<boolean>((resolve) => {
        const proc = spawn("where", [cmd], { stdio: "ignore", shell: true });
        proc.on("exit", (code) => resolve(code === 0));
        setTimeout(() => resolve(false), 3000);
      });
    } else {
      return new Promise<boolean>((resolve) => {
        const proc = spawn("which", [cmd], { stdio: "ignore", shell: true });
        proc.on("exit", (code) => resolve(code === 0));
        setTimeout(() => resolve(false), 3000);
      });
    }
  } catch { return false; }
}

interface ZFSPaneState {
  paneId: string; name: string; agent?: string; command: string; cwd?: string;
  running: boolean; exited: boolean; exitCode: number | null;
  stdoutBuffer: string; stderrBuffer: string; partialLine: string;
  stdoutCallback: ((chunk: string) => void) | null; stderrCallback: ((chunk: string) => void) | null;
  process?: any; abortController?: AbortController;
  startTime?: number; endTime?: number; pid?: number;
}

interface ZFSLayoutConfig {
  name: string; windowWidth: number; rightWidth: number;
  panes: Array<{ name: string; type?: string; align?: string; focus?: boolean; command?: string; args?: string[] }>;
}

interface ZFSProcessState {
  running: boolean; exited: boolean; exitCode: number | null;
  stdout: string; stderr: string; pid?: number; startTime: number; endTime?: number;
  abortController?: AbortController;
}

interface CommandResult {
  cmd: string; args: string[]; platform: PlatformInfo;
}

function loadFleetLayout(projectRoot: string): ZFSLayoutConfig | null {
  const kdlPath = path.join(projectRoot, FLEET_LAYOUT_FILE);
  if (!fs.existsSync(kdlPath)) return null;
  const content = fs.readFileSync(kdlPath, "utf-8");
  return parseKDLLayout(content);
}

function parseKDLLayout(content: string): ZFSLayoutConfig | null {
  const result: ZFSLayoutConfig = { name: "fleet", windowWidth: 60, rightWidth: 40, panes: [] };
  const nameMatch = content.match(/layout\s*\{\s*name:\s*"([^"]+)"/);
  if (nameMatch) result.name = nameMatch[1];
  const windowMatch = content.match(/window\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
  if (!windowMatch) return result;
  const windowBody = windowMatch[1];
  const paneRegex = /pane\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
  let paneMatch;
  while ((paneMatch = paneRegex.exec(windowBody)) !== null) {
    const block = paneMatch[1];
    const pane: ZFSLayoutConfig["panes"][number] = { name: "unnamed" };
    const nameM = block.match(/name:\s*"([^"]+)"/);
    if (nameM) pane.name = nameM[1];
    const typeM = block.match(/type:\s*"(\w+)"/);
    if (typeM) pane.type = typeM[1];
    const alignM = block.match(/align:\s*"(\w+)"/);
    if (alignM) pane.align = alignM[1];
    const focusM = block.match(/focus:\s*true/);
    if (focusM) pane.focus = true;
    const sizeM = block.match(/size:\s*(\d+)/);
    if (sizeM) {
      if (pane.align === "left") result.windowWidth = parseInt(sizeM[1]);
      else result.rightWidth = parseInt(sizeM[1]);
    }
    result.panes.push(pane);
  }
  return result;
}

function generateFleetLayout(agents: Array<{ name: string; description: string }>, customWidth?: number): string {
  const leftWidth = customWidth ?? 60;
  const rightWidth = 100 - leftWidth;
  const lines: string[] = [];
  lines.push("// ════════════════════════════════════════════════════════════");
  lines.push("// Caravel Fleet - Auto-generated Zellij Layout");
  lines.push("// ════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("layout {");
  lines.push('    name: "fleet"');
  lines.push("");
  lines.push("    window {");
  lines.push("");
  lines.push("        pane {");
  lines.push("            type: \"main\"");
  lines.push(`            align: "left"`);
  lines.push(`            size: ${leftWidth}`);
  lines.push(`            name: "orchestrator"`);
  lines.push("            focus: true");
  lines.push("        }");
  lines.push("");
  const agentPanes = agents.slice(0, 5);
  for (const agent of agentPanes) {
    lines.push("        pane {");
    lines.push(`            align: "right"`);
    lines.push(`            size: ${rightWidth}`);
    lines.push(`            name: "${agent.name}"`);
    lines.push("        }");
    lines.push("");
  }
  lines.push("        floating {");
  lines.push("            name: \"status-bar\"");
  lines.push('            y: "bottom"');
  lines.push('            x: "right"');
  lines.push("            max_width: 80");
  lines.push("            height: 10");
  lines.push("        }");
  lines.push("");
  lines.push("    }");
  lines.push("}");
  return lines.join("\n");
}

function buildZellijAction(action: string, args: string[]): CommandResult {
  const platform = detectPlatform();
  return { cmd: "zellij", args: [action, ...args], platform };
}

function buildPaneCommand(cwd: string, taskDescription: string, agentName: string, agentModel?: string): string {
  const platform = detectPlatform();
  const escapedDesc = taskDescription.replace(/"/g, '\\"').replace(/\$/g, "\\$");
  const piArgs = ["--mode", "json", "-p", "--no-session"];
  if (agentModel) piArgs.push("--model", agentModel);
  const taskArg = `"${taskDescription}"`;
  if (platform.shell === "cmd") {
    return `chcp 65001 >nul & ${process.execPath} ${process.argv[1]} ${piArgs.join(" ")} ${taskArg}`;
  }
  if (platform.shell === "powershell") {
    return `${process.execPath} ${process.argv[1]} ${piArgs.join(" ")} ${taskArg}`;
  }
  return `${process.execPath} ${process.argv[1]} ${piArgs.join(" ")} ${taskArg}`;
}

function killProcessTree(pid?: number): void {
  if (pid == null) return;
  if (os.platform() === "win32") {
    try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", shell: true }); } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ } }
  }
}

class ZFS {
  private api: ExtensionAPI | null = null;
  private platform: PlatformInfo;
  private zellijAvailable: boolean = false;
  private cwd: string;
  private sessionName: string;
  private layoutConfig: ZFSLayoutConfig | null;
  private layoutPath: string;
  private panes: Map<string, ZFSPaneState> = new Map();
  private activeProcesses: Map<string, ZFSProcessState> = new Map();
  private paused: boolean = false;
  private skipAgent: string | null = null;
  private statusBarManager: ZFSStatusBarManager | null = null;
  private fleetStateGetter: (() => any) | null = null;
  private statusBarActive: boolean = false;

  constructor() {
    this.platform = detectPlatform();
    this.zellijAvailable = false;
    this.cwd = process.cwd();
    this.sessionName = FLEET_SESSION;
    this.layoutConfig = null;
    this.layoutPath = path.join(this.cwd, FLEET_LAYOUT_FILE);
    if (fs.existsSync(this.layoutPath)) {
      const content = fs.readFileSync(this.layoutPath, "utf-8");
      this.layoutConfig = parseKDLLayout(content);
    }
  }

  async checkAndInitZellij(): Promise<{ available: boolean; message: string }> {
    this.zellijAvailable = await checkCommandAsync("zellij");
    if (this.zellijAvailable) return { available: true, message: "Zellij detected - fleet process manager ready." };
    return { available: false, message: "Zellij not found. Install from https://zellij.dev/tutorials/installation/ or fleet will fall back to background processes." };
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.layoutPath = path.join(cwd, FLEET_LAYOUT_FILE);
    if (fs.existsSync(this.layoutPath)) {
      const content = fs.readFileSync(this.layoutPath, "utf-8");
      this.layoutConfig = parseKDLLayout(content);
    }
  }

  getLayoutConfig(): ZFSLayoutConfig | null { return this.layoutConfig; }

  async createSession(agents: Array<{ name: string; description: string }>, cwd?: string): Promise<{ success: boolean; message: string }> {
    if (!this.zellijAvailable) return { success: false, message: "Zellij is not installed. Cannot create session." };
    let kdlContent: string;
    if (this.layoutConfig) kdlContent = this.generateKDLFromConfig(agents);
    else kdlContent = generateFleetLayout(agents);
    const tmpLayout = path.join(os.tmpdir(), `caravel-fleet-${Date.now()}.kdl`);
    try { fs.writeFileSync(tmpLayout, kdlContent, "utf-8"); } catch { return { success: false, message: "Failed to write layout file." }; }
    await this.killSession(this.sessionName);
    const cmd = `zellij session create -s ${this.sessionName} --layout "${tmpLayout}"`;
    return new Promise((resolve) => {
      const proc = spawn(this.platform.shell, [this.platform.shellArg, cmd], { cwd: cwd ?? this.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d: any) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: any) => { stderr += d.toString(); });
      proc.on("close", (code: number) => {
        try { fs.unlinkSync(tmpLayout); } catch { /* ignore */ }
        if (code === 0) { this.initStatusBar(); resolve({ success: true, message: `Zellij session "${this.sessionName}" created. Layout: ${kdlContent.includes("floating") ? "with status bar" : "without status bar"}` }); }
        else resolve({ success: false, message: `Failed to create session (exit ${code}): ${stderr.slice(0, 200)}` });
      });
      proc.on("error", () => {
        try { fs.unlinkSync(tmpLayout); } catch { /* ignore */ }
        this.destroyStatusBar();
        resolve({ success: false, message: "Failed to spawn zellij." });
      });
    });
  }

  private generateKDLFromConfig(agents: Array<{ name: string; description: string }>): string {
    if (!this.layoutConfig) return generateFleetLayout(agents);
    const lines: string[] = [];
    const cfg = this.layoutConfig;
    lines.push("// Caravel Fleet - Auto-generated from layout config");
    lines.push("window {");
    lines.push("");
    for (const pane of cfg.panes) {
      lines.push("    pane {");
      if (pane.type) lines.push(`        type: "${pane.type}"`);
      if (pane.align) lines.push(`        align: "${pane.align}"`);
      if (pane.focus) lines.push("        focus: true");
      lines.push(`        name: "${pane.name}"`);
      lines.push("    }");
      lines.push("");
    }
    lines.push("}");
    return lines.join("\n");
  }

  async killSession(sessionName: string): Promise<boolean> {
    if (!this.zellijAvailable) return false;
    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", ["kill-session", sessionName], { shell: true, stdio: "ignore" });
      proc.on("close", (code: number) => resolve(code === 0 || code === null));
      proc.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
  }

  async switchToSession(): Promise<boolean> {
    if (!this.zellijAvailable) return false;
    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", ["switch-to-session", this.sessionName], { shell: true, stdio: "ignore" });
      proc.on("close", (code: number) => resolve(code === 0 || code === null));
      proc.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
  }

  // Switch the current session to the fleet layout (used when inside an existing Zellij session)
  async switchToFleetLayout(cwd?: string): Promise<{ success: boolean; message: string }> {
    if (!this.zellijAvailable) return { success: false, message: "Zellij is not installed." };
    // Ensure the layout file exists
    const layoutPath = this.layoutPath || path.join(cwd ?? this.cwd, FLEET_LAYOUT_FILE);
    if (!fs.existsSync(layoutPath)) {
      return { success: false, message: `Layout file not found at ${layoutPath}. Run /zellij-start from outside Zellij first.` };
    }
    return new Promise((resolve) => {
      const proc = spawn("zellij", ["action", "switch-layout", "fleet"], { shell: true, stdio: "ignore" });
      proc.on("close", (code: number) => {
        if (code === 0 || code === null) {
          resolve({ success: true, message: `Switched to fleet layout.` });
        } else {
          resolve({ success: false, message: `zellij switch-layout exited with code ${code}. The "fleet" layout name may not match a defined layout in your zellij-layout.kdl.` });
        }
      });
      proc.on("error", () => resolve({ success: false, message: "Failed to execute zellij switch-layout." }));
      setTimeout(() => resolve({ success: false, message: "zellij switch-layout timed out." }), 5000);
    });
  }

  async listSessions(): Promise<Array<{ name: string; layout: string; windows: number; panes: number }>> {
    if (!this.zellijAvailable) return [];
    return new Promise<Array<{ name: string; layout: string; windows: number; panes: number }>>((resolve) => {
      const proc = spawn("zellij", ["list-sessions"], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d: any) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: any) => { stderr += d.toString(); });
      proc.on("close", (code: number) => {
        if (code !== 0 && code !== null) {
          resolve([]);
          return;
        }
        const sessions: Array<{ name: string; layout: string; windows: number; panes: number }> = [];
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            sessions.push({
              name: parts[0],
              layout: parts[1] || "unknown",
              windows: 0,
              panes: 0,
            });
          }
        }
        resolve(sessions);
      });
      proc.on("error", () => resolve([]));
      setTimeout(() => resolve([]), 3000);
    });
  }

  async discoverSession(): Promise<{ exists: boolean; running: boolean }> {
    const sessions = await this.listSessions();
    const found = sessions.find((s) => s.name === this.sessionName);
    return { exists: !!found, running: !!found };
  }

  async detectInsideZellij(): Promise<boolean> {
    // Check if we are running inside an active Zellij session.
    // Zellij sets the ZELLIJSOCKET (or ZELLIJ_SOCKET_PATH) environment variable
    // when spawned inside a session. This is the most reliable indicator.
    if (process.env["ZELLIJSOCKET"] || process.env["ZELLIJ_SOCKET_PATH"]) {
      return true;
    }
    // Fallback: if zellij list-sessions returns anything, we're likely inside one.
    // This is a heuristic — there could be unrelated sessions running.
    const sessions = await this.listSessions();
    return sessions.length > 0;
  }

  async detachSession(): Promise<boolean> {
    if (!this.zellijAvailable) return false;
    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", ["detach"], { shell: true, stdio: "ignore" });
      proc.on("close", (code: number) => resolve(code === 0 || code === null));
      proc.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
  }

  async spawnPane(agentName: string, taskDescription: string, agentModel?: string, cwd?: string, onStdout?: (chunk: string, agentName: string) => void, onStderr?: (chunk: string, agentName: string) => void): Promise<{ success: boolean; paneId: string; message?: string }> {
    if (!this.zellijAvailable) return this.spawnBackgroundProcess(agentName, taskDescription, agentModel, cwd, onStdout, onStderr);
    const paneId = `${PANE_ID_PREFIX}${agentName}-${Date.now()}`;
    const paneCwd = (cwd ?? this.cwd) as string;
    const pane: ZFSPaneState = {
      paneId, name: agentName, agent: agentName,
      command: buildPaneCommand(paneCwd, taskDescription, agentName, agentModel ?? ""),
      cwd: paneCwd, running: true, exited: false, exitCode: null,
      stdoutBuffer: "", stderrBuffer: "", partialLine: "",
      stdoutCallback: onStdout ? (chunk: string) => onStdout(chunk, agentName) : null,
      stderrCallback: onStderr ? (chunk: string) => onStderr(chunk, agentName) : null,
      startTime: Date.now(),
    };
    this.panes.set(paneId, pane);
    const result = await this.sendZellijAction("action", ["new-pane", "-s", this.sessionName, "-n", agentName, "-d", "floating"]);
    if (!result) { pane.running = false; pane.exited = true; this.panes.delete(paneId); return { success: false, paneId, message: `Failed to create pane in session "${this.sessionName}".` }; }
    return { success: true, paneId };
  }

  private async spawnBackgroundProcess(agentName: string, taskDescription: string, agentModel?: string, cwd?: string, onStdout?: (chunk: string, agentName: string) => void, onStderr?: (chunk: string, agentName: string) => void): Promise<{ success: boolean; paneId: string }> {
    const paneId = `${PANE_ID_PREFIX}${agentName}-bg-${Date.now()}`;
    const processCommand = buildPaneCommand(cwd ?? this.cwd, taskDescription, agentName, agentModel ?? "");
    const state: ZFSProcessState = { running: true, exited: false, exitCode: null, stdout: "", stderr: "", startTime: Date.now() };
    this.activeProcesses.set(paneId, state);
    const args = this.platform.shell === "cmd" ? ["/c", processCommand] : [this.platform.shellArg, processCommand];
    spawn(this.platform.shell, args, { cwd: cwd ?? this.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CARRAVEL_FLEET: "true", CARRAVEL_PANE_ID: paneId, TERM: "xterm-256color" } })
      .on("close", (code: number) => { state.exited = true; state.exitCode = code; state.running = false; state.endTime = Date.now(); this.activeProcesses.delete(paneId); })
      .on("error", () => { state.exited = true; state.running = false; this.activeProcesses.delete(paneId); });
    return { success: true, paneId };
  }

  private async sendZellijAction(action: string, extraArgs: string[] = []): Promise<boolean> {
    if (!this.zellijAvailable) return false;
    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", [action, ...extraArgs], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d: any) => { stderr += d.toString(); });
      proc.on("close", (code: number) => { resolve(code === 0 || code === null); });
      proc.on("error", () => { resolve(false); });
      setTimeout(() => { resolve(false); }, 5000);
    });
  }

  async stopPane(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (pane) {
      if (pane.process) { try { killProcessTree(pane.process.pid); } catch { /* ignore */ } }
      pane.running = false; pane.exited = true; pane.endTime = Date.now();
      this.panes.delete(paneId);
    }
    const proc = this.activeProcesses.get(paneId);
    if (proc) { proc.abortController?.abort(); if (proc.pid) killProcessTree(proc.pid); proc.exited = true; this.activeProcesses.delete(paneId); }
    return this.sendZellijAction("action", ["close-pane", "-s", this.sessionName]);
  }

  followPane(paneId: string, onOutput: (chunk: string, paneName: string) => void): boolean {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.running) return false;
    pane.stdoutCallback = (chunk: string) => { onOutput(chunk, pane.name); };
    return true;
  }

  unfollowPane(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    pane.stdoutCallback = null; return true;
  }

  async resizePane(paneId: string, width: number, height: number): Promise<boolean> {
    if (!this.zellijAvailable) return false;
    return this.sendZellijAction("action", ["resize", "increase", "-s", this.sessionName, "-n", paneId]);
  }

  getPaneStatus(paneId: string): ZFSPaneState | null { return this.panes.get(paneId) ?? null; }

  listPanes(): Array<{ paneId: string; name: string; agent?: string; running: boolean; exited: boolean; exitCode: number | null }> {
    return Array.from(this.panes.values()).map((p) => ({ paneId: p.paneId, name: p.name, agent: p.agent, running: p.running, exited: p.exited, exitCode: p.exitCode }));
  }

  setFleetStateGetter(getter: () => any): void { this.fleetStateGetter = getter; }

  getPlatformInfo(): PlatformInfo { return this.platform; }

  initStatusBar(): void {
    if (!this.zellijAvailable || this.statusBarManager) return;
    const floatingPaneName = "status-bar";
    const sessionName = this.sessionName;
    const cwd = this.cwd;
    this.statusBarManager = new ZFSStatusBarManager({
      floatingPaneName, sessionName, cwd,
      getFleetState: () => {
        if (!this.fleetStateGetter) return null;
        const fleetState = this.fleetStateGetter();
        if (!fleetState) return null;
        const fsState = fleetState as any;
        const now = Date.now();
        const lastAction = (fsState.mainAgentActivity && fsState.mainAgentActivity.action !== "idle") ? fsState.mainAgentActivity.action : "idle";
        let lastActionAgo = "";
        if (fsState.mainAgentActivity && fsState.mainAgentActivity.timestamp) {
          const age = now - fsState.mainAgentActivity.timestamp;
          const secs = Math.floor(age / 1000);
          const mins = Math.floor(secs / 60);
          lastActionAgo = mins > 0 ? `${mins}m ago` : `${secs}s ago`;
        }
        return buildFleetSnapshot({
          phases: fsState.phases, currentPhaseIndex: fsState.currentPhaseIndex,
          activeAgents: fsState.activeAgents, paused: fsState.paused,
          startTime: fsState.startTime || now, reviewIterations: fsState.reviewIterations,
          totalFleetTokens: fsState.totalFleetTokens, mainAgentActivity: fsState.mainAgentActivity,
          zfsActive: true, zfsSessionActive: this.zellijAvailable,
          lastAction, lastActionAgo,
        });
      },
      getPlatformInfo: () => ({ shell: this.platform.shell, isWindows: this.platform.isWindows, platform: this.platform.platform }),
    });
    this.statusBarActive = true;
    // Start the status bar manager (fire-and-forget; callers don't await)
    this.statusBarManager.start().catch(() => {});
  }

  destroyStatusBar(): void {
    if (this.statusBarManager) { this.statusBarManager.stop(); this.statusBarManager = null; }
    this.statusBarActive = false;
  }

  refreshStatusBar(): void {
    if (this.statusBarManager && this.statusBarActive) { this.statusBarManager.update(); }
  }

  getStatusBarInfo(): { active: boolean; available: boolean; session: string; pane: string } {
    return { active: this.statusBarActive && this.zellijAvailable, available: this.zellijAvailable, session: this.sessionName, pane: "status-bar" };
  }

  async pauseAll(): Promise<boolean> {
    this.paused = true;
    for (const [, pane] of this.panes) {
      if (pane.process && pane.running) {
        try {
          if (os.platform() === "win32") {
            spawn("wmic", ["process", "where", `processid=${pane.process.pid}`, "call", "suspend"], { stdio: "ignore", shell: true });
          } else { process.kill(pane.process.pid, "SIGSTOP"); }
        } catch { /* ignore */ }
      }
    }
    for (const [, proc] of this.activeProcesses) { proc.abortController?.abort(); }
    return true;
  }

  async resumeAll(): Promise<boolean> {
    this.paused = false; this.skipAgent = null;
    for (const [, pane] of this.panes) {
      if (pane.process) {
        try { process.kill(pane.process.pid, "SIGCONT"); } catch { /* already dead */ }
      }
    }
    return true;
  }

  skipPane(agentName: string): boolean {
    this.skipAgent = agentName;
    for (const [paneId, pane] of this.panes) {
      if (pane.agent === agentName && pane.running) {
        pane.exited = true; pane.running = false; pane.endTime = Date.now();
        if (pane.process) { killProcessTree(pane.process.pid); }
      }
    }
    for (const [paneId, proc] of this.activeProcesses) {
      if (paneId.includes(agentName)) { proc.abortController?.abort(); if (proc.pid) killProcessTree(proc.pid); }
    }
    return true;
  }

  async sendSignalToPane(paneId: string, signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGSTOP" | "SIGCONT"): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    if (pane.process && pane.running) {
      try { process.kill(pane.process.pid, signal); } catch { return false; }
    }
    return this.sendZellijAction("action", ["send-key", "-s", this.sessionName, "-n", pane.name, signal]);
  }

  getFleetState(): { zellijAvailable: boolean; paused: boolean; sessionName: string; activePanes: number; exitedPanes: number; activeProcesses: number; platform: PlatformInfo } {
    return {
      zellijAvailable: this.zellijAvailable, paused: this.paused, sessionName: this.sessionName,
      activePanes: Array.from(this.panes.values()).filter((p) => p.running).length,
      exitedPanes: Array.from(this.panes.values()).filter((p) => p.exited).length,
      activeProcesses: this.activeProcesses.size, platform: this.platform,
    };
  }

  async cleanup(): Promise<void> {
    for (const paneId of Array.from(this.panes.keys())) {
      const pane = this.panes.get(paneId);
      if (pane && pane.running) {
        if (pane.process) { try { killProcessTree(pane.process.pid); } catch { /* ignore */ } }
        pane.running = false; pane.exited = true; pane.endTime = Date.now();
      }
    }
    this.panes.clear();
    for (const [, proc] of this.activeProcesses) {
      proc.abortController?.abort();
      if (proc.pid) killProcessTree(proc.pid);
    }
    this.activeProcesses.clear();
    await this.killSession(this.sessionName);
    this.destroyStatusBar();
  }

  registerExtension(pi: ExtensionAPI): void { this.api = pi; }

  registerHook(pi: ExtensionAPI): void {
    const self = this;
    pi.on("session_start", async (_event: any, ctx: any) => {
      self.setCwd(ctx.cwd);
      const init = await self.checkAndInitZellij();
      if (init.available) { ctx.ui.notify("ZFS: Zellij detected - fleet process manager ready", "info"); self.initStatusBar(); }
      else { ctx.ui.notify(`ZFS: ${init.message}`, "warning"); }
    });
    pi.on("session_shutdown", async () => { await self.cleanup(); });

    const registerTool = pi.registerTool.bind(pi);

    registerTool({
      name: "zfs_create_session", label: "ZFS Create Session",
      description: "Create a Zellij session with the fleet layout for sub-agent execution.",
      parameters: Type.Object({ agents: Type.Array(Type.Object({ name: Type.String({ description: "Agent name" }), description: Type.String({ description: "Agent description" }) })) }),
      execute: async (_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) => {
        self.setCwd(ctx.cwd);
        const result = await self.createSession(params.agents);
        onUpdate?.({ content: [{ type: "text", text: result.message }] });
        return { content: [{ type: "text", text: result.message }], details: { success: result.success } };
      },
      promptSnippet: "Create a ZFS fleet session with the given agents",
    });

    registerTool({
      name: "zfs_spawn_pane", label: "ZFS Spawn Pane",
      description: "Spawn a sub-agent task in a dedicated Zellij pane with real-time stdout streaming.",
      parameters: Type.Object({ agentName: Type.String({ description: "Agent name for the pane" }), taskDescription: Type.String({ description: "Task to execute" }), agentModel: Type.Optional(Type.String({ description: "Model to use" })), cwd: Type.Optional(Type.String({ description: "Working directory" })) }),
      execute: async (_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) => {
        self.setCwd(ctx.cwd);
        const result = await self.spawnPane(params.agentName, params.taskDescription, params.agentModel, params.cwd, (chunk: string, aName: string) => { onUpdate?.({ content: [{ type: "text", text: `  [${aName}] ${chunk.slice(0, 120)}` }] }); });
        return { content: [{ type: "text", text: result.success ? `Pane "${result.paneId}" spawned for agent "${params.agentName}"` : `Failed to spawn pane: ${result.message}` }], details: { paneId: result.paneId, success: result.success } };
      },
      promptSnippet: "Spawn a sub-agent in a dedicated ZFS pane",
    });

    registerTool({
      name: "zfs_stop_pane", label: "ZFS Stop Pane",
      description: "Stop (terminate) a sub-agent pane by its ID.",
      parameters: Type.Object({ paneId: Type.String({ description: "Pane ID to stop" }) }),
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const result = await self.stopPane(params.paneId);
        return { content: [{ type: "text", text: result ? `Pane "${params.paneId}" stopped.` : `Pane "${params.paneId}" not found or already stopped.` }], details: { paneId: params.paneId, success: result } };
      },
      promptSnippet: "Stop a ZFS pane",
    });

    registerTool({
      name: "zfs_fleet_state", label: "ZFS Fleet State",
      description: "Get the current fleet state: ZFS availability, pane counts, session info, platform.",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const state = self.getFleetState();
        return { content: [{ type: "text", text: `ZFS Fleet State:\n  Zellij: ${state.zellijAvailable ? "✓ available" : "✗ unavailable"}\n  Session: ${state.sessionName}\n  Paused: ${state.paused}\n  Active panes: ${state.activePanes}\n  Exited panes: ${state.exitedPanes}\n  Active processes: ${state.activeProcesses}\n  Platform: ${state.platform.platform} (${state.platform.shell})\n  Shell: ${state.platform.shellArg} (${state.platform.shellFlag})` }], details: { state } };
      },
      promptSnippet: "Query ZFS fleet state",
    });

    registerTool({
      name: "zfs_pause", label: "ZFS Pause",
      description: "Pause all running panes (SIGSTOP / Windows equivalent).",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const result = await self.pauseAll();
        return { content: [{ type: "text", text: result ? "All panes paused." : "Failed to pause panes." }], details: { paused: result } };
      },
      promptSnippet: "Pause all fleet panes",
    });

    registerTool({
      name: "zfs_resume", label: "ZFS Resume",
      description: "Resume all paused panes (SIGCONT).",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const result = await self.resumeAll();
        return { content: [{ type: "text", text: result ? "All panes resumed." : "Failed to resume panes." }], details: { resumed: result } };
      },
      promptSnippet: "Resume all fleet panes",
    });

    registerTool({
      name: "zfs_skip_agent", label: "ZFS Skip Agent",
      description: "Skip (terminate) a specific agent's pane.",
      parameters: Type.Object({ agentName: Type.String({ description: "Agent name to skip" }) }),
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const result = self.skipPane(params.agentName);
        return { content: [{ type: "text", text: result ? `Agent "${params.agentName}" skipped - pane terminated.` : `Agent "${params.agentName}" not found running.` }], details: { agent: params.agentName, skipped: result } };
      },
      promptSnippet: "Skip a specific agent",
    });

    registerTool({
      name: "zfs_list_panes", label: "ZFS List Panes",
      description: "List all active and exited panes in the fleet session.",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const panes = self.listPanes();
        const lines = panes.map((p) => `  ${p.running ? "▸" : "✗"} ${p.name} (${p.paneId}) ${p.running ? "[running]" : `[exited:${p.exitCode ?? "?"}]`}`);
        return { content: [{ type: "text", text: lines.length > 0 ? `Active panes:\n${lines.join("\n")}` : "No panes registered." }], details: { panes } };
      },
      promptSnippet: "List all fleet panes",
    });

    registerTool({
      name: "zfs_status_bar_info", label: "ZFS Status Bar Info",
      description: "Get the current status bar state: whether it's active, available, session info, and pane name.",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) => {
        self.initStatusBar();
        const info = self.getStatusBarInfo();
        return { content: [{ type: "text", text: `ZFS Status Bar:\n  Active: ${info.active ? "✓ yes" : "○ no"}\n  Available: ${info.available ? "✓ yes" : "○ no"}\n  Session: ${info.session}\n  Pane: ${info.pane}` }], details: { statusbar: info } };
      },
      promptSnippet: "Query ZFS status bar state",
    });

    registerTool({
      name: "zfs_status_bar_update", label: "ZFS Status Bar Update",
      description: "Force an immediate update of the floating pane status bar.",
      parameters: Type.Object({ refresh: Type.Optional(Type.Boolean({ description: "Whether to refresh (default: true)" })) }),
      execute: async (_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) => {
        self.setCwd(ctx.cwd);
        if (!self.zellijAvailable) return { content: [{ type: "text", text: "ZFS not available. Status bar cannot be updated." }], details: { updated: false, reason: "zfs_unavailable" } };
        self.initStatusBar();
        if (params.refresh ?? true) self.refreshStatusBar();
        return { content: [{ type: "text", text: (params.refresh ?? true) ? "Status bar updated and sent to floating pane." : "Status bar initialized. Call zfs_status_bar_update with refresh=true to update." }], details: { updated: true, refreshed: params.refresh ?? true } };
      },
      promptSnippet: "Update the ZFS floating pane status bar",
    });

    registerTool({
      name: "zfs_status_bar_render", label: "ZFS Status Bar Render",
      description: "Render the status bar as text.",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _params: any, _signal: any, onUpdate: any, ctx: any) => {
        self.setCwd(ctx.cwd);
        if (!self.zellijAvailable) return { content: [{ type: "text", text: "ZFS not available." }], details: { rendered: false, reason: "zfs_unavailable" } };
        self.initStatusBar();
        const rendered = self.statusBarManager?.getLastRendered() || "[status bar not yet rendered]";
        return { content: [{ type: "text", text: `--- ZFS Status Bar ---\n\n${rendered}\n\n---\nRendered at: ${new Date().toISOString()}` }], details: { rendered: true } };
      },
      promptSnippet: "Render the ZFS status bar as text",
    });

    registerTool({
      name: "zfs_status_bar_toggle", label: "ZFS Status Bar Toggle",
      description: "Toggle the floating pane status bar on/off.",
      parameters: Type.Object({ enabled: Type.Optional(Type.Boolean({ description: "True to enable, false to disable, or omit to toggle" })) }),
      execute: async (_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) => {
        self.setCwd(ctx.cwd);
        const info = self.getStatusBarInfo();
        if (!info.available) return { content: [{ type: "text", text: "ZFS not available - status bar requires Zellij installed." }], details: { toggled: false, reason: "zfs_unavailable" } };
        self.initStatusBar();
        const targetOn = params.enabled ?? !info.active;
        if (targetOn) {
          self.initStatusBar(); self.refreshStatusBar();
          return { content: [{ type: "text", text: "Status bar enabled." }] };
        } else {
          self.destroyStatusBar();
          return { content: [{ type: "text", text: "Status bar disabled." }] };
        }
      },
      promptSnippet: "Toggle the ZFS floating pane status bar",
    });

    registerTool({
      name: "zfs_layout", label: "ZFS Layout",
      description: "Generate or view the fleet Zellij layout configuration.",
      parameters: Type.Object({ agents: Type.Array(Type.Object({ name: Type.String({ description: "Agent name" }), description: Type.String({ description: "Agent description" }) })), customWidth: Type.Optional(Type.Number({ description: "Left column width percentage" })), preview: Type.Optional(Type.Boolean({ description: "Preview the KDL layout string" })) }),
      execute: async (_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) => {
        self.setCwd(ctx.cwd);
        const kdl = generateFleetLayout(params.agents, params.customWidth);
        if (params.preview) onUpdate?.({ content: [{ type: "text", text: `--- KDL Layout ---\n${kdl}` }] });
        const layoutPath = path.join(ctx.cwd, FLEET_LAYOUT_FILE);
        try { fs.writeFileSync(layoutPath, kdl, "utf-8"); } catch { /* ignore */ }
        return { content: [{ type: "text", text: `Fleet layout generated (${params.agents.length} agents, left:${params.customWidth ?? 60}%)\nSaved to: ${layoutPath}\n\nRun: zellij session create -s caravel --layout ${layoutPath}` }], details: { layout: kdl, savedPath: layoutPath } };
      },
      promptSnippet: "Generate fleet Zellij layout",
    });
  }
}


// ===========================================================================
// Background Process Manager - launches fleet as a detached process,
// supports migrating running fleet to ZFS mid-execution.
// ===========================================================================

interface BackgroundProcessState {
  running: boolean;
  pid: number | null;
  stateFile: string;
  startedAt: number;
  cwd: string;
  // ZFS migration state (populated after migrate_to_zfs)
  zfsSession?: {
    sessionName: string;
    layoutPath: string;
    agentPanes: string[];
    statusBarActive: boolean;
    migratedAt: number;
  };
}

class BackgroundProcessManager {
  private state: BackgroundProcessState;

  constructor() {
    this.state = { running: false, pid: null, stateFile: "", startedAt: 0, cwd: process.cwd() };
  }

  getState(): BackgroundProcessState { return { ...this.state }; }

  setCwd(cwd: string): void {
    this.state.cwd = cwd;
    this.state.stateFile = stateFilePath(cwd);
  }

  /**
   * Save the current fleet state and launch it as a background process.
   * The parent pi process can then exit while the fleet continues.
   */
  async startBackground(ctx: ExtensionContext): Promise<{ success: boolean; message: string }> {
    // Save current state first
    saveState();

    // If already running in background, stop it first
    if (this.state.running && this.state.pid) {
      await this.stopBackground();
    }

    // If migrating from ZFS, transfer state to bg mode
    if (this.state.zfsSession) {
      // ZFS migration happened - just update state, don't re-spawn
      this.state.zfsSession = undefined;
      this.state.running = true;
      this.state.startedAt = Date.now();
      this.state.stateFile = stateFilePath(ctx.cwd);
      saveState();
      return { success: true, message: "Background mode activated. Fleet state saved. Use /bg-status to monitor." };
    }

    const bgProc = spawn(
      process.execPath,
      [process.argv[1], "--bg-mode"],
      { detached: true, stdio: "ignore", cwd: ctx.cwd, shell: os.platform() === "win32" }
    );

    this.state = {
      running: true,
      pid: bgProc.pid ?? null,
      stateFile: stateFilePath(ctx.cwd),
      startedAt: Date.now(),
      cwd: ctx.cwd,
    };

    // Allow parent to exit without waiting for child
    bgProc.unref();

    return {
      success: true,
      message:
        `✅ Fleet launched as background process.\n\n` +
        `  PID: ${this.state.pid ?? "unknown"}\n` +
        `  State: ${this.state.stateFile}\n` +
        `  Started: ${new Date(this.state.startedAt).toISOString()}\n\n` +
        `  You can now close pi. Fleet continues running in background.\n` +
        `  Use /bg-status to check progress.`,
    };
  }

  /**
   * Stop the background fleet process (if running).
   * Fleet state is preserved in state.json for resumption.
   */
  async stopBackground(): Promise<{ success: boolean; message: string }> {
    if (!this.state.running || !this.state.pid) {
      return { success: false, message: "No background fleet is running." };
    }

    const pid = this.state.pid;
    try {
      if (os.platform() === "win32") {
        spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", shell: true });
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ } }
      }
    } catch {
      // Process may have already exited
    }

    const prevPid = pid;
    this.state = { running: false, pid: null, stateFile: this.state.stateFile, startedAt: 0, cwd: this.state.cwd };

    return {
      success: true,
      message:
        `Background fleet stopped (PID ${prevPid}).\n` +
        `  State preserved at: ${this.state.stateFile}\n` +
        `  Use /bg-start to relaunch from saved state.`,
    };
  }

  /**
   * Migrate a running fleet to a ZFS session.
   * This checkpoint state, creates a ZFS session with agent panes,
   * and transfers monitoring to the ZFS floating status bar.
   */
  async migrateToZFS(ctx: ExtensionContext): Promise<{ success: boolean; message: string }> {
    // Save state checkpoint
    saveState();

    const zfs = ensureZFS();
    const zfsCheck = await zfs.checkAndInitZellij();
    if (!zfsCheck.available) {
      return { success: false, message: `ZFS migration failed: ${zfsCheck.message}` };
    }

    // Check if session already exists
    const zfsState = zfs.getFleetState();
    if (zfsState.activePanes > 0 || zfsState.activeProcesses > 0) {
      // ZFS session exists - refresh it instead
      zfs.initStatusBar();
      zfs.refreshStatusBar();
      this.state.zfsSession = { sessionName: zfsState.sessionName, layoutPath: "", agentPanes: [], statusBarActive: true, migratedAt: Date.now() };
      return { success: true, message: "ZFS session already active - status bar refreshed. Fleet continues in ZFS." };
    }

    // Discover agents for the ZFS layout
    const allAgents = discoverAgents("both");
    const agentDefs = allAgents
      .filter((a) => a.name !== "orchestrator")
      .map((a) => ({ name: a.name, description: a.description }));

    if (agentDefs.length === 0) {
      return { success: false, message: "No agents configured. Cannot create ZFS layout." };
    }

    // Create ZFS session
    const sessionResult = await zfs.createSession(agentDefs, ctx.cwd);
    if (!sessionResult.success) {
      return { success: false, message: `Failed to create ZFS session: ${sessionResult.message}` };
    }

    // Initialize status bar
    zfs.initStatusBar();

    // Spawn orchestrator pane to continue fleet execution
    const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
    const nextTask = currentPhase
      ? currentPhase.tasks.find((t) => t.status !== "complete")
      : null;

    if (nextTask) {
      // Spawn orchestrator to continue execution
      await zfs.spawnPane(
        "orchestrator",
        `Continue fleet execution from checkpoint. Current phase: ${currentPhase.name} (${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}). Current progress: ${fleetState.phases.reduce((s, p) => s + p.tasks.filter(t => t.status === "complete").length, 0)}/${fleetState.phases.reduce((s, p) => s + p.tasks.length, 0)} tasks complete.`,
        undefined,
        ctx.cwd
      );
    }

    // Spawn agent panes for active tasks
    const agentPanes: string[] = [];
    for (const phase of fleetState.phases) {
      for (const task of phase.tasks) {
        if (task.status === "running" || task.status === "reviewing") {
          const paneResult = await zfs.spawnPane(task.agentName, task.description, undefined, ctx.cwd);
          if (paneResult.success) agentPanes.push(paneResult.paneId);
        }
      }
    }

    this.state.zfsSession = {
      sessionName: zfsState.sessionName,
      layoutPath: path.join(ctx.cwd, "zellij-layout.kdl"),
      agentPanes,
      statusBarActive: true,
      migratedAt: Date.now(),
    };

    return {
      success: true,
      message:
        `✅ Fleet migrated to ZFS.\n\n` +
        `  Session: ${zfsState.sessionName}\n` +
        `  Agent panes: ${agentPanes.length}\n` +
        `  Status bar: active\n` +
        `  Layout: ${path.join(ctx.cwd, "zellij-layout.kdl")}\n\n` +
        `  Fleet continues inside ZFS. Use /zellij-status for overview.`,
    };
  }

  /**
   * Export ZFS fleet back to background mode.
   * Stops ZFS, spawns a new background process.
   */
  async exportToBackground(): Promise<{ success: boolean; message: string }> {
    const zfs = ensureZFS();
    const zfsState = zfs.getFleetState();

    // If no ZFS session, nothing to export
    if (!zfsState.zellijAvailable || (zfsState.activePanes === 0 && zfsState.activeProcesses === 0)) {
      // Check if there's already a ZFS session that's just idle
      if (zfsState.zellijAvailable) {
        return { success: false, message: "No ZFS session to export." };
      }
      return { success: false, message: "ZFS not available." };
    }

    // Stop ZFS session (preserves fleet state in state.json)
    await zfs.cleanup();

    // Spawn a new background process
    const bgProc = spawn(
      process.execPath,
      [process.argv[1], "--bg-mode"],
      { detached: true, stdio: "ignore", cwd: this.state.cwd, shell: os.platform() === "win32" }
    );

    this.state = {
      running: true,
      pid: bgProc.pid ?? null,
      stateFile: this.state.stateFile,
      startedAt: Date.now(),
      cwd: this.state.cwd,
    };
    this.state.zfsSession = undefined;
    bgProc.unref();

    return {
      success: true,
      message:
        `ZFS session stopped. Fleet exported to background.\n\n` +
        `  PID: ${this.state.pid ?? "unknown"}\n` +
        `  State: ${this.state.stateFile}\n` +
        `  Use /bg-status to monitor.`,
    };
  }

  /**
   * Check if a background process with the given PID is still alive.
   */
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // No-op check: throws if process doesn't exist
      return true;
    } catch {
      return false;
    }
  }
}


// ===========================================================================
// Types
// ============================================================================

interface FleetState {
  phases: FleetPhase[];
  currentPhaseIndex: number;
  activeAgents: FleetAgentInfo[];
  paused: boolean;
  startTime: number;
  reviewIterations: number;
  maxReviewIterations: number;
  recentOutput: string;
  totalFleetTokens: number;
  mainAgentActivity?: {
    status: "idle" | "executing" | "thinking" | "waiting";
    action: string;
    detail: string;
    timestamp: number;
  };
}

interface FleetPhase {
  id: string;
  name: string;
  status: "pending" | "running" | "reviewing" | "complete" | "failed";
  tasks: FleetTask[];
  completedAt?: number;
}

interface FleetTask {
  id: string;
  agentName: string;
  description: string;
  status: "pending" | "running" | "reviewing" | "complete" | "needs_fix" | "failed";
  output?: string;
  stderr?: string;
  /** Files the agent modified during this task (if tracked). */
  filesModified?: string[];
  reviewFeedback?: string;
  reviewCount: number;
  maxReviewCount: number;
  codeReviewStatus?: "pending" | "approved" | "needs_fix" | "failed";
  codeReviewFeedback?: string;
  designReviewStatus?: "pending" | "approved" | "needs_fix" | "failed";
  designReviewFeedback?: string;
  agentModel?: string;
  tokensUsed?: number;
  messageCount?: number;
  startedAt?: number;
  metadata?: { preFlight?: PreFlightScan; agentIdentity?: string; [key: string]: unknown };
}

const TASK_OUTPUT_MAX_LINES = 500;

/**
 * Build a detailed task output string that captures the full stderr
 * and first/last lines of stdout for effective error debugging.
 */
function buildTaskOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  const hasStderr = stderr && stderr.trim().length > 0;
  const hasStdout = stdout && stdout.trim().length > 0;

  if (!hasStderr && !hasStdout) {
    return "<no output>";
  }

  if (hasStderr) {
    parts.push("=== STDERR ===");
    const stderrLines = stderr.split("\n");
    if (stderrLines.length > TASK_OUTPUT_MAX_LINES) {
      const firstLines = stderrLines.slice(0, TASK_OUTPUT_MAX_LINES / 2);
      const lastLines = stderrLines.slice(stderrLines.length - TASK_OUTPUT_MAX_LINES / 2);
      parts.push(...firstLines, `... [${stderrLines.length - TASK_OUTPUT_MAX_LINES} lines truncated] ...`, ...lastLines);
    } else {
      parts.push(...stderrLines);
    }
    parts.push("==========");
  }

  if (hasStdout) {
    parts.push("=== STDOUT ===");
    const stdoutLines = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (stdoutLines.length <= 10) {
      parts.push(...stdoutLines);
    } else {
      // First 5 non-empty lines
      parts.push(...stdoutLines.slice(0, 5));
      parts.push("... [truncated] ...");
      // Last 5 non-empty lines
      parts.push(...stdoutLines.slice(-5));
    }
    parts.push("==========");
  }

  return parts.join("\n");
}

interface PreFlightScan {
  totalFiles: number;
  totalDirs: number;
  techStack: string[];
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  hasTests: boolean;
  hasCI: boolean;
  configFileCount: number;
  entryPoints: string[];
  scanTimestamp: string;
}

interface FleetAgentInfo {
  name: string;
  status: "idle" | "running" | "reviewing" | "error";
  currentTask?: string;
  model?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
}

interface AnalysisResult {
  agent: AgentDefinition;
  task: FleetTask;
  preFlight: PreFlightScan;
  output: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; contextTokens: number; turns: number };
  elapsedMs: number;
  errors: string[];
  success: boolean;
}

// ============================================================================
// State
// ============================================================================

let fleetState: FleetState = {
  phases: [],
  currentPhaseIndex: 0,
  activeAgents: [],
  paused: false,
  startTime: Date.now(),
  reviewIterations: 0,
  maxReviewIterations: 5,
  recentOutput: "",
  totalFleetTokens: 0,
  mainAgentActivity: {
    status: "idle",
    action: "idle",
    detail: "No active work",
    timestamp: Date.now(),
  },
};

let widgetVisible = true;

// ── Health monitoring config ───────────────────────────────────────────────────
let healthConfig = { enabled: false };
let _pi: ExtensionAPI | null = null;
const activeProcesses = new Map<string, { proc: ReturnType<typeof spawn>; signal: AbortSignal }>();

// ── ZFS fleet instance (bridges ZFS process management with fleet state) ──
let zfs: ZFS | null = null;

// ── Background process manager (bridges background execution with ZFS migration) ──
const bgManager = new BackgroundProcessManager();

function getBgManager(): BackgroundProcessManager {
  bgManager.setCwd(_pi?.cwd ?? process.cwd());
  return bgManager;
}

function ensureZFS(): ZFS {
  if (!zfs) {
    zfs = new ZFS();
    zfs.setCwd(process.cwd());
    zfs.checkAndInitZellij();
  }
  return zfs;
}

// ============================================================================
// Follow system - track which agent's live output the user is watching
// ============================================================================

interface FollowState {
  agent: string | null;      // Name of the agent being followed (null = no follow)
  output: string;             // Accumulated output buffer
  isLive: boolean;            // Whether this agent is currently running
}

let followedAgent: FollowState = {
  agent: null,
  output: "",
  isLive: false,
};

// Per-agent output capture: maps task/agent IDs to their output
const agentOutputBuffers = new Map<string, { stdout: string; stderr: string; running: boolean }>();

/** Append text to the followed agent's buffer if it matches. */
function appendToFollowedAgent(agentName: string, text: string): void {
  if (followedAgent.agent === agentName) {
    followedAgent.output += text;
  }
  const key = `agent-${agentName}`;
  const buf = agentOutputBuffers.get(key);
  if (buf) {
    buf.stdout = safeAppend(buf.stdout, text, 500_000);
  }
}

/** Append stderr to the followed agent's buffer if it matches. */
function appendErrToFollowedAgent(agentName: string, text: string): void {
  if (followedAgent.agent === agentName) {
    followedAgent.output += text;
  }
  const key = `agent-${agentName}`;
  const buf = agentOutputBuffers.get(key);
  if (buf) {
    buf.stderr = safeAppend(buf.stderr, text, 500_000);
  }
}

/** Get the accumulated output for a given agent. */
function getAgentOutput(agentName: string): string {
  const key = `agent-${agentName}`;
  const buf = agentOutputBuffers.get(key);
  return buf ? buf.stdout : "";
}

/** Check if an agent is currently running. */
function isAgentRunning(agentName: string): boolean {
  return agentOutputBuffers.has(`agent-${agentName}`);
}

// ============================================================================
// Agent Discovery
// ============================================================================

interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  tools: string[];
  systemPrompt: string;
  source: "project" | "user";
}

function discoverAgents(scope: "project" | "user" | "both" = "user"): AgentDefinition[] {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir();

  const loadFromDir = (dir: string, source: "project" | "user"): AgentDefinition[] => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .flatMap((entry) => {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
          return parseAgentDef(content, source);
        } catch {
          return [];
        }
      });
  };

  const userAgents = loadFromDir(userDir, "user");
  if (scope === "project") return loadFromDir(projectAgentsDir ?? "", "project");
  if (scope === "user") return userAgents;

  const map = new Map<string, AgentDefinition>();
  userAgents.forEach((a) => map.set(a.name, a));
  loadFromDir(projectAgentsDir ?? "", "project").forEach((a) => map.set(a.name, a));
  return Array.from(map.values());
}

function findNearestProjectAgentsDir(): string | null {
  let currentDir = process.cwd();
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

function parseAgentDef(content: string, source: "project" | "user"): AgentDefinition | null {
  if (!content.startsWith("---")) return null;
  const endFrontmatter = content.indexOf("---", 3);
  if (endFrontmatter < 0) return null;
  const fm = content.slice(3, endFrontmatter).trim();
  const body = content.slice(endFrontmatter + 3).trim();
  const extract = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim();
  };
  const name = extract("name");
  const description = extract("description");
  const model = extract("model");
  const tools = extract("tools")?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
  if (!name || !description || !model) return null;
  return { name, description, model, tools, systemPrompt: body, source };
}

// ===========================================================================
// Helpers
// ===========================================================================

function dirname(p: string): string { return path.dirname(p); }

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + " " : s;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function formatTokens(count: number): string {
  if (count == null || isNaN(count)) return "0";
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.001) return `$${(cost * 1000).toFixed(1)}m`;
  return `$${cost.toFixed(4)}`;
}
// ============================================================================
// Fleet Error Diagnosis
// ============================================================================

interface Diagnosis {
  cause: string;
  severity: "critical" | "warning" | "info";
  explanation: string;
  fixSteps: string[];
  affected: string;
}

interface ErrorDiagnosisResult {
  summary: string;
  causes: Diagnosis[];
  overallAction: string;
  affectedPhases: FleetPhase[];
  affectedTasks: FleetTask[];
}

function diagnosePhaseErrors(phase: FleetPhase, allAgents: AgentDefinition[]): Diagnosis[] {
  const diagnoses: Diagnosis[] = [];
  const failedTasks = phase.tasks.filter((t) => t.status === "failed");
  if (failedTasks.length === 0) return diagnoses;

  const taskErrors = new Map<string, { stderr?: string; exitCode?: number; errors?: string[]; reviewFeedback?: string; codeReviewStatus?: string; designReviewStatus?: string }>();
  for (const t of failedTasks) {
    taskErrors.set(t.id, {
      stderr: t.reviewFeedback || "",
      exitCode: undefined,
      errors: [],
      reviewFeedback: t.reviewFeedback,
      codeReviewStatus: t.codeReviewStatus,
      designReviewStatus: t.designReviewStatus,
    });
  }

  // Also gather stderr from recent fleet output
  const recentOutput = fleetState.recentOutput || "";

  // Check for missing agents
  for (const t of failedTasks) {
    const agentDef = allAgents.find((a) => a.name === t.agentName);
    if (!agentDef) {
      const available = allAgents.map((a) => a.name).join(", ") || "(none)";
      diagnoses.push({
        cause: `Missing agent: "${t.agentName}"`,
        severity: "critical",
        explanation: `Task required agent "${t.agentName}" but it was not found in any agents/ directory.`,
        fixSteps: [
          `Create agents/${t.agentName}.md with valid frontmatter (name, description, model)`,
          `Available agents: ${allAgents.length > 0 ? available : "(none configured)"}`,
          `Example frontmatter:\n  ---\n  name: ${t.agentName}\n  description: Agent description\n  model: <your-model>\n  ---\n  Agent system prompt...`,
        ],
        affected: `${phase.name} → ${t.description.slice(0, 50)}`,
      });
    }
  }

  // Check for review-related failures
  for (const t of failedTasks) {
    const info = taskErrors.get(t.id)!;

    if (info.reviewFeedback && (info.reviewFeedback.includes("missing") || info.reviewFeedback.includes("not found") || info.reviewFeedback.includes("not configured"))) {
      const missingAgentMatch = info.reviewFeedback.match(/["']?(?:tech-lead|designer|developer)["']?/i);
      if (missingAgentMatch) {
        const agentName = missingAgentMatch[0];
        const available = allAgents.map((a) => a.name).join(", ") || "(none)";
        diagnoses.push({
          cause: `Missing review agent: "${agentName}"`,
          severity: "critical",
          explanation: `Review could not complete because agent "${agentName}" was not available.`,
          fixSteps: [
            `Create agents/${agentName}.md with a valid model configured`,
            `Available agents: ${allAgents.length > 0 ? available : "(none configured)"}`,
          ],
          affected: `${phase.name} → ${t.description.slice(0, 50)}`,
        });
      }
    }

    // Check for code review specific failures
    if (info.codeReviewStatus === "failed" && info.codeReviewFeedback) {
      const fb = info.codeReviewFeedback;
      if (fb.includes("exit code") || fb.includes("exited with code")) {
        const exitMatch = fb.match(/exit code (\d+)/i);
        const code = exitMatch ? exitMatch[1] : "unknown";
        diagnoses.push({
          cause: `Code review agent exited abnormally (code ${code})`,
          severity: "critical",
          explanation: `The tech-lead agent failed to complete the code review, likely due to a configuration error, missing model, or runtime error.`,
          fixSteps: [
            `Verify the tech-lead agent's model is accessible`,
            `Check agents/tech-lead.md for valid model configuration`,
            `Try running: pi --model <model> "Review the code"`,
          ],
          affected: `${phase.name} → ${t.description.slice(0, 50)}`,
        });
      }
    }

    // Check for design review specific failures
    if (info.designReviewStatus === "failed" && info.designReviewFeedback) {
      const fb = info.designReviewFeedback;
      if (fb.includes("exit code") || fb.includes("exited with code")) {
        const exitMatch = fb.match(/exit code (\d+)/i);
        const code = exitMatch ? exitMatch[1] : "unknown";
        diagnoses.push({
          cause: `Design review agent exited abnormally (code ${code})`,
          severity: "critical",
          explanation: `The designer agent failed to complete the design review.`,
          fixSteps: [
            `Verify the designer agent's model supports vision (required for design review)`,
            `Check agents/designer.md for valid model configuration`,
            `Try running: pi --model <model> "Review the design"`,
          ],
          affected: `${phase.name} → ${t.description.slice(0, 50)}`,
        });
      }
    }
  }

  // Check recent output for common error patterns
  const errorPatterns: Array<{ pattern: RegExp; cause: string; severity: "critical" | "warning"; steps: string[] }> = [
    {
      pattern: /no analyzer agent|no agent configured/i,
      cause: "No analyzer agent available",
      severity: "critical",
      steps: [
        "Create agents/auditor.md or agents/developer.md with a valid model",
        "Ensure frontmatter includes: name, description, and model",
      ],
    },
    {
      pattern: /exit code [1-9]\d*|exited with code|non-zero exit/i,
      cause: "Agent process exited with non-zero code",
      severity: "critical",
      steps: [
        "Check the agent's model provider status",
        "Verify model name in agents/<name>.md",
        "Run manually: pi --model <model> '<task>'",
        "Check for missing dependencies in the agent's system prompt",
      ],
    },
    {
      pattern: /token limit|context window|context length|maximum context|prompt too long/i,
      cause: "Token context limit exceeded",
      severity: "critical",
      steps: [
        "The task's context (system prompt + task + output) exceeded the model's maximum context window",
        "Reduce the task description or split it into smaller tasks",
        "Use a model with a larger context window (e.g., gpt-4o-128k, claude-sonnet-4-20250514)",
        "Remove unnecessary context from agent system prompts",
      ],
    },
    {
      pattern: /token limit|token count|too many tokens/i,
      cause: "Token budget exceeded",
      severity: "warning",
      steps: [
        "The total token usage is approaching or exceeding limits",
        "Reduce review iterations or use smaller models",
        "Clear old session data to free token budget",
      ],
    },
    {
      pattern: /timeout|timed out|deadline exceeded/i,
      cause: "Agent operation timed out",
      severity: "warning",
      steps: [
        "The model provider is slow or unresponsive",
        "Check your internet connection and API provider status",
        "Try with a smaller/faster model",
        "Simplify the task prompt",
      ],
    },
    {
      pattern: /permission denied|eacces|ENOENT|command not found|spawn/i,
      cause: "Permission or path error",
      severity: "critical",
      steps: [
        "Ensure the process has read access to agents/ directory",
        "Check that 'pi' is in your system PATH",
        "Verify file permissions on agent .md files",
      ],
    },
    {
      pattern: /rate limit|too many requests|429|quota exceeded/i,
      cause: "API rate limit hit",
      severity: "warning",
      steps: [
        "Wait for the rate limit window to reset (typically 1-5 minutes)",
        "Reduce concurrent agent calls",
        "Check your API provider's rate limits and current usage",
      ],
    },
    {
      pattern: /authentication|auth error|unauthorized|api key|invalid token/i,
      cause: "Authentication failure",
      severity: "critical",
      steps: [
        "Verify your API key is valid and not expired",
        "Check your model provider's authentication configuration",
        "Ensure the model name matches an available provider",
      ],
    },
    {
      pattern: /model not found|model does not exist|invalid model/i,
      cause: "Invalid model name",
      severity: "critical",
      steps: [
        "Check the model name in agents/<name>.md",
        "Verify the model exists and is accessible via your provider",
        "Try a known working model name (e.g., gpt-4o, claude-sonnet-4-20250514)",
      ],
    },
    {
      pattern: /failed to create temporary file|tmp|mkdtemp/i,
      cause: "Temporary file creation failed",
      severity: "warning",
      steps: [
        "Ensure /tmp (or TMPDIR) has sufficient disk space",
        "Check write permissions in the temp directory",
      ],
    },
  ];

  for (const pattern of errorPatterns) {
    const combined = `${recentOutput}\n${failedTasks.map(t => t.reviewFeedback || t.output || "").join("\n")}`;
    if (pattern.pattern.test(combined)) {
      // Avoid duplicates for the same cause
      if (!diagnoses.some(d => d.cause === pattern.cause)) {
        diagnoses.push({
          cause: pattern.cause,
          severity: pattern.severity,
          explanation: `Detected pattern matching: ${pattern.cause.toLowerCase()}`,
          fixSteps: pattern.steps,
          affected: `${phase.name} → ${failedTasks.slice(0, 3).map(t => t.description.slice(0, 40)).join(", ")}${failedTasks.length > 3 ? ` +${failedTasks.length - 3} more` : ""}`,
        });
      }
    }
  }

  // Check for empty output (agent ran but produced nothing)
  for (const t of failedTasks) {
    if (!t.output && !t.reviewFeedback) {
      diagnoses.push({
        cause: "Agent produced empty output",
        severity: "warning",
        explanation: `Agent "${t.agentName}" completed but produced no output. This may indicate a silent failure or empty response.`,
        fixSteps: [
          `Run the agent manually: pi --model <model> "${t.description.slice(0, 60)}"`,
          `Check the agent's system prompt for conflicting instructions`,
          `Verify the model is responding normally`,
        ],
        affected: `${phase.name} → ${t.description.slice(0, 50)}`,
      });
    }
  }

  // Check for excessive review iterations (review loop exhaustion)
  for (const t of failedTasks) {
    if (t.codeReviewStatus === "failed" || t.designReviewStatus === "failed") {
      diagnoses.push({
        cause: `Review loop exhausted (${t.codeReviewStatus === "failed" ? "code" : "design"} review)`,
        severity: "warning",
        explanation: `The ${t.codeReviewStatus === "failed" ? "code" : "design"} review failed after ${t.reviewCount} attempts. The agent could not produce a passing review.`,
        fixSteps: [
          `Review the ${t.codeReviewStatus === "failed" ? "code" : "design"} feedback for specific issues`,
          `Manually inspect the generated output in the task's output field`,
          `Consider providing explicit feedback via review_task with feedback parameter`,
          `Try a different model for the failing reviewer`,
        ],
        affected: `${phase.name} → ${t.description.slice(0, 50)}`,
      });
    }
  }

  return diagnoses;
}

function buildErrorGuidance(errors: string[]): string[] {
  const suggestions: string[] = [];
  const lower = errors.join(" ").toLowerCase();

  if (lower.includes("no analyzer agent") || lower.includes("no agent") || lower.includes("agent not found")) {
    suggestions.push("Add an 'auditor.md' or 'developer.md' agent to your agents/ directory");
    suggestions.push("Each agent file must have frontmatter with name, description, and model fields");
  }

  if (lower.includes("no model configured") || lower.includes("model") && lower.includes("not configured")) {
    suggestions.push("Configure the model field in your agent's frontmatter (e.g., model: gpt-4o)");
    suggestions.push("Verify the model is available in your provider or local server");
  }

  if (lower.includes("exit code") || lower.includes("non-zero") || lower.includes("exited")) {
    suggestions.push("Check that the agent's dependencies and model are properly configured");
    suggestions.push("Run the agent manually with 'pi --model <model> <task>' to debug");
  }

  if (lower.includes("spawn") || lower.includes("ENOENT") || lower.includes("command not found")) {
    suggestions.push("Ensure 'pi' or the node executable is in your system PATH");
    suggestions.push("Check that the caravel extension is correctly installed");
  }

  if (lower.includes("permission") || lower.includes("denied") || lower.includes("eacc")) {
    suggestions.push("Check file and directory permissions in the project root");
    suggestions.push("Ensure the process has read access to the agents/ directory");
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    suggestions.push("The agent may have hung - check the model provider status");
    suggestions.push("Try with a smaller model or simpler prompt");
  }

  if (errors.length > 0 && suggestions.length === 0) {
    suggestions.push("Check that all agent files have valid frontmatter (name, description, model)");
    suggestions.push("Verify your model provider is accessible and properly configured");
  }

  return suggestions;
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function diagnoseFleetErrors(): ErrorDiagnosisResult {
  const allAgents = discoverAgents("both");
  const failedPhases = fleetState.phases.filter((p) => p.status === "failed");
  const failedTasks = fleetState.phases.flatMap((p) =>
    p.tasks.filter((t) => t.status === "failed"),
  );

  if (failedPhases.length === 0 && failedTasks.length === 0) {
    return {
      summary: "No errors detected. All phases and tasks are in a non-failed state.",
      causes: [],
      overallAction: "No action needed. Fleet is healthy.",
      affectedPhases: [],
      affectedTasks: [],
    };
  }

  const allCauses: Diagnosis[] = [];

  for (const phase of failedPhases) {
    const phaseDiags = diagnosePhaseErrors(phase, allAgents);
    allCauses.push(...phaseDiags);
  }

  // Also check non-failed phases for failed tasks
  for (const phase of fleetState.phases) {
    if (phase.status !== "failed") {
      const phaseDiags = diagnosePhaseErrors(phase, allAgents);
      allCauses.push(...phaseDiags);
    }
  }

  // Deduplicate by cause
  const seenCauses = new Set<string>();
  const uniqueCauses: Diagnosis[] = [];
  for (const c of allCauses) {
    if (!seenCauses.has(c.cause)) {
      seenCauses.add(c.cause);
      uniqueCauses.push(c);
    }
  }

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
  uniqueCauses.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const criticalCount = uniqueCauses.filter((c) => c.severity === "critical").length;
  const warningCount = uniqueCauses.filter((c) => c.severity === "warning").length;

  let summary = "";
  if (criticalCount > 0) {
    summary = `⚠️ Fleet has ${criticalCount} critical error(s)${warningCount > 0 ? ` and ${warningCount} warning(s)` : ""} that need attention.`;
  } else if (warningCount > 0) {
    summary = `i️ Fleet has ${warningCount} warning(s) to review.`;
  } else {
    summary = `Found failed tasks in the fleet.`;
  }

  let overallAction = "";
  if (criticalCount > 0) {
    overallAction = "Fix the critical issues above before continuing fleet execution.";
  } else if (warningCount > 0) {
    overallAction = "Address the warnings above. The fleet can continue but may encounter issues.";
  } else {
    overallAction = "Review the issues below and fix before retrying.";
  }

  return {
    summary,
    causes: uniqueCauses,
    overallAction,
    affectedPhases: failedPhases,
    affectedTasks: failedTasks,
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const name = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(name)) return { command: process.execPath, args };
  return { command: "pi", args };
}

// ============================================================================
// State persistence - file-based on-disk JSON
// ============================================================================

/** Directory where caravel persists its state files. */
const STATE_DIR = ".caravel";

/** Path to the state file. Resolved at call time using ctx.cwd. */
function stateFilePath(cwd: string): string {
  return path.join(cwd, STATE_DIR, "state.json");
}

/** Version of the state file schema. Bump when schema changes. */
const STATE_VERSION = 1;

interface SerializedFleetState {
  version: number;
  timestamp: number;
  state: FleetState;
}

/**
 * Save fleetState to a JSON file on disk.
 * Uses atomic write (temp file + rename) so a crash mid-write never corrupts the saved state.
 */
function saveState(): void {
  if (!_pi) return;
  const filePath = stateFilePath(_pi.cwd ?? process.cwd());
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: SerializedFleetState = {
      version: STATE_VERSION,
      timestamp: Date.now(),
      state: JSON.parse(JSON.stringify(fleetState)), // deep clone
    };
    const tmpPath = filePath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("[caravel] Failed to save state:", err);
  }
}

/**
 * Load fleetState from the on-disk JSON file.
 * Returns true if a valid saved state was found and applied.
 */
function loadState(ctx: ExtensionContext): boolean {
  const filePath = stateFilePath(ctx.cwd);
  if (!fs.existsSync(filePath)) return false;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  // Validate schema version
  if (parsed.version == null || parsed.state == null) return false;
  if (parsed.version > STATE_VERSION) {
    console.warn(`[caravel] State file version ${parsed.version} is newer than supported version ${STATE_VERSION}.`);
    return false;
  }

  const s = parsed.state;
  if (typeof s.phases !== "object" || !Array.isArray(s.phases)) return false;
  if (typeof s.currentPhaseIndex !== "number") return false;

  // Only restore state if it's actually useful (fleet is actively running)
  // When fleet is idle (no phases, no active agents), clear stale persisted data
  // so the widget bar shows a clean "idle" state, not ghost data from last session.
  const hasActivePhases = (s.phases && Array.isArray(s.phases) && s.phases.some(p => p.status === "running" || p.status === "reviewing"));
  const hasIncompleteTasks = (s.phases && Array.isArray(s.phases) && s.phases.some(p => (p.tasks || []).some(t => t.status !== "complete")));
  const isReallyActive = hasActivePhases || hasIncompleteTasks;

  fleetState = {
    phases: isReallyActive ? (s.phases ?? []) : [],
    currentPhaseIndex: isReallyActive ? (s.currentPhaseIndex ?? 0) : 0,
    activeAgents: isReallyActive ? (s.activeAgents ?? []) : [],
    paused: isReallyActive ? (s.paused ?? false) : false,
    startTime: isReallyActive ? (s.startTime != null && !isNaN(s.startTime) ? s.startTime : Date.now()) : Date.now(),
    reviewIterations: isReallyActive ? (s.reviewIterations ?? 0) : 0,
    maxReviewIterations: s.maxReviewIterations ?? fleetState.maxReviewIterations,
    recentOutput: isReallyActive ? (s.recentOutput ?? "") : "",
    totalFleetTokens: isReallyActive ? (s.totalFleetTokens != null && !isNaN(s.totalFleetTokens) ? s.totalFleetTokens : 0) : 0,
    mainAgentActivity: isReallyActive ? (s.mainAgentActivity ?? fleetState.mainAgentActivity) : {
      status: "idle",
      action: "idle",
      detail: "No active work",
      timestamp: Date.now(),
    },
  };

  return true;
}

/**
 * Check if a saved state file exists and is valid for resumption.
 */
function canResumeState(cwd: string): boolean {
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

/**
 * Remove the on-disk state file.
 */
function clearState(cwd: string): void {
  const filePath = stateFilePath(cwd);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const tmpPath = filePath + ".tmp.";
    const files = fs.readdirSync(path.dirname(filePath));
    for (const f of files) {
      if (f.startsWith("state.json.tmp.")) {
        try { fs.unlinkSync(path.join(path.dirname(filePath), f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore - state is ephemeral
  }
}

// ── Checkpoint data for task recovery ──────────────────────────────────────────

interface CheckpointData {
  identity: string;   // agent name that owned this checkpoint
  summary: string;    // task description summary (truncated)
  taskId: string;
  phaseName: string;
  timestamp: number;
}

/**
 * Load a checkpoint from the on-disk saved fleet state and return task-specific
 * recovery data. Returns null if no checkpoint exists.
 */
function loadCheckpoint(taskId: string): CheckpointData | null {
  const filePath = stateFilePath(process.cwd());
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: SerializedFleetState;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed.state?.phases || !Array.isArray(parsed.state.phases)) return null;

  for (const phase of parsed.state.phases) {
    if (!phase.tasks) continue;
    const task = phase.tasks.find((t) => t.id === taskId);
    if (task) {
      return {
        identity: task.agentName,
        summary: truncate(task.description, 100),
        taskId: task.id,
        phaseName: phase.name,
        timestamp: parsed.timestamp || 0,
      };
    }
  }

  return null;
}

// ============================================================================
// Widget bar - always exactly 4 lines, left-edge only
// ============================================================================

// ============================================================================
// REVAMPED WIDGET BAR — 3-line compact layout
// ============================================================================
// Line 1: CARAVEL FLEET | <status> | % progress | N agents configured | elapsed
// Line 2: reviews: passed N  failed N | last: <action>
// Line 3: Agent lights: [●] name │ tokens │ status/task
// ============================================================================

function buildWidgetLines(ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;
  const now = Date.now();

  const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = fleetState.phases.reduce(
    (s, p) => s + p.tasks.filter((t) => t.status === "complete").length,
    0,
  );
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const elapsed = formatDuration(now - fleetState.startTime);

  const muted = (t: string) => theme.fg("muted", t);
  const dim = (t: string) => theme.fg("dim", t);

  // ── Idle state ──
  const allComplete = fleetState.phases.length > 0 && fleetState.phases.every(p => p.status === "complete");
  const isIdle = fleetState.phases.length === 0 || allComplete;
  if (isIdle) {
    if (allComplete) {
      fleetState = {
        phases: [],
        currentPhaseIndex: 0,
        activeAgents: [],
        paused: false,
        startTime: Date.now(),
        reviewIterations: 0,
        maxReviewIterations: fleetState.maxReviewIterations,
        recentOutput: "",
        totalFleetTokens: 0,
        mainAgentActivity: { status: "idle", action: "idle", detail: "No active work", timestamp: Date.now() },
      };
      saveState();
    }

    // ── Line 1 ──
    const allAgents = discoverAgents("both");
    const agentCount = allAgents.length;
    const statusIcon = fleetState.paused ? theme.fg("warning", "⏸") : theme.fg("muted", "●");
    const statusText = fleetState.paused ? "PAUSED" : "IDLE";
    const sc = fleetState.paused ? "warning" : "muted";
    const title = theme.fg("accent", "CARAVEL FLEET");
    const line1 = `${title}  ${muted("│")}  ${theme.fg(sc, statusIcon + " " + statusText)}  ${muted("│")}  [${"░".repeat(20)}] 0%  ${muted("│")}  ${agentCount} agents configured  ${muted("│")}  ${elapsed}`;

    // ── Line 2 ──
    const codeApproved = fleetState.reviewIterations > 0 ? fleetState.reviewIterations : 0;
    const codeFailed = 0;
    const lastAction = fleetState.mainAgentActivity?.action || "idle";
    const line2 = `reviews:  ${muted(`${codeApproved} passed  ${codeFailed} failed`)}  ${muted("│")}  last: ${dim(lastAction === "idle" ? "no active work yet" : lastAction)}`;

    // ── Line 3: agent lights ──
    const lights = allAgents.map((a) => {
      const inactive = dim("●");
      const name = a.name.length > 8 ? a.name.slice(0, 7) + ".." : a.name;
      const padded = name.padEnd(8);
      return `${inactive} ${padded}`;
    }).join("  │  ");
    const line3 = `agent lights: ${lights}`;

    return [line1, line2, line3];
  }

  // ── ACTIVE ──
  const phase = fleetState.phases[fleetState.currentPhaseIndex];
  const cleanPhaseName = phase.name.replace(/^(Phase )?P\d+:\s*/i, "");
  const phaseLabel = phase
    ? theme.fg("accent", `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${cleanPhaseName}`)
    : theme.fg("muted", "No current phase");

  const sIcon = phase
    ? phase.status === "complete" ? theme.fg("success", "✓")
    : phase.status === "failed" ? theme.fg("error", "✗")
    : (phase.status === "running" || phase.status === "reviewing") ? theme.fg("accent", "▸")
    : theme.fg("muted", "○")
    : theme.fg("muted", "○");
  const sText = phase
    ? (phase.status === "complete" ? "DONE" : phase.status === "failed" ? "FAILED" : phase.status === "reviewing" ? "REV" : "RUN")
    : "UNKNOWN";
  const sColor = phase
    ? (phase.status === "complete" ? "success" : phase.status === "failed" ? "error" : "accent")
    : "muted";

  const filled = Math.round((progress / 100) * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);

  // Review counts
  const codeApproved = fleetState.reviewIterations;
  const codeFailed = 0;
  const reviewPassed = codeApproved > 0 ? `${codeApproved} passed` : "○ 0 passed";
  const reviewFailed = `${codeFailed} failed`;

  // ── Line 1 ──
  const allAgents = discoverAgents("both");
  const agentCount = allAgents.length;
  const line1 = `${theme.fg("accent", "CARAVEL FLEET")}  ${muted("│")}  ${phaseLabel}  ${muted("│")}  ${theme.fg(sColor, sIcon + " " + sText)}  ${muted("│")}  [${bar}] ${progress}%  ${muted("│")}  ${agentCount} agents configured  ${muted("│")}  ${elapsed}`;

  // ── Line 2: reviews + last action ──
  const ma = fleetState.mainAgentActivity;
  let lastActionStr = "idle - no active work yet";
  if (ma && ma.action !== "idle") {
    const age = now - ma.timestamp;
    const ts = age < 60000 ? `${Math.round(age / 1000)}s ago`
      : age < 3600000 ? `${Math.round(age / 60000)}m ago`
      : `${Math.round(age / 3600000)}h ago`;
    lastActionStr = `${ma.action} → ${truncate(ma.detail, 30)} (${ts})`;
  } else {
    const activeAgentsList = fleetState.activeAgents.filter((a) => a.status !== "idle");
    if (activeAgentsList.length > 0) {
      lastActionStr = `${activeAgentsList[0].name} active`;
    }
  }
  const line2 = `reviews:  ${reviewPassed}  ${dim(reviewFailed)}  ${muted("│")}  last: ${lastActionStr}`;

  // ── Line 3: agent lights ──
  const activeAgentsList = fleetState.activeAgents.filter((a) => a.status !== "idle");
  const allAgentsInFleet = new Set<string>();
  for (const phase of fleetState.phases) {
    for (const t of phase.tasks) allAgentsInFleet.add(t.agentName);
  }
  for (const agent of fleetState.activeAgents) allAgentsInFleet.add(agent.name);

  const lights = allAgentsInFleet.map((name) => {
    const agent = fleetState.activeAgents.find((a) => a.name === name);
    const isActive = !!agent;
    const task = fleetState.phases.flatMap(p => p.tasks).find((t) => t.agentName === name);

    let light: string;
    let color: string;
    if (!isActive) {
      light = dim("●");
      color = "dim";
    } else if (agent.status === "running") {
      light = theme.fg("success", "●");
      color = "success";
    } else if (agent.status === "reviewing") {
      light = theme.fg("accent", "●");
      color = "accent";
    } else if (agent.status === "error") {
      light = theme.fg("error", "●");
      color = "error";
    } else {
      light = dim("●");
      color = "dim";
    }

    const name = name.length > 8 ? name.slice(0, 7) + ".." : name;
    const padded = name.padEnd(8);

    if (task) {
      const tokens = formatTokens(task.tokensUsed || 0);
      const taskShort = (task.description || "").replace(/^(Phase )?P\d+T\d+:\s*/i, "").slice(0, 18);
      const status = agent.status === "running" ? "run" : agent.status === "reviewing" ? "rev" : "err";
      return `${light} ${padded}  ${dim(tokens)}  ${theme.fg(color, status)}  ${dim(taskShort)}`;
    }
    return `${light} ${padded}  ${dim("idle")}`;
  }).join("  │  ");

  const line3 = `agent lights: ${lights}`;

  return [line1, line2, line3];
}

/**
 * Update or create the persistent widget bar.
 * Always creates exactly one widget, never stacks multiple bars.
 */
function refreshWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("caravel-fleet", widgetVisible ? buildWidgetLines(ctx) : []);
}

function setWidgetVisibility(ctx: ExtensionContext, visible: boolean): void {
  widgetVisible = visible;
  refreshWidget(ctx);
}

// ============================================================================
// Subagent execution
// ============================================================================

async function runSubagent(
  agent: AgentDefinition,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  procId?: string,
  onUpdate?: (chunk: string) => void,
): Promise<{ output: string; stderr: string; exitCode: number; messages: Message[]; usage: any; model: string }> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

  let tmpPath: string | null = null;
  if (agent.systemPrompt?.trim()) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "caravel-"));
    tmpPath = path.join(tmpDir, `prompt-${agent.name.replace(/\s/g, "-")}.md`);
    await fs.promises.writeFile(tmpPath!, agent.systemPrompt, "utf-8");
    args.push("--append-system-prompt", tmpPath);
  }

  args.push(task);

  const result: { output: string; stderr: string; exitCode: number; messages: Message[]; usage: any; model: string } = {
    output: "",
    stderr: "",
    exitCode: 0,
    messages: [],
    model: agent.model || "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  return new Promise((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (procId) {
      const abortSignal = signal ?? (new AbortController()).signal;
      activeProcesses.set(procId, { proc, signal: abortSignal });
    }

    let buffer = "";
    let lastAgentOutput = "";
    const currentTokens = { input: 0, output: 0, total: 0 };

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      if (onUpdate) {
        onUpdate(text, currentTokens.total);
      }
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    let stderrBuffer = "";
    proc.stderr.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    proc.on("close", (code) => {
      if (stderrBuffer) {
        result.stderr = stderrBuffer;
      }
      if (buffer.trim()) processLine(buffer);
      // code is null when process is killed by signal — treat as failure
      result.exitCode = code != null ? code : -1;
      result.output = lastAgentOutput || "";
      if (tmpPath) {
        try {
          fs.unlinkSync(tmpPath);
          fs.rmdirSync(path.dirname(tmpPath));
        } catch { /* ignore */ }
      }
      activeProcesses.delete(procId ?? "");
      resolve(result);
    });

    proc.on("error", () => {
      result.exitCode = 1;
      activeProcesses.delete(procId ?? "");
      resolve(result);
    });

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        },
        { once: true },
      );
      if (signal.aborted) {
        proc.kill("SIGTERM");
        resolve(result);
      }
    }

    function processLine(line: string) {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
          result.usage.turns++;
          const u = msg.usage;
          if (u) {
            result.usage.input += u.input || 0;
            result.usage.output += u.output || 0;
            result.usage.cacheRead += u.cacheRead || 0;
            result.usage.cacheWrite += u.cacheWrite || 0;
            result.usage.cost += u.cost?.total || 0;
            result.usage.contextTokens = u.totalTokens || 0;
              // Track current run tokens for progress display
              currentTokens.input += u.input || 0;
              currentTokens.output += u.output || 0;
              currentTokens.total = currentTokens.input + currentTokens.output;
            }
          }
          lastAgentOutput = getFinalOutput([msg]);
        }
    }
  });
}

// ============================================================================
// Dashboard toggle (widget bar only, no overlay)
// ============================================================================

function toggleWidgetVisibility(ctx: ExtensionContext): void {
  widgetVisible = !widgetVisible;
  refreshWidget(ctx);
  ctx.ui.notify(`CARAVEL: widget ${widgetVisible ? "shown" : "hidden"}`, "info");
}

// ============================================================================
// Integration Hooks ───────────────────────────────────────────────────────────
//
// Six integration points wired into runPhaseInternal.  Each hook is gated
// by the corresponding feature flag in `featureConfig` and called inline.
// ===========================================================================

// ── Timer handles ───────────────────────────────────────────────────────────

let _phaseHealthTimerId: number | null = null;
let _taskCheckpointTimerId: number | null = null;

// ── Hook 1: Phase start ─────────────────────────────────────────────────────
// Called at the very beginning of runPhaseInternal, after validation but
// before any task processing.  Loads config and initializes features.
// ===========================================================================

function onPhaseStart(phaseIdx: number, config: FeatureConfig): void {
  _hooksSnapshot = {
    phaseStarted: true,
    taskStarted: false,
    healthCheckRun: false,
    taskCompleted: false,
    taskRetryInjected: false,
    phaseEnded: false,
    configSnapshot: { ...config },
  };
}

// ── Hook 2: Task start ──────────────────────────────────────────────────────
// Called at the start of each task, after agent resolution but before
// the agent is launched.  Resolves identity and starts periodic
// checkpointing.
// ===========================================================================

function onTaskStart(taskId: string, agentName: string, config: FeatureConfig): void {
  _hooksSnapshot!.taskStarted = true;

  // Resolve identity (gated by identity feature)
  if (config.identity) {
    try {
      const identity = getAgentIdentity(agentName);
      return;
    } catch {
      // No-op when identity feature is disabled
      return;
    }
  }

  // Start periodic checkpointing (gated by periodicCheckpoint feature)
  if (config.periodicCheckpoint) {
    try {
      const timerId = startPeriodicCheckpointing(taskId, 60_000, process.cwd());
      _taskCheckpointTimerId = timerId;
    } catch {
      // Periodic checkpointing is non-critical; do not regress task execution
    }
  }
}

// ── Hook 3: Task progress ───────────────────────────────────────────────────
// Called during task execution for health monitoring.
// ===========================================================================

function onTaskProgress(config: FeatureConfig): void {
  if (config.health) {
    _hooksSnapshot!.healthCheckRun = true;
    try {
      _phaseHealthTimerId = startHealthChecks();
    } catch {
      // Health checks are non-critical; do not regress task execution
    }
  }
}

// ── Hook 4: Task complete ───────────────────────────────────────────────────
// Called after a task finishes (success or failure).  Records seance and
// saves the current checkpoint.
// ===========================================================================

function onTaskComplete(
  taskId: string,
  agentName: string,
  phaseName: string,
  taskStatus: string,
  config: FeatureConfig,
  output?: string,
  filesModified?: string[],
): void {
  _hooksSnapshot!.taskCompleted = true;

  const reason = taskStatus === "complete" ? "task_complete" : "task_failed";

  // Record seance (gated by seance feature)
  if (config.seance) {
    try {
      const agentIdentity = getAgentIdentity(agentName);
      recordTerminatedAgent(
        agentIdentity,
        taskId,
        phaseName,
        reason,
        undefined,
        { workSummary: (output && output.trim().length > 0) ? output.slice(0, 1000) : (output || ""), filesModified },
        process.cwd(),
      );
    } catch {
      // Seance recording is non-critical; do not regress task execution
    }
  }

  // Save checkpoint (gated by checkpoint feature)
  if (config.checkpoint) {
    try {
      saveCheckpoint(taskId, agentName, { status: taskStatus, phase: phaseName }, process.cwd());
    } catch {
      // Checkpoint saving is non-critical; do not regress task execution
    }
  }
}

// ── Hook 5: Task retry ──────────────────────────────────────────────────────
// Called when a task is retried after failure.  Injects seance context
// into the task description.
// ===========================================================================

function onTaskRetry(
  taskId: string,
  config: FeatureConfig,
): {
  seancePrefixes: string[];
  checkpointPrefix: string | null;
} {
  _hooksSnapshot!.taskRetryInjected = true;
  const result = { seancePrefixes: [] as string[], checkpointPrefix: null as string | null };

  // Load seance records for recovery (gated by seance feature)
  if (config.seance) {
    try {
      const seanceRecords = getSeanceRecordsForTask(taskId, 2);
      for (const record of seanceRecords) {
        const recoveryContext = generateRecoveryContext(record);
        result.seancePrefixes.push(
          `[SEANCE RECOVERY] ${recoveryContext}\n\n[RETRYING TASK]`,
        );
      }
    } catch {
      // Seance loading is non-critical
    }
  }

  // Load checkpoint for recovered context (gated by checkpoint feature)
  if (config.checkpoint) {
    try {
      const checkpoint = loadCheckpoint(taskId);
      if (checkpoint) {
        result.checkpointPrefix = `[AGENT: ${checkpoint.identity}] [RECOVERED CONTEXT] ${checkpoint.summary}`;
      }
    } catch {
      // Checkpoint loading is non-critical
    }
  }

  return result;
}

// ── Hook 6: Phase end ───────────────────────────────────────────────────────
// Called at the end of runPhaseInternal, after all tasks complete.
// Cleans up health checks and periodic checkpointing.
// ===========================================================================

function onPhaseEnd(config: FeatureConfig): void {
  _hooksSnapshot!.phaseEnded = true;

  // Stop health checks (gated by health feature)
  if (config.health) {
    try {
      stopHealthChecks();
    } catch {
      // Cleanup is best-effort
    }
  }

  // Stop periodic checkpointing (gated by periodicCheckpoint feature)
  if (config.periodicCheckpoint) {
    try {
      stopPeriodicCheckpointing("phase-end-cleanup");
    } catch {
      // Cleanup is best-effort
    }
  }

  // Reset timer handles
  _phaseHealthTimerId = null;
  _taskCheckpointTimerId = null;
}

// ============================================================================
// Auto-orchestration helpers
// ============================================================================

async function runPhaseInternal(
  phaseIdx: number,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: (content: Array<{ type: string; text: string }>) => void,
): Promise<string> {
  if (phaseIdx < 0 || phaseIdx >= fleetState.phases.length) {
    return `Invalid phase index: ${phaseIdx}`;
  }

  const phase = fleetState.phases[phaseIdx]!;
  phase.status = "running";
  fleetState.currentPhaseIndex = phaseIdx;
  saveState();
  refreshWidget(ctx);

  // ── Hook 1: Phase start ───────────────────────────────────────────────────
  onPhaseStart(phaseIdx, featureConfig);

  const results: Array<{ agentName: string; exitCode: number; output: string; stderr: string }> = [];
  const allAgents = discoverAgents("both");

  for (const task of phase.tasks) {
    if (task.status === "complete") continue;

    // Check pause between tasks
    if (fleetState.paused) {
      saveState();
      return `⏸ Phase "${phase.name}" paused before task "${task.agentName}". State saved to disk. Use resume to continue.`;
    }

    const agentDef = allAgents.find((a) => a.name === task.agentName);
    if (!agentDef) {
      task.status = "failed";
      results.push({ agentName: task.agentName, exitCode: 1, output: "", stderr: `Agent "${task.agentName}" not found` });
      continue;
    }

    // Track per-agent token usage
    let agentInputTokens = 0;
    let agentOutputTokens = 0;
    task.startedAt = Date.now();

    // ── Hook 2: Task start ───────────────────────────────────────────────────
    if (featureConfig.identity) {
      try {
        const identity = getAgentIdentity(task.agentName);
        if (!task.metadata) task.metadata = {};
        task.metadata.agentIdentity = identity;
      } catch {
        // No-op when identity feature is disabled
      }
    }
    onTaskStart(task.id, agentDef.name, featureConfig);

    task.status = "running";
    fleetState.activeAgents = fleetState.activeAgents.map((a) =>
      a.name === agentDef.name
        ? { ...a, status: "running" as const, currentTask: truncate(task.description, 30) }
        : a
    );

    if (!fleetState.activeAgents.find((a) => a.name === agentDef.name)) {
      fleetState.activeAgents.push({
        name: agentDef.name,
        status: "running" as const,
        currentTask: truncate(task.description, 30),
        model: agentDef.model,
      });
    }

    refreshWidget(ctx);

    // Real-time progress reporting for this subagent
    const taskProgressId = `task-${task.id}`;
    let lastProgressReport = 0;
    let lastTokenCount = 0;

    // Initialize agent output buffer
    const agentKey = `agent-${agentDef.name}`;
    agentOutputBuffers.set(agentKey, { stdout: "", stderr: "", running: true });
    fleetState.activeAgents = fleetState.activeAgents.map((a) =>
      a.name === agentDef.name ? { ...a, currentTask: truncate(task.description, 30) } : a
    );
    if (!fleetState.activeAgents.find((a) => a.name === agentDef.name)) {
      fleetState.activeAgents.push({
        name: agentDef.name,
        status: "running" as const,
        currentTask: truncate(task.description, 30),
        model: agentDef.model,
      });
    }

    const progressCb = (chunk: string, tokenCount?: number) => {
      const now = Date.now();
      if (now - lastProgressReport > 1000) {
        lastProgressReport = now;
        lastTokenCount = tokenCount ?? lastTokenCount;
        const cleaned = cleanChunkText(chunk);
        const taskIndex = phase.tasks.indexOf(task);
        const elapsed = task.startedAt ? now - task.startedAt : 0;
        const progressLine = formatTaskProgress(
          ctx.ui.theme,
          taskIndex,
          "running",
          agentDef.name,
          agentDef.model || "unknown",
          lastTokenCount,
          elapsed,
          task.description,
        );
        onUpdate?.([{ type: "text", text: progressLine }]);
      }
      // Capture agent output for follow
      const buf = agentOutputBuffers.get(agentKey);
      if (buf) buf.stdout += chunk;
      // Also route to followed agent buffer in real-time
      appendToFollowedAgent(agentDef.name, chunk);
    };

    // Append error context to task description if this is a retry after failure
    // (task.status is narrowed to 'running' here by the 'if (task.status === "complete") continue' above)
    let effectiveTaskDesc = task.description;
    const hadPreviousFailure = task.output || task.stderr || task.reviewFeedback;
    if (hadPreviousFailure) {
      // ── Hook 5: Task retry ──────────────────────────────────────────────────
      const retryContext = onTaskRetry(task.id, featureConfig);
      const seancePrefix = retryContext.seancePrefixes.join("\n\n");
      const checkpointPrefix = retryContext.checkpointPrefix;

      const errorContext: string[] = [];
      if (task.stderr) errorContext.push(`Previous stderr: ${task.stderr}`);
      if (task.reviewFeedback) errorContext.push(`Review feedback: ${task.reviewFeedback}`);
      if (task.codeReviewFeedback) errorContext.push(`Code review feedback: ${task.codeReviewFeedback}`);
      if (task.designReviewFeedback) errorContext.push(`Design review feedback: ${task.designReviewFeedback}`);
      if (task.output) errorContext.push(`Previous output: ${task.output}`);
      if (errorContext.length > 0) {
        const basePrefix = checkpointPrefix ? `${checkpointPrefix}\n\n` : "";
        effectiveTaskDesc = `${seancePrefix}${basePrefix}RETRY — Previous attempt failed. Error context:\n${errorContext.join("\n")}\n\nOriginal task:\n${task.description}`;
      } else if (checkpointPrefix) {
        effectiveTaskDesc = `${seancePrefix}${checkpointPrefix}\n\n${task.description}`;
      }
    }

    // ── Hook 3: Task progress ─────────────────────────────────────────────────
    onTaskProgress(featureConfig);

    const result = await runSubagent(agentDef, effectiveTaskDesc, ctx.cwd, signal, taskProgressId, progressCb);
    agentInputTokens = result.usage?.input || 0;
    agentOutputTokens = result.usage?.output || 0;
    task.output = buildTaskOutput(result.output, result.stderr);
    task.stderr = result.stderr || "";
    // Orchestrator checks BOTH exit code AND output — exit code 0 with no output is still a failure
    const hasOutput = result.output && result.output.trim().length > 0;
    // Exit code -1 = process was killed by signal (crash, OOM, SIGKILL)
    const wasKilled = result.exitCode === -1;
    task.status = (result.exitCode === 0 && hasOutput) ? "complete" as const : "failed" as const;
    if (wasKilled) {
      fleetState.recentOutput = "[CRITICAL] Agent " + agentDef.name + " was killed — process terminated abnormally. Check stderr and system logs.";
    } else if (!hasOutput && result.exitCode === 0) {
      fleetState.recentOutput = "[WARNING] Agent exited cleanly but produced no output — task marked failed.";
    } else if (result.exitCode !== 0) {
      fleetState.recentOutput = "[ERROR] Agent " + agentDef.name + " exited with code " + result.exitCode + ": " + (result.stderr?.slice(0, 200) || "no stderr");
    }
    task.agentModel = result.model;
    task.tokensUsed = result.usage.input + result.usage.output;
    task.messageCount = result.usage.turns;
    // Only set recentOutput if not already set by error detection above
    if (!fleetState.recentOutput || fleetState.recentOutput === "") {
      fleetState.recentOutput = result.output || result.stderr || "";
    }

    // ── Record seance on task completion/failure (when history enabled) ──
    // ── Hook 4: Task complete ─────────────────────────────────────────────────
    onTaskComplete(
      task.id,
      agentDef.name,
      phase.name,
      task.status,
      featureConfig,
      result.output || "",
      task.filesModified && task.filesModified.length > 0 ? task.filesModified : undefined,
    );

    // Capture stderr and mark buffer as done
    const agentBuf = agentOutputBuffers.get(agentKey);
    if (agentBuf) {
      agentBuf.stdout += result.stderr || "";
      agentBuf.running = false;
    }
    if (result.stderr) {
      appendErrToFollowedAgent(agentDef.name, result.stderr);
    }

    fleetState.activeAgents = fleetState.activeAgents.map((a) =>
      a.name === agentDef.name
        ? {
            ...a,
            status: result.exitCode === 0 ? "idle" as const : "error" as const,
            currentTask: undefined,
            model: agentDef.model,
            tokensUsed: result.usage?.input + result.usage?.output,
            inputTokens: result.usage?.input || 0,
            outputTokens: result.usage?.output || 0,
            turns: result.usage?.turns,
          }
        : a
    );

    // Update total fleet tokens
    fleetState.totalFleetTokens += (agentInputTokens + agentOutputTokens);

    results.push({ agentName: task.agentName, exitCode: result.exitCode, output: result.output, stderr: result.stderr });
  }

  const allDone = phase.tasks.every((t) => t.status === "complete");
  phase.status = allDone ? "complete" : (phase.tasks.some((t) => t.status === "failed") ? "failed" : "reviewing");
  phase.completedAt = Date.now();

  // ── Hook 6: Phase end ─────────────────────────────────────────────────────
  onPhaseEnd(featureConfig);

  fleetState.activeAgents = fleetState.activeAgents.filter((a) => a.status !== "running");

  saveState();
  refreshWidget(ctx);

  const successCount = results.filter((r) => r.exitCode === 0).length;
  const summary = phase.tasks.map((t) => {
    const icon = t.status === "complete" ? "✓" : t.status === "failed" ? "✗" : t.status;
    return `  ${icon} ${t.agentName}: ${truncate(t.description, 50)}`;
  }).join("\n");

  return `Phase "${phase.name}" complete: ${successCount}/${phase.tasks.length} tasks succeeded.\n${summary}`;
}

async function runReviewInternal(
  phaseIdx: number,
  ctx: ExtensionContext,
  onUpdate?: (content: Array<{ type: string; text: string }>) => void,
): Promise<string> {
  const phase = fleetState.phases[phaseIdx];
  if (!phase) return "No phase to review";

  // Check pause before starting review
  if (fleetState.paused) {
    saveState();
    return `⏸ Review for phase "${phase.name}" paused. State saved to disk. Use resume to continue.`;
  }

  const incompleteTasks = phase.tasks.filter((t) => t.status !== "complete");
  if (incompleteTasks.length === 0) {
    return "All tasks complete. No review needed.";
  }

  const tasksToReview = incompleteTasks.filter((t) => t.status === "complete" || t.status === "needs_fix");
  if (tasksToReview.length === 0) {
    return "No tasks ready for review yet.";
  }

  fleetState.reviewIterations++;
  saveState();
  refreshWidget(ctx);

  const codeResult = await runCodeReview(phaseIdx, undefined, ctx, onUpdate);
  const designResult = await runDesignReview(phaseIdx, undefined, ctx, onUpdate);

  // Accumulate review tokens
  const reviewTokens = ((codeResult.usage?.input || 0) + (codeResult.usage?.output || 0))
    + ((designResult.usage?.input || 0) + (designResult.usage?.output || 0));
  fleetState.totalFleetTokens += reviewTokens;

  // Check for agent availability errors first - can't fix missing agents
  if (codeResult.error) {
    return `Review #${fleetState.reviewIterations}: ⚠️ Code review failed - ${codeResult.error}`;
  }
  if (designResult.error) {
    return `Review #${fleetState.reviewIterations}: ⚠️ Design review failed - ${designResult.error}`;
  }

  let allApproved = true;

  for (const task of tasksToReview) {
    task.reviewFeedback = "";

    if (codeResult.approved) {
      task.codeReviewStatus = "approved";
    } else {
      task.codeReviewStatus = "needs_fix";
      task.codeReviewFeedback = codeResult.feedback;
      task.reviewFeedback += `[CODE REVIEW - ${codeResult.agentUsed}]:\n${codeResult.feedback}\n\n`;
      allApproved = false;
    }

    if (designResult.approved) {
      task.designReviewStatus = "approved";
    } else {
      task.designReviewStatus = "needs_fix";
      task.designReviewFeedback = designResult.feedback;
      task.reviewFeedback += `[DESIGN REVIEW - ${designResult.agentUsed}]:\n${designResult.feedback}\n\n`;
      allApproved = false;
    }

    if (!allApproved && task.reviewCount < task.maxReviewCount) {
      task.status = "needs_fix";

      // Try auto-fix code issues
      if (codeResult.approved === false && task.codeReviewFeedback) {
        const fixCode = await runDeveloperFix(task, task.codeReviewFeedback, "code", undefined, ctx, onUpdate);
        if (fixCode.error) {
          task.reviewFeedback += `[AUTO-FIX ERROR - Code]: ${fixCode.error}\n\n`;
        } else if (fixCode.usage) {
          fleetState.totalFleetTokens += (fixCode.usage.input + fixCode.usage.output);
        }
      }

      // Try auto-fix design issues
      if (designResult.approved === false && task.designReviewFeedback) {
        const fixDesign = await runDeveloperFix(task, task.designReviewFeedback, "design", undefined, ctx, onUpdate);
        if (fixDesign.error) {
          task.reviewFeedback += `[AUTO-FIX ERROR - Design]: ${fixDesign.error}\n\n`;
        } else if (fixDesign.usage) {
          fleetState.totalFleetTokens += (fixDesign.usage.input + fixDesign.usage.output);
        }
      }

      // Re-check after fix
      if (codeResult.approved === false) {
        const recheckCode = await runCodeReview(phaseIdx, undefined, ctx, onUpdate);
        if (recheckCode.usage) {
          fleetState.totalFleetTokens += (recheckCode.usage.input + recheckCode.usage.output);
        }
        if (!recheckCode.error && recheckCode.approved) {
          task.codeReviewStatus = "approved";
        } else if (recheckCode.error) {
          task.codeReviewStatus = "failed";
          task.codeReviewFeedback = recheckCode.feedback;
          task.reviewFeedback += `[RE-CHECK ERROR - Code]: ${recheckCode.error}\n\n`;
        }
      }
      if (designResult.approved === false) {
        const recheckDesign = await runDesignReview(phaseIdx, undefined, ctx, onUpdate);
        if (recheckDesign.usage) {
          fleetState.totalFleetTokens += (recheckDesign.usage.input + recheckDesign.usage.output);
        }
        if (!recheckDesign.error && recheckDesign.approved) {
          task.designReviewStatus = "approved";
        } else if (recheckDesign.error) {
          task.designReviewStatus = "failed";
          task.designReviewFeedback = recheckDesign.feedback;
          task.reviewFeedback += `[RE-CHECK ERROR - Design]: ${recheckDesign.error}\n\n`;
        }
      }
    } else if (!allApproved) {
      task.status = "failed";
    }
  }

  const codeApproved = codeResult.approved ? "✓ APPROVED" : "✗ NEEDS FIX";
  const designApproved = designResult.approved ? "✓ APPROVED" : "✗ NEEDS FIX";

  return `Review #${fleetState.reviewIterations}: Code: ${codeApproved} | Design: ${designApproved}`;
}

/**
 * Analyze an existing codebase by creating proper analysis tasks.
 * Each task is a real phase that actually runs subagents.
 */

// ============================================================================
// Pre-flight codebase scan
// ============================================================================

const PRE_FLIGHT_MAX_DIRS = 30000;
const PRE_FLIGHT_MAX_FILES = 100000;

const TECH_DETECTIONS: Array<{
  pattern: RegExp | string;
  lang: string;
  framework?: string;
  buildTool?: string;
  configFile?: boolean;
}> = [
  // Languages + frameworks
  { pattern: "typescript", lang: "TypeScript", buildTool: "TypeScript (tsc)" },
  { pattern: "tsconfig", lang: "TypeScript", configFile: true },
  { pattern: "tsx", lang: "React", framework: "React" },
  { pattern: "vue", lang: "Vue", framework: "Vue.js" },
  { pattern: "svelte", lang: "Svelte", framework: "Svelte" },
  { pattern: "angular", lang: "Angular", framework: "Angular" },
  { pattern: "next", lang: "Next.js", framework: "Next.js" },
  { pattern: "nuxt", lang: "Nuxt", framework: "Nuxt.js" },
  { pattern: "django", lang: "Python", framework: "Django" },
  { pattern: "flask", lang: "Python", framework: "Flask" },
  { pattern: "fastapi", lang: "Python", framework: "FastAPI" },
  { pattern: "rails", lang: "Ruby", framework: "Ruby on Rails" },
  { pattern: "spring", lang: "Java", framework: "Spring Boot" },
  { pattern: "express", lang: "Node.js", framework: "Express.js" },
  { pattern: "nest", lang: "Node.js", framework: "NestJS" },
  { pattern: "laravel", lang: "PHP", framework: "Laravel" },
  { pattern: "gin", lang: "Go", framework: "Gin" },
  { pattern: "rocket", lang: "Rust", framework: "Rocket" },
  { pattern: "axum", lang: "Rust", framework: "Axum" },
  // Build tools
  { pattern: "webpack", buildTool: "Webpack" },
  { pattern: "vite", buildTool: "Vite" },
  { pattern: "rollup", buildTool: "Rollup" },
  { pattern: "esbuild", buildTool: "esbuild" },
  { pattern: "parcel", buildTool: "Parcel" },
  { pattern: "bundler", buildTool: "Ruby Bundler" },
  { pattern: "poetry", buildTool: "Poetry (Python)" },
  { pattern: "cargo", buildTool: "Cargo (Rust)" },
  { pattern: "gradle", buildTool: "Gradle (Java)" },
  { pattern: "maven", buildTool: "Maven (Java)" },
  { pattern: "mix", buildTool: "Hex Mix (Elixir)" },
  // Config files
  { pattern: ".eslintrc", configFile: true },
  { pattern: ".prettierrc", configFile: true },
  { pattern: "docker-compose", configFile: true },
  { pattern: "Dockerfile", configFile: true },
  { pattern: ".env", configFile: true },
  { pattern: "Makefile", configFile: true },
  { pattern: "justfile", configFile: true },
];

/** Recursively count files and directories up to a safe limit. */
function countTree(dir: string, seen: Set<string>): { files: number; dirs: number; truncated: boolean } {
  if (seen.size > PRE_FLIGHT_MAX_DIRS) {
    return { files: 0, dirs: 0, truncated: true };
  }
  seen.add(dir);
  let files = 0;
  let dirs = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).length;
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = countTree(fullPath, seen);
        files += sub.files;
        dirs += sub.dirs;
        if (sub.truncated) return { files, dirs, truncated: true };
      } else {
        files++;
      }
    }
  } catch {
    // Permission denied or other error - stop this branch
  }
  return { files, dirs, truncated: false };
}

/** Detect tech stack by scanning for known patterns in file names and content. */
function detectTechStack(cwd: string): {
  techStack: string[];
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  configFileCount: number;
  entryPoints: string[];
} {
  const techStack = new Set<string>();
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const buildTools = new Set<string>();
  let configFileCount = 0;
  const entryPoints: string[] = [];
  const entryPointPatterns = [
    "index.ts", "index.js", "index.tsx", "index.jsx",
    "main.ts", "main.js",
    "app.ts", "app.js", "app.tsx", "app.jsx",
    "server.ts", "server.js",
    "cli.ts", "cli.js",
    "bootstrap.ts", "startup.ts",
  ];

  // Walk up to a reasonable depth for detection (don't traverse the whole tree)
  const maxDepth = 12;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const lower = entry.name.toLowerCase();

        // Entry points
        if (entryPointPatterns.includes(entry.name)) {
          entryPoints.push(path.relative(cwd, fullPath));
        }

        if (entry.isFile()) {
          configFileCount++;

          // Check config-like files for stack detection
          const isConfig = ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "Gemfile", "go.mod", "go.sum", "setup.py", "setup.cfg", "pom.xml", "build.gradle", "mix.exs", ".eslintrc", ".prettierrc", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "Makefile", "justfile", "uv.lock", "poetry.lock"].some((c) => c.toLowerCase() === lower);
          if (isConfig) {
            // Detect stack from file name
            for (const det of TECH_DETECTIONS) {
              if (typeof det.pattern === "string" && lower === det.pattern.toLowerCase()) {
                if (det.lang) languages.add(det.lang);
                if (det.framework) frameworks.add(det.framework);
                if (det.buildTool) buildTools.add(det.buildTool);
                techStack.add(det.lang || det.framework || det.buildTool || det.pattern);
              }
            }
            // For package.json, read the file to detect frameworks/deps
            if (lower === "package.json") {
              try {
                const content = fs.readFileSync(fullPath, "utf-8").slice(0, 50000);
                const keys = JSON.parse(content);
                const allDeps = { ...(keys.dependencies || {}), ...(keys.devDependencies || {}) };
                const allKeys = Object.keys(allDeps).map((k) => k.toLowerCase());
                for (const det of TECH_DETECTIONS) {
                  if (typeof det.pattern === "string" && allKeys.includes(det.pattern.toLowerCase())) {
                    if (det.lang) languages.add(det.lang);
                    if (det.framework) frameworks.add(det.framework);
                    if (det.buildTool) buildTools.add(det.buildTool);
                    techStack.add(det.lang || det.framework || det.buildTool || det.pattern);
                  }
                }
              } catch { /* ignore malformed JSON */ }
            }
            if (lower === "pyproject.toml" || lower === "setup.py" || lower === "requirements.txt") {
              try {
                const content = fs.readFileSync(fullPath, "utf-8").slice(0, 50000);
                for (const det of TECH_DETECTIONS) {
                  if (typeof det.pattern === "string" && content.toLowerCase().includes(det.pattern.toLowerCase())) {
                    if (det.lang) languages.add(det.lang);
                    if (det.framework) frameworks.add(det.framework);
                    if (det.buildTool) buildTools.add(det.buildTool);
                    techStack.add(det.lang || det.framework || det.buildTool || det.pattern);
                  }
                }
              } catch { /* ignore */ }
            }
            if (lower === "cargo.toml") {
              try {
                const content = fs.readFileSync(fullPath, "utf-8").slice(0, 50000);
                for (const det of TECH_DETECTIONS) {
                  if (typeof det.pattern === "string" && content.toLowerCase().includes(det.pattern.toLowerCase())) {
                    if (det.lang) languages.add(det.lang);
                    if (det.framework) frameworks.add(det.framework);
                    if (det.buildTool) buildTools.add(det.buildTool);
                    techStack.add(det.lang || det.framework || det.buildTool || det.pattern);
                  }
                }
              } catch { /* ignore */ }
            }
          }

          // Check file content for framework mentions (limited to first 20KB)
          if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx")) {
            try {
              const content = fs.readFileSync(fullPath, "utf-8").slice(0, 20000);
              for (const det of TECH_DETECTIONS) {
                if (typeof det.pattern === "string" && content.toLowerCase().includes(det.pattern.toLowerCase())) {
                  if (det.lang) languages.add(det.lang);
                  if (det.framework) frameworks.add(det.framework);
                  if (det.buildTool) buildTools.add(det.buildTool);
                  techStack.add(det.lang || det.framework || det.buildTool || det.pattern);
                }
              }
            } catch { /* ignore */ }
          }
        }

        // Continue walking directories
        if (entry.isDirectory()) {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
      }
    } catch {
      // Skip dirs we can't read
    }
  }

  return {
    techStack: Array.from(techStack),
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    buildTools: Array.from(buildTools),
    configFileCount,
    entryPoints,
  };
}

function scanCodebase(cwd: string): PreFlightScan {
  const tree = countTree(cwd, new Set());
  const stack = detectTechStack(cwd);

  // Detect CI config
  const hasCI =
    fs.existsSync(path.join(cwd, ".github")) ||
    fs.existsSync(path.join(cwd, ".gitlab-ci.yml")) ||
    fs.existsSync(path.join(cwd, "Jenkinsfile")) ||
    fs.existsSync(path.join(cwd, ".circleci")) ||
    fs.existsSync(path.join(cwd, "azure-pipelines.yml")) ||
    fs.existsSync(path.join(cwd, ".travis.yml"));

  // Detect test files
  const hasTests =
    fs.existsSync(path.join(cwd, "test")) ||
    fs.existsSync(path.join(cwd, "tests")) ||
    fs.existsSync(path.join(cwd, "spec")) ||
    fs.existsSync(path.join(cwd, "tests")) ||
    fs.existsSync(path.join(cwd, "__tests__")) ||
    fs.existsSync(path.join(cwd, "cypress")) ||
    fs.existsSync(path.join(cwd, "playwright")) ||
    fs.existsSync(path.join(cwd, "karma")) ||
    fs.existsSync(path.join(cwd, "jest.config"));

  return {
    totalFiles: tree.files,
    totalDirs: tree.dirs,
    techStack: stack.techStack,
    languages: stack.languages,
    frameworks: stack.frameworks,
    buildTools: stack.buildTools,
    hasTests,
    hasCI,
    configFileCount: stack.configFileCount,
    entryPoints: stack.entryPoints,
    scanTimestamp: new Date().toISOString(),
  };
}

function buildPreFlightReport(scan: PreFlightScan, analyzer: FleetAgentInfo): string {
  const lines: string[] = [
    `📋 **Pre-Flight Codebase Scan**`,
    ``,
    `### Metadata`,
    `| Field | Value |`,
    `|---|---|`,
    `| Agent | ${analyzer.name} |`,
    `| Model | ${analyzer.model || "(not configured)"} |`,
    `| Scan Time | ${new Date().toISOString()} |`,
    ``,
    `### Codebase Statistics`,
    `| Metric | Value |`,
    `|---|---|`,
    `| Total Files | ${scan.totalFiles.toLocaleString()} |`,
    `| Total Directories | ${scan.totalDirs.toLocaleString()} |`,
    `| Config Files | ${scan.configFileCount.toLocaleString()} |`,
    `| Test Infrastructure | ${scan.hasTests ? "✓ Detected" : "✗ Not detected"} |`,
    `| CI/CD Pipeline | ${scan.hasCI ? "✓ Detected" : "✗ Not detected"} |`,
    ``,
    `### Detected Tech Stack`,
  ];

  if (scan.languages.length > 0) {
    lines.push(`- **Languages:** ${scan.languages.join(", ")}`);
  }
  if (scan.frameworks.length > 0) {
    lines.push(`- **Frameworks:** ${scan.frameworks.join(", ")}`);
  }
  if (scan.buildTools.length > 0) {
    lines.push(`- **Build Tools:** ${scan.buildTools.join(", ")}`);
  }
  if (scan.techStack.length > 0) {
    lines.push(`- **Stack Items:** ${scan.techStack.join(", ")}`);
  }
  if (scan.entryPoints.length > 0) {
    lines.push(`- **Entry Points:** ${scan.entryPoints.slice(0, 20).join(", ")}${scan.entryPoints.length > 20 ? "..." : ""}`);
  }

  lines.push(``);
  lines.push(`### What Will Be Analyzed`);
  lines.push(`The analyzer agent will perform a comprehensive scan of this codebase including:`);
  lines.push(`1. Directory structure and file organization`);
  lines.push(`2. Tech stack identification and version detection`);
  lines.push(`3. Architecture pattern classification`);
  lines.push(`4. Entry points and module boundaries`);
  lines.push(`5. Dependency analysis (package managers, registries)`);
  lines.push(`6. Test coverage and quality assessment`);
  lines.push(`7. Configuration and infrastructure review`);

  return lines.join("\n");
}

async function runAnalysisPhase(ctx: ExtensionContext, onUpdate?: (content: Array<{ type: string; text: string }>) => void): Promise<AnalysisResult> {
  const startTime = Date.now();

  // ── Orchestrator does the scan directly — no subagent delegation for awareness ──
  const scan = scanCodebase(ctx.cwd);

  const allAgents = discoverAgents("both");
  const auditor = allAgents.find((a) => a.name === "auditor");
  const developer = allAgents.find((a) => a.name === "developer");
  const analyzer = auditor || developer;

  const analysisTask: FleetTask = {
    id: generateId(),
    agentName: analyzer?.name ?? "none",
    description: "Perform a comprehensive codebase analysis: scan directory structure, detect tech stack, identify entry points, list dependencies, assess test coverage, and provide a structured analysis report.",
    status: "complete" as const,
    reviewCount: 0,
    maxReviewCount: 3,
    metadata: { preFlight: scan },
  };

  // ── Build analysis report directly from scan data ──
  const lines: string[] = [];
  const now = new Date().toISOString().split("T")[0];

  // Detect project info
  let projectName = "";
  let projectVersion = "";
  let projectDescription = "";
  let deps: string[] = [];
  let devDeps: string[] = [];
  let packageJsonPath = path.join(ctx.cwd, "package.json");
  let packageJsonContent: any;
  try {
    packageJsonContent = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    projectName = packageJsonContent.name || "";
    projectVersion = packageJsonContent.version || "";
    projectDescription = packageJsonContent.description || "";
    deps = Object.keys(packageJsonContent.dependencies || {});
    devDeps = Object.keys(packageJsonContent.devDependencies || {});
  } catch {
    // No package.json — not a Node project
  }

  lines.push(`# Codebase Analysis Report`);
  lines.push(``);
  lines.push(`> Generated: ${now}`);
  lines.push(`> Auditor: orchestrator (direct scan)`);
  lines.push(`> Project: ${projectName || "unknown"}${projectVersion ? ` v${projectVersion}` : ""}`);
  lines.push("");
  lines.push(`## 1. Project Overview`);
  lines.push(projectDescription ? `**${projectDescription}**` : "No project description found.");
  lines.push("");
  lines.push(`## 2. Directory Structure`);
  lines.push(scan.totalDirs > 0 ? `- ${scan.totalDirs} directories detected` : "- No directories found");
  lines.push(scan.totalFiles > 0 ? `- ${scan.totalFiles} files detected` : "- No files found");
  lines.push("");
  lines.push(`## 3. Tech Stack`);
  lines.push(`- Languages: ${scan.languages.length > 0 ? scan.languages.join(", ") : "(none detected)"}`);
  lines.push(`- Frameworks: ${scan.frameworks.length > 0 ? scan.frameworks.join(", ") : "(none detected)"}`);
  lines.push(`- Build Tools: ${scan.buildTools.length > 0 ? scan.buildTools.join(", ") : "(none detected)"}`);
  lines.push(`- Package Manager: ${deps.length > 0 ? "npm/yarn/pnpm (package.json found)" : "(none detected)"}`);
  lines.push(`- Config Files: ${scan.configFileCount.toLocaleString()}`);
  lines.push("");
  lines.push(`## 4. Architecture`);
  if (scan.frameworks.length > 0) {
    lines.push(`Detected frameworks: ${scan.frameworks.join(", ")}.`);
    lines.push(`Architecture style: ${scan.frameworks.includes("Next.js") ? "Full-stack / SSR" : scan.frameworks.includes("React") ? "Client-side SPA" : scan.frameworks.includes("Express") ? "Backend API" : "Multi-stack"}`);
  } else {
    lines.push("- No specific framework detected. Manual review needed.");
  }
  lines.push(`- CI/CD: ${scan.hasCI ? "Detected" : "Not detected"}`);
  lines.push(`- Test Infrastructure: ${scan.hasTests ? "Detected" : "Not detected"}`);
  lines.push("");
  lines.push(`## 5. Entry Points`);
  if (scan.entryPoints.length > 0) {
    scan.entryPoints.slice(0, 20).forEach(ep => lines.push(`- ${ep}`));
  } else {
    lines.push("- No automatic entry points detected. Manual review needed.");
  }
  lines.push("");
  lines.push(`## 6. Dependencies`);
  lines.push(`### Production`);
  if (deps.length > 0) {
    deps.forEach(d => lines.push(`- ${d}`));
  } else {
    lines.push("- None detected");
  }
  lines.push(`### Development`);
  if (devDeps.length > 0) {
    devDeps.forEach(d => lines.push(`- ${d}`));
  } else {
    lines.push("- None detected");
  }
  lines.push("");
  lines.push(`## 7. Technical Debt (auto-detected)`);
  lines.push("- No automatic debt detection available. Manual review recommended.");
  lines.push("");
  lines.push(`## 8. Recommendations`);
  lines.push(`1. **[Low]** Run manual audit for technical debt, security issues, and architecture review.`);
  lines.push(`   Use the /go command or plan_project() to begin implementation.`);
  lines.push("");

  const analysisOutput = lines.join("\n");
  const elapsed = Date.now() - startTime;

  // Persist ANALYSIS.md
  const analysisPath = path.join(ctx.cwd, "ANALYSIS.md");
  try {
    await fs.promises.writeFile(analysisPath, analysisOutput, "utf-8");
  } catch (err) {
    // Non-fatal
  }

  // Clear any stale output buffer for the analyzer agent
  const analysisKey = analyzer ? `agent-${analyzer.name}-analysis` : null;
  if (analysisKey) {
    const buf = agentOutputBuffers.get(analysisKey);
    if (buf) buf.running = false;
  }

  return {
    agent: analyzer ?? { name: "none", description: "", model: "", tools: [], systemPrompt: "", source: "project" },
    task: analysisTask,
    preFlight: scan,
    output: analysisOutput,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, contextTokens: 0, turns: 0 },
    elapsedMs: elapsed,
    errors: [],
    success: true,
  };
}

// ============================================================================
// Artifact generation: PROJECT-DESIGN.md and PROJECT-PLAN.md
// ============================================================================

/**
 * Generate PROJECT-DESIGN.md from analysis results.
 * Called after /analyze completes. Contains architecture, tech stack, design patterns.
 */
function generateDesignDocument(result: AnalysisResult, ctx: ExtensionContext): string {
  const pf = result.preFlight;
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push(`# ${getProjectName(ctx.cwd)} - Design Document`);
  lines.push("");
  lines.push(`> Generated: ${now} from codebase analysis`);
  lines.push(`> Source: ${result.agent.name} agent (model: ${result.agent.model || "unknown"})`);
  lines.push("> Scope: architecture, tech stack, design patterns, structural analysis");
  lines.push("");
  lines.push("---");
  lines.push("");

  // --- Architecture ---
  lines.push("## Architecture");
  lines.push("");
  const archSection = result.output ? extractSection(result.output, "Architecture") : "";
  if (archSection && archSection.length > 10) {
    lines.push(archSection);
  } else {
    lines.push("**Full architectural analysis available in [ANALYSIS.md](./ANALYSIS.md)**");
    // Provide useful content from pre-flight scan
    lines.push("");
    lines.push("**Detected patterns from codebase scan:**");
    if (pf.languages.length > 0) lines.push(`- **Languages**: ${pf.languages.join(", ")}`);
    if (pf.frameworks.length > 0) lines.push(`- **Frameworks**: ${pf.frameworks.join(", ")}`);
    if (pf.buildTools.length > 0) lines.push(`- **Build Tools**: ${pf.buildTools.join(", ")}`);
    if (pf.techStack.length > 0) lines.push(`- **Stack Items**: ${pf.techStack.join(", ")}`);
    if (pf.entryPoints.length > 0) lines.push(`- **Entry Points**: ${pf.entryPoints.slice(0, 10).join(", ")}${pf.entryPoints.length > 10 ? "..." : ""}`);
  }
  lines.push("");

  // --- Tech Stack ---
  lines.push("## Tech Stack");
  lines.push("");
  if (pf.languages.length > 0) lines.push(`- **Languages**: ${pf.languages.join(", ")}`);
  if (pf.frameworks.length > 0) lines.push(`- **Frameworks**: ${pf.frameworks.join(", ")}`);
  if (pf.buildTools.length > 0) lines.push(`- **Build Tools**: ${pf.buildTools.join(", ")}`);
  if (pf.techStack.length > 0) lines.push(`- **Stack Items**: ${pf.techStack.join(", ")}`);
  lines.push("");

  // --- Project Structure (from pre-flight scan) ---
  lines.push("## Project Structure");
  lines.push("");
  lines.push(`- **Total Files**: ${pf.totalFiles.toLocaleString()}`);
  lines.push(`- **Total Directories**: ${pf.totalDirs.toLocaleString()}`);
  if (pf.configFileCount > 0) lines.push(`- **Config Files**: ${pf.configFileCount.toLocaleString()}`);
  lines.push(`- **Test Infrastructure**: ${pf.hasTests ? "✓ Detected" : "✗ Not detected"}`);
  lines.push(`- **CI/CD Pipeline**: ${pf.hasCI ? "✓ Detected" : "✗ Not detected"}`);
  lines.push("");

  // --- Directory layout ---
  if (pf.entryPoints.length > 0) {
    lines.push("## Entry Points");
    lines.push("");
    pf.entryPoints.slice(0, 20).forEach((ep) => lines.push(`- \`${ep}\``));
    if (pf.entryPoints.length > 20) lines.push(`- ... and ${pf.entryPoints.length - 20} more`);
    lines.push("");
  }

  // --- Design Patterns (from analysis) ---
  const patterns = extractSection(result.output, "Design Patterns");
  if (patterns && patterns.trim()) {
    lines.push("## Design Patterns");
    lines.push("");
    lines.push(patterns.trim());
    lines.push("");
  }

  // --- Recommendations ---
  const recs = extractSection(result.output, "Recommendations");
  if (recs && recs.trim()) {
    lines.push("## Design Recommendations");
    lines.push("");
    lines.push(recs.trim());
    lines.push("");
  }

  // --- Footer ---
  lines.push("---");
  lines.push("");
  lines.push(`> Full analysis report: [ANALYSIS.md](./ANALYSIS.md)`);
  lines.push(`> Implementation plan: [PROJECT-PLAN.md](./PROJECT-PLAN.md)`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate PROJECT-PLAN.md from planning results.
 * Called after plan_project() completes. Contains phases, tasks, and roadmap.
 */
function generatePlanDocument(
  planName: string,
  phases: FleetPhase[],
  ctx: ExtensionContext,
): string {
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push(`# ${planName} - Project Plan`);
  lines.push("");
  lines.push(`> Generated: ${now} from project planning phase`);
  lines.push(`> Phases: ${phases.length}`);
  lines.push(`> Total Tasks: ${phases.reduce((s, p) => s + p.tasks.length, 0)}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("## Phases");
  lines.push("");

  phases.forEach((phase, i) => {
    const statusIcon = phase.status === "complete" ? "✅" : phase.status === "failed" ? "❌" : "⏳";
    lines.push(`### ${statusIcon} Phase ${i + 1}: ${phase.name}`);
    lines.push("");
    lines.push(`**Status**: ${phase.status}`);
    lines.push("");
    lines.push("#### Tasks");
    lines.push("");

    phase.tasks.forEach((task, j) => {
      const taskIcon = task.status === "complete" ? "✅" : task.status === "failed" ? "❌" : task.status === "needs_fix" ? "🔧" : "○";
      lines.push(`- [${taskIcon}] **T${j + 1}**: ${task.description.slice(0, 120)}`);
      lines.push(`  - **Agent**: ${task.agentName}`);
      lines.push(`  - **Review**: code + design`);
    });

    lines.push("");
  });

  // --- Summary ---
  const completed = phases.flatMap((p) => p.tasks.filter((t) => t.status === "complete")).length;
  const failed = phases.flatMap((p) => p.tasks.filter((t) => t.status === "failed")).length;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Completed**: ${completed} tasks`);
  lines.push(`- **Failed**: ${failed} tasks`);
  lines.push(`- **Remaining**: ${phases.reduce((s, p) => s + p.tasks.filter((t) => t.status !== "complete").length, 0)} tasks`);
  lines.push("");

  // --- Next Steps ---
  lines.push("## Next Steps");
  lines.push("");
  lines.push("1. Run `plan_project()` with more specific tasks if needed");
  lines.push("2. Run `/go` to execute the fleet");
  lines.push("3. Monitor progress in the widget bar");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`> Architecture reference: [PROJECT-DESIGN.md](./PROJECT-DESIGN.md)`);
  lines.push(`> Full analysis: [ANALYSIS.md](./ANALYSIS.md)`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Extract a section from the analysis output by header.
 * Handles both "## SectionName" and "## Section Name" formats.
 * Falls back to looking for "### SectionName" or just the section name.
 */
function extractSection(output: string, section: string): string {
  // Try exact match: "## SectionName"
  let start = output.indexOf(`## ${section}`);
  // Try hyphenated: "## Section-Name" → "SectionName"
  if (start < 0) {
    const hyphenated = section.replace(/\s+/g, "-").toLowerCase();
    const lowerOutput = output.toLowerCase();
    const idx = lowerOutput.indexOf(`## ${hyphenated}`);
    if (idx >= 0) start = idx;
  }
  if (start < 0) return "";

  // Find the start of content: skip the "## SectionName" line itself
  const headerEnd = output.indexOf("\n", start);
  if (headerEnd < 0) return "";

  // Find next section header at same or deeper level (## or ###)
  let next = output.indexOf("\n## ", headerEnd + 1);
  if (next < 0) {
    next = output.indexOf("\n### ", headerEnd + 1);
  }
  const end = next > headerEnd ? next : output.length;

  // Content starts after the header line's newline, skip blank lines
  let contentStart = headerEnd + 1;
  while (contentStart < end && output[contentStart] === "\n") contentStart++;
  return output.slice(contentStart, end).trim();
}

/**
 * Extract project name from package.json or directory name.
 */
function getProjectName(cwd: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
    if (pkg.name) return pkg.name;
  } catch { /* ignore */ }
  try {
    const readme = fs.readFileSync(path.join(cwd, "README.md"), "utf-8");
    const m = readme.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* ignore */ }
  return path.basename(cwd);
}

// ============================================================================
// Main extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  _pi = pi;

  pi.on("session_start", async (_event, ctx) => {
    loadState(ctx);
    refreshWidget(ctx);
    ctx.ui.setWorkingVisible(false);
    ctx.ui.notify("Caravel fleet initialized", "info");
  });

  // ── Background mode: if launched with --bg-mode, load state and auto-start fleet ──
  const bgModeIndex = process.argv.indexOf("--bg-mode");
  if (bgModeIndex >= 0) {
    // In bg-mode, we load state and begin auto-orchestration
    // The pi process acts as a headless fleet executor
    pi.on("session_start", async (_event: any, ctx: any) => {
      const statePath = stateFilePath(ctx.cwd);
      const hasState = fs.existsSync(statePath);
      if (hasState) {
        ctx.ui.notify(`BG-MODE: Loading fleet state from ${statePath}`, "info");
      } else {
        ctx.ui.notify("BG-MODE: No saved state found. Fleet idle.", "warning");
      }
      refreshWidget(ctx);
    });
  }

  pi.on("agent_end", async (event, ctx) => {
    const lastMsg = event.messages?.[event.messages.length - 1];
    if (lastMsg?.role === "assistant") {
      let action = "idle";
      let detail = "Turn complete";
      for (const part of lastMsg.content) {
        if (part.type === "tool_use") {
          action = part.name;
          const inputStr = JSON.stringify(part.input || {});
          if (action === "bash" && part.input?.command) {
            detail = truncateToWidth(part.input.command, 40);
          } else if (action === "read" && part.input?.path) {
            detail = truncateToWidth(part.input.path, 40);
          } else if (action === "edit" && part.input?.path) {
            detail = truncateToWidth(part.input.path, 40);
          } else if (action === "write" && part.input?.path) {
            detail = truncateToWidth(part.input.path, 40);
          } else {
            detail = truncateToWidth(inputStr.slice(0, 50), 40);
          }
          break;
        }
        if (part.type === "text") {
          action = "response";
          detail = sanitizeDisplay(truncateToWidth(part.text.slice(0, 60), 40));
        }
      }
      fleetState.mainAgentActivity = {
        status: "idle",
        action,
        detail,
        timestamp: Date.now(),
      };
    }
    refreshWidget(ctx);
    saveState();
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    if (toolName && fleetState.mainAgentActivity?.status !== "executing") {
      let action = toolName;
      let detail = "";
      if (toolName === "bash" && event.input?.command) {
        action = "bash";
        detail = truncateToWidth(event.input.command, 40);
      } else if (toolName === "read" && event.input?.path) {
        action = "read";
        detail = truncateToWidth(event.input.path, 40);
      } else if (toolName === "edit" && event.input?.path) {
        action = "edit";
        detail = truncateToWidth(event.input.path, 40);
      } else if (toolName === "write" && event.input?.path) {
        action = "write";
        detail = truncateToWidth(event.input.path, 40);
      } else {
        detail = truncateToWidth(JSON.stringify(event.input).slice(0, 50), 40);
      }
      fleetState.mainAgentActivity = {
        status: "executing",
        action,
        detail,
        timestamp: Date.now(),
      };
      refreshWidget(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    saveState();
  });

  // ---- Commands ----

  pi.registerCommand("caravel-fleet", {
    description: "Toggle fleet widget bar visibility",
    handler: async (_args, ctx) => {
      widgetVisible = !widgetVisible;
      refreshWidget(ctx);
      ctx.ui.notify(`Fleet widget ${widgetVisible ? "shown" : "hidden"}`, "info");
    },
  });

  // ---- Follow system commands ----

  pi.registerCommand("follow", {
    description: "Follow an agent's live output in the main pane. Use /follow list to see available agents, /follow agent_name to follow, /follow none to unfollow, /follow switch to switch between running agents.",
    handler: async (args: string[], ctx) => {
      const cmd = (args[0] ?? "none").toLowerCase();

      if (cmd === "list") {
        const runningAgents = fleetState.activeAgents.filter((a) => a.status === "running");
        const completedAgents = fleetState.activeAgents.filter((a) => a.status === "idle");
        const lines: string[] = [];
        lines.push("╔═══════════════════════════════════════════════════════╗");
        lines.push("║  FOLLOW TARGETS                                       ║");
        lines.push("╠═══════════════════════════════════════════════════════╣");

        if (runningAgents.length > 0) {
          lines.push("║  ▸ Running:                                           ║");
          for (const a of runningAgents) {
            const icon = followedAgent.agent === a.name ? "▸" : "○";
            const name = a.name.padEnd(14);
            const task = (a.currentTask || "").padEnd(30);
            const model = a.model || "?";
            lines.push(`║    ${icon} ${name} → ${model}  (${task})           ║`);
          }
          lines.push("");
        }

        if (completedAgents.length > 0) {
          lines.push("║  ○ Completed:                                         ║");
          for (const a of completedAgents) {
            const name = a.name.padEnd(14);
            const model = a.model || "?";
            lines.push(`║    ○ ${name} → ${model}  (idle)           ║`);
          }
          lines.push("");
        }

        if (runningAgents.length === 0 && completedAgents.length === 0) {
          lines.push("║    No agents have run yet.                            ║");
        }

        const followStatus = followedAgent.agent
          ? `Currently following: ${followedAgent.agent}`
          : "Not following anyone";
        lines.push("║");
        lines.push(`║  Status: ${followStatus.padEnd(37)}║`);
        lines.push("║");
        lines.push("║  Commands:                                            ║");
        lines.push("║    /follow <agent>  - follow agent output             ║");
        lines.push("║    /follow switch   - toggle between running agents   ║");
        lines.push("║    /follow none     - stop following                  ║");
        lines.push("║    /follow list     - show this list                  ║");
        lines.push("╚═══════════════════════════════════════════════════════╝");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (cmd === "switch") {
        const runningAgents = fleetState.activeAgents.filter((a) => a.status === "running");
        if (runningAgents.length === 0) {
          return { content: [{ type: "text", text: "No running agents to follow." }] };
        }
        // Find the current followed agent in the running list
        const currentIndex = runningAgents.findIndex((a) => a.name === followedAgent.agent);
        // Switch to the next running agent
        const nextIndex = (currentIndex + 1) % runningAgents.length;
        const nextAgent = runningAgents[nextIndex];

        // Capture the current output before switching
        if (followedAgent.agent) {
          agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
            stdout: followedAgent.output,
            stderr: "",
            running: false,
          });
        }

        followedAgent = {
          agent: nextAgent.name,
          output: getAgentOutput(nextAgent.name),
          isLive: true,
        };
        refreshWidget(ctx);
        ctx.ui.notify(`Following: ${nextAgent.name}`, "info");
        return { content: [{ type: "text", text: `Now following ${nextAgent.name}'s output.` }] };
      }

      if (cmd === "none") {
        // Capture current output before clearing
        if (followedAgent.agent) {
          agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
            stdout: followedAgent.output,
            stderr: "",
            running: false,
          });
        }
        const unfollowedName = followedAgent.agent;
        followedAgent = { agent: null, output: "", isLive: false };
        refreshWidget(ctx);
        if (unfollowedName) {
          ctx.ui.notify(`Unfollowed ${unfollowedName}`, "info");
          return { content: [{ type: "text", text: `Stopped following ${unfollowedName}.` }] };
        }
        return { content: [{ type: "text", text: "Already not following anyone." }] };
      }

      // Try to follow the named agent
      const agentName = cmd;
      const targetAgent = fleetState.activeAgents.find((a) => a.name === agentName);
      if (!targetAgent) {
        // Check if it's a known agent that hasn't run yet
        const allAgents = discoverAgents("both");
        const known = allAgents.find((a) => a.name === agentName);
        if (!known) {
          return { content: [{ type: "text", text: `Unknown agent "${agentName}". Use /follow list to see available agents.` }] };
        }
        // Known agent - start following, buffer is empty until it runs
        // Capture previous if any
        if (followedAgent.agent) {
          agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
            stdout: followedAgent.output,
            stderr: "",
            running: false,
          });
        }
        followedAgent = {
          agent: agentName,
          output: "",
          isLive: false,
        };
        agentOutputBuffers.set(`agent-${agentName}`, { stdout: "", stderr: "", running: false });
        refreshWidget(ctx);
        ctx.ui.notify(`Will follow ${agentName} when it runs.`, "info");
        return { content: [{ type: "text", text: `Will follow ${agentName} when it starts.` }] };
      }

      // Agent is running
      if (followedAgent.agent === agentName) {
        return { content: [{ type: "text", text: `Already following ${agentName}.` }] };
      }

      // Capture previous agent output
      if (followedAgent.agent) {
        agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
          stdout: followedAgent.output,
          stderr: "",
          running: false,
        });
      }

      followedAgent = {
        agent: agentName,
        output: getAgentOutput(agentName),
        isLive: true,
      };
      agentOutputBuffers.set(`agent-${agentName}`, {
        stdout: getAgentOutput(agentName),
        stderr: "",
        running: true,
      });
      refreshWidget(ctx);
      ctx.ui.notify(`Following: ${agentName}`, "info");
      return { content: [{ type: "text", text: `Now following ${agentName}'s output.` }] };
    },
  });

  // ---- /go: auto-orchestrate all phases ----

  pi.registerCommand("caravel-go", {
    description: "Auto-orchestrate the fleet: run all phases sequentially with review between each. Pauses block execution until resumed.",
    handler: async (_args, ctx) => {
      if (fleetState.phases.length === 0) {
        return { content: [{ type: "text", text: `Fleet is idle. No phases defined.\n\nTo start, either:\n  1. Use plan_project() to define phases, then call /caravel-go again\n  2. Describe your project in natural language and the planner agent will create the plan` }] };
      }

      // Check if fleet is paused - if so, block and report
      if (fleetState.paused) {
        const savedPath = stateFilePath(ctx.cwd);
        return {
          content: [{ type: "text", text:
            `⏸ Fleet is paused. Execution blocked.\n` +
            `  State saved at: ${savedPath}\n` +
            `  Use fleet_control(action="resume") to restore state and continue.`
          }],
          details: { paused: true, savedState: savedPath }
        };
      }

      const results: string[] = [];
      let phaseIndex = fleetState.currentPhaseIndex;

      while (phaseIndex < fleetState.phases.length) {
        // Check pause flag between phases
        if (fleetState.paused) {
          results.push(`⏸ Execution paused at phase ${phaseIndex + 1}. State saved to disk.`);
          break;
        }

        const phase = fleetState.phases[phaseIndex];

        if (phase.status === "complete") {
          results.push(`✅ Phase ${phaseIndex + 1} "${phase.name}" - already complete`);
          phaseIndex++;
          continue;
        }

        if (phase.status === "failed" && phaseIndex !== fleetState.currentPhaseIndex) {
          results.push(`⚠️ Phase ${phaseIndex + 1} "${phase.name}" - failed, skipping`);
          phaseIndex++;
          continue;
        }

        results.push(`\n▶ Running Phase ${phaseIndex + 1}/${fleetState.phases.length}: "${phase.name}"`);
        fleetState.currentPhaseIndex = phaseIndex;
        saveState();
        refreshWidget(ctx);

        const phaseResult = await runPhaseInternal(phaseIndex, ctx, undefined);
        results.push(phaseResult);

        // Check if phase execution was paused mid-task
        if (fleetState.paused) {
          results.push(`⏸ Phase execution paused. Use /caravel-resume to continue.`);
          break;
        }

        const hasReviewableTasks = phase.tasks.some(
          (t) => t.status === "complete" || t.status === "needs_fix"
        );

        if (hasReviewableTasks) {
          results.push(`\n🔍 Reviewing Phase ${phaseIndex + 1}...`);
          const reviewResult = await runReviewInternal(phaseIndex, ctx);
          results.push(reviewResult);

          const phaseStillIncomplete = phase.tasks.some(
            (t) => t.status !== "complete"
          );
          if (phaseStillIncomplete) {
            results.push(`\n🔁 Re-running Phase ${phaseIndex + 1} after review fixes...`);
            const rerunResult = await runPhaseInternal(phaseIndex, ctx, undefined);
            results.push(rerunResult);
          }
        }

        const phaseComplete = phase.tasks.every((t) => t.status === "complete");
        if (phaseComplete) {
          phase.status = "complete";
          phase.completedAt = Date.now();
          results.push(`✅ Phase ${phaseIndex + 1} "${phase.name}" complete`);
        }

        saveState();
        refreshWidget(ctx);
        phaseIndex++;
      }

      const allComplete = fleetState.phases.every((p) => p.status === "complete");
      if (allComplete) {
        results.push(`\n🎉 All phases complete! Fleet has finished.`);
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    },
  });

  // ---- /analyze: analyze existing codebase ----

  pi.registerCommand("analyze", {
    description: "Analyze an existing codebase: scan structure, detect tech stack, map dependencies",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Analyzing codebase...", "info");

      // Register analyzer in activeAgents for follow tracking
      const allAgents = discoverAgents("both");
      const analyzerAgent = allAgents.find((a) => a.name === "auditor") || allAgents.find((a) => a.name === "developer");
      if (analyzerAgent) {
        fleetState.activeAgents = fleetState.activeAgents.filter((a) => a.name !== analyzerAgent.name);
        fleetState.activeAgents.push({
          name: analyzerAgent.name,
          status: "running" as const,
          currentTask: "Codebase Analysis",
          model: analyzerAgent.model,
        });
      }

      // Run the actual analysis (creates real tasks that execute subagents)
      const result = await runAnalysisPhase(ctx);

      // Create a phase from the analysis task
      const analysisPhase: FleetPhase = {
        id: generateId(),
        name: "Codebase Analysis",
        status: result.success ? "complete" : "failed",
        tasks: [result.task],
      };

      fleetState.phases = [analysisPhase];
      fleetState.currentPhaseIndex = 0;
      fleetState.startTime = fleetState.startTime || Date.now();
      fleetState.reviewIterations = 0;

      saveState();
      refreshWidget(ctx);

      // ── Build rich metadata report ──
      const th = ctx.hasUI ? ctx.ui.theme : null;
      const sep = theme ? theme.fg("dim", "─").repeat(52) : "─".repeat(52);
      const section = (title: string) => `${theme ? theme.fg("accent", `▸ ${title}`) : `▸ ${title}`}
  ${theme ? theme.fg("dim", sep) : sep}`;
      const metaLine = (label: string, value: string) => `  ${theme ? theme.fg("dim", "•") : "•"} ${theme ? theme.fg("dim", label) : label}: ${value}`;
      const scanLine = (label: string, value: string) => `  ${theme ? theme.fg("muted", "○") : "○"} ${theme ? theme.fg("dim", label) : label}: ${value}`;

      let response = "";

      // ── Header ──
      if (result.success) {
        response += `${theme ? theme.fg("success", "✅") : "✅"} Codebase Analysis Complete\n\n`;
      } else {
        response += `${theme ? theme.fg("warning", "⚠️") : "⚠️"} Analysis Encountered Issues\n\n`;
      }

      // ── Agent & Model metadata ──
      response += section("Agent & Model");
      response += `${metaLine("Agent", result.agent.name)}\n`;
      response += `${metaLine("Model", result.agent.model || "(not configured)")}\n`;
      response += `${metaLine("Tools", result.agent.tools?.join(", ") || "(none)")}\n`;
      response += "\n";

      // ── Execution stats ──
      response += section("Execution");
      response += `${metaLine("Elapsed", formatDuration(result.elapsedMs))}\n`;
      response += `${metaLine("Turns", String(result.tokens.turns))}\n`;
      response += `${metaLine("Input Tokens", formatTokens(result.tokens.input))}\n`;
      response += `${metaLine("Output Tokens", formatTokens(result.tokens.output))}\n`;
      response += `${metaLine("Total Tokens", formatTokens(result.tokens.total))}\n`;
      if (result.tokens.cacheRead > 0) response += `${metaLine("Cache Read", formatTokens(result.tokens.cacheRead))}\n`;
      if (result.tokens.cacheWrite > 0) response += `${metaLine("Cache Write", formatTokens(result.tokens.cacheWrite))}\n`;
      response += `${metaLine("Cost", formatCost(result.tokens.cost))}\n`;
      response += "\n";

      // ── Pre-flight scan results ──
      response += section("Pre-Flight Scan");
      const pf = result.preFlight;
      response += `${scanLine("Total Files", pf.totalFiles.toLocaleString())}\n`;
      response += `${scanLine("Directories", pf.totalDirs.toLocaleString())}\n`;
      response += `${scanLine("Config Files", pf.configFileCount.toLocaleString())}\n`;
      response += `${scanLine("Test Infrastructure", pf.hasTests ? "✓ Detected" : "✗ Not detected")}\n`;
      response += `${scanLine("CI/CD Pipeline", pf.hasCI ? "✓ Detected" : "✗ Not detected")}\n`;

      if (pf.languages.length > 0) {
        response += `${scanLine("Languages", pf.languages.join(", "))}\n`;
      }
      if (pf.frameworks.length > 0) {
        response += `${scanLine("Frameworks", pf.frameworks.join(", "))}\n`;
      }
      if (pf.buildTools.length > 0) {
        response += `${scanLine("Build Tools", pf.buildTools.join(", "))}\n`;
      }
      if (pf.techStack.length > 0) {
        response += `${scanLine("Stack Items", pf.techStack.join(", "))}\n`;
      }
      if (pf.entryPoints.length > 0) {
        const entries = pf.entryPoints.slice(0, 10).join(", ");
        const more = pf.entryPoints.length > 10 ? ` (+${pf.entryPoints.length - 10} more)` : "";
        response += `${scanLine("Entry Points", `${entries}${more}`)}\n`;
      }
      response += "\n";

      // ── Analysis output ──
      if (result.success && result.output) {
        response += section("Analysis Report");
        response += `\n${result.output}\n\n`;
      }

      // ── Errors with actionable guidance ──
      if (!result.success && result.errors.length > 0) {
        response += section("Errors");
        response += `${result.errors.map((e, i) => `  ${theme ? theme.fg("error", `✗`) : "✗"} ${e}`).join("\n")}\n\n`;

        // Actionable guidance based on error content
        const guidance = buildErrorGuidance(result.errors);
        if (guidance) {
          response += `${theme ? theme.fg("accent", "💡 Suggestions"): "💡 Suggestions"}\n`;
          for (const tip of guidance) {
            response += `  ${theme ? theme.fg("muted", "→") : "→"} ${tip}\n`;
          }
          response += "\n";
        }
      }

      // ── Files produced ──
      if (result.success) {
        response += section("Files Produced");
        response += `  ${theme ? theme.fg("dim", "○") : "○"} [ANALYSIS.md](./ANALYSIS.md) - Full codebase analysis report\n`;
        response += `  ${theme ? theme.fg("dim", "○") : "○"} [PROJECT-DESIGN.md](./PROJECT-DESIGN.md) - Architecture & design overview\n`;
        response += "\n";
      }

      // ── Next steps ──
      if (result.success) {
        response += section("Next Steps");
        response += `  ${theme ? theme.fg("dim", "→") : "→"} Use ${theme ? theme.fg("accent", "plan_project()") : "plan_project()"} to create an implementation plan\n`;
        response += `  ${theme ? theme.fg("dim", "→") : "→"} Run ${theme ? theme.fg("accent", "/go") : "/go"} to execute the fleet\n`;
        response += `  ${theme ? theme.fg("dim", "→") : "→"} Read ${theme ? theme.fg("accent", "ANALYSIS.md") : "ANALYSIS.md"} for detailed findings\n\n`;
      }

      // ── Auto-generate PROJECT-DESIGN.md from analysis ──
      const designDoc = generateDesignDocument(result, ctx);
      const designPath = path.join(ctx.cwd, "PROJECT-DESIGN.md");
      try {
        await fs.promises.writeFile(designPath, designDoc, "utf-8");
      } catch {
        // Non-fatal - design doc generation is optional
      }

      return { content: [{ type: "text", text: response }] };
    },
  });

  // ---- Tools ----

  pi.registerTool({
    name: "plan_project",
    label: "Plan Project",
    description:
      "Decompose a project into phases and tasks. Each phase has tasks assigned to specific agents.",
    parameters: Type.Object({
      name: Type.String({ description: "Project name / phase name" }),
      phases: Type.Array(
        Type.Object({
          name: Type.String({ description: "Phase name, e.g. 'Setup', 'Core UI', 'Review'" }),
          tasks: Type.Array(
            Type.Object({
              agent: Type.String({ description: "Agent name: developer, tech-lead, or designer" }),
              task: Type.String({ description: "Detailed task description" }),
            }),
          ),
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // ── Testability enforcement (blocks plan if criteria unmet) ──
      const validation = enforceTestability(
        params.phases.map((p) => ({
          name: p.name,
          tasks: p.tasks.map((t) => ({ id: generateId(), task: t.task })),
        }))
      );
      if (!validation.allPassed) {
        return {
          content: [{ type: "text", text: validation.blockMessage! }],
          details: { blocked: true, phaseCount: params.phases.length, taskCount: params.phases.reduce((s, p) => s + p.tasks.length, 0), failures: validation.allFailures },
        };
      }

      const phases: FleetPhase[] = params.phases.map((p) => ({
        id: generateId(),
        name: p.name,
        status: "pending",
        tasks: p.tasks.map((t) => ({
          id: generateId(),
          agentName: t.agent,
          description: t.task,
          status: "pending" as const,
          reviewCount: 0,
          maxReviewCount: 3,
        })),
      }));

      fleetState.phases = phases;
      fleetState.startTime = fleetState.startTime || Date.now();
      fleetState.currentPhaseIndex = 0;
      fleetState.reviewIterations = 0;

      saveState();
      refreshWidget(ctx);

      // ── Auto-generate PROJECT-PLAN.md from planning ──
      const planDoc = generatePlanDocument(params.name, phases, ctx);
      const planPath = path.join(ctx.cwd, "PROJECT-PLAN.md");
      try {
        await fs.promises.writeFile(planPath, planDoc, "utf-8");
      } catch {
        // Non-fatal - plan doc generation is optional
      }

      const summary = phases
        .map((p, i) => `  P${i + 1}: ${p.name} (${p.tasks.length} tasks)`)
        .join("\n");

      return {
        content: [{ type: "text", text: `Project "${params.name}" planned:\n${summary}\n\n📄 Plan document: PROJECT-PLAN.md` }],
        details: { phases, totalPhases: phases.length },
      };
    },

    promptSnippet: "Plan project phases and tasks for fleet execution",
  });

  pi.registerTool({
    name: "run_phase",
    label: "Run Phase",
    description:
      "Execute a phase by spawning sub-agents for each task. Returns results when all tasks complete.",
    parameters: Type.Object({
      phaseIndex: Type.Optional(
        Type.Number({ description: "Phase index to run (0-based). Defaults to current." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const theme = ctx.ui.theme;
      const idx = params.phaseIndex ?? fleetState.currentPhaseIndex;
      if (idx < 0 || idx >= fleetState.phases.length) {
        return {
          content: [{ type: "text", text: `Invalid phase index. Available: 0-${fleetState.phases.length - 1}` }],
          details: {},
        };
      }

      // Check if fleet is paused - block execution
      if (fleetState.paused) {
        const savedPath = stateFilePath(ctx.cwd);
        return {
          content: [{ type: "text", text:
            `⏸ Fleet is paused. Execution blocked.\n` +
            `  State saved at: ${savedPath}\n` +
            `  Use fleet_control(action="resume") to restore state and continue.`
          }],
          details: { paused: true, savedState: savedPath }
        };
      }

      const phase = fleetState.phases[idx]!;
      phase.status = "running";
      fleetState.currentPhaseIndex = idx;
      saveState();
      refreshWidget(ctx);

      onUpdate?.({ content: [{ type: "text", text: `Running phase: ${phase.name}` }] });

      const results: Array<{ agentName: string; exitCode: number; output: string; stderr: string }> = [];
      const allAgents = discoverAgents("both");

      for (const task of phase.tasks) {
        const agentDef = allAgents.find((a) => a.name === task.agentName);
        if (!agentDef) {
          task.status = "failed";
          results.push({ agentName: task.agentName, exitCode: 1, output: "", stderr: `Agent "${task.agentName}" not found` });
          continue;
        }

        // Track per-agent token usage
        let agentInputTokens = 0;
        let agentOutputTokens = 0;
        task.startedAt = Date.now();

        task.status = "running";
        fleetState.activeAgents = fleetState.activeAgents.map((a) =>
          a.name === agentDef.name
            ? { ...a, status: "running" as const, currentTask: truncate(task.description, 30) }
            : a
        );

        if (!fleetState.activeAgents.find((a) => a.name === agentDef.name)) {
          fleetState.activeAgents.push({
            name: agentDef.name,
            status: "running" as const,
            currentTask: truncate(task.description, 30),
            model: agentDef.model,
          });
        }

        refreshWidget(ctx);
        onUpdate?.({ content: [{ type: "text", text: `  ${agentDef.name}: ${truncate(task.description, 60)}` }] });

        // Initialize agent output buffer
        const agentKey2 = `agent-${agentDef.name}`;
        agentOutputBuffers.set(agentKey2, { stdout: "", stderr: "", running: true });

        // Real-time progress reporting for this subagent
        let lastProgressReport = 0;
        let lastTokenCount = 0;
        const progressCb = (chunk: string, tokenCount?: number) => {
          const now = Date.now();
          if (now - lastProgressReport > 1000) {
            lastProgressReport = now;
            lastTokenCount = tokenCount ?? lastTokenCount;
            const cleaned = cleanChunkText(chunk);
            const taskIndex = phase.tasks.indexOf(task);
            const elapsed = task.startedAt ? now - task.startedAt : 0;
            const progressLine = formatTaskProgress(
              theme,
              taskIndex,
              "running",
              agentDef.name,
              agentDef.model || "unknown",
              lastTokenCount,
              elapsed,
              task.description,
            );
            onUpdate?.({ content: [{ type: "text", text: progressLine }] });
          }
          // Capture agent output for follow
          const buf2 = agentOutputBuffers.get(agentKey2);
          if (buf2) buf2.stdout = safeAppend(buf2.stdout, chunk, 500_000);
          // Also route to followed agent buffer in real-time
          appendToFollowedAgent(agentDef.name, chunk);
        };

        const result = await runSubagent(agentDef, task.description, ctx.cwd, signal, `task-${task.id}`, progressCb);
        agentInputTokens = result.usage?.input || 0;
        agentOutputTokens = result.usage?.output || 0;
        task.output = buildTaskOutput(result.output, result.stderr);
        task.stderr = result.stderr || "";
        task.agentModel = result.model;
        task.tokensUsed = result.usage.input + result.usage.output;
        task.messageCount = result.usage.turns;
        task.status = result.exitCode === 0 ? "complete" as const : "failed" as const;
        fleetState.recentOutput = result.output || result.stderr;

        // Capture stderr and mark buffer as done
        const agentBuf2 = agentOutputBuffers.get(agentKey2);
        if (agentBuf2) {
          agentBuf2.stdout += result.stderr || "";
          agentBuf2.running = false;
        }
        if (result.stderr) {
          appendErrToFollowedAgent(agentDef.name, result.stderr);
        }

        fleetState.activeAgents = fleetState.activeAgents.map((a) =>
          a.name === agentDef.name
            ? {
                ...a,
                status: result.exitCode === 0 ? "idle" as const : "error" as const,
                currentTask: undefined,
                model: agentDef.model,
                tokensUsed: result.usage?.input + result.usage?.output,
                inputTokens: result.usage?.input || 0,
                outputTokens: result.usage?.output || 0,
                turns: result.usage?.turns,
              }
            : a
        );

        // Update total fleet tokens
        fleetState.totalFleetTokens += (agentInputTokens + agentOutputTokens);

        results.push({ agentName: task.agentName, exitCode: result.exitCode, output: result.output, stderr: result.stderr });
      }

      const allDone = phase.tasks.every((t) => t.status === "complete");
      phase.status = allDone ? "complete" : "failed";
      phase.completedAt = Date.now();

      fleetState.activeAgents = fleetState.activeAgents.filter((a) => a.status !== "running");

      saveState();
      refreshWidget(ctx);

      const successCount = results.filter((r) => r.exitCode === 0).length;
      return {
        content: [{ type: "text", text: `Phase "${phase.name}" complete: ${successCount}/${phase.tasks.length} succeeded.` }],
        details: { phase, results },
      };
    },

    promptSnippet: "Execute a phase with all its agent tasks",
  });

  // ---- Internal: review helpers ----

  async function runCodeReview(phaseIdx: number, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ approved: boolean; feedback: string; agentUsed: string; error?: string; usage?: { input: number; output: number } }> {
    const techLead = discoverAgents("both").find((a) => a.name === "tech-lead");
    if (!techLead) {
      const available = discoverAgents("both").map((a) => a.name).join(", ") || "(none)";
      return { approved: false, feedback: "No tech-lead agent found. Available agents: " + available, agentUsed: "none", error: "tech-lead" };
    }

    const phase = fleetState.phases[phaseIdx];
    const tasks = phase?.tasks.filter((t) => t.status === "complete" || t.status === "needs_fix") ?? [];

    onUpdate?.({ content: [{ type: "text", text: `  -> Tech Lead reviewing code quality...` }] });

    const reviewPrompt = `You are conducting a CODE QUALITY REVIEW as Tech Lead. Evaluate the developer's implementation against the following criteria:

## Review Criteria

1. **Correctness**: Does it match the task specification? Are edge cases handled? Error handling?
2. **Architecture**: Are design patterns appropriate? Is the code well-structured and maintainable?
3. **Security**: No hardcoded secrets, proper input validation, no injection vulnerabilities?
4. **Performance**: Efficient algorithms, no unnecessary re-renders, proper data structures?
5. **Code Quality**: Readable, well-commented, no duplication (DRY), consistent naming, proper file organization?
6. **Testing**: Test files created where appropriate? Tests cover key cases?

For each issue found, provide:
- File path and line number
- What is wrong
- How to fix it (with code snippet if applicable)
- Priority: CRITICAL, IMPORTANT, or NICE_TO_HAVE

If everything passes, explicitly state: "APPROVED: code quality review passed"

Tasks under review:
${tasks.map((t) => `Task: ${t.description}\nImplementation:\n${t.output || "(no output)"}\n`).join("\n---\n")}`;

    // Capture output for follow
    const crKey = `agent-tech-lead-review`;
    agentOutputBuffers.set(crKey, { stdout: "", stderr: "", running: true });
    const reviewOutputCb = (chunk: string) => {
      const buf = agentOutputBuffers.get(crKey);
      if (buf) buf.stdout += chunk;
      appendToFollowedAgent("tech-lead", chunk);
    };
    const result = await runSubagent(techLead, reviewPrompt, ctx.cwd, signal, `code-review-${phaseIdx}`, reviewOutputCb as any);
    const feedback = result.output || "";
    const approved = feedback.toUpperCase().includes("APPROVED") && !feedback.toLowerCase().includes("fix") && !feedback.toLowerCase().includes("error") && !feedback.toLowerCase().includes("vulnerability");

    // Capture stderr
    const crBuf = agentOutputBuffers.get(crKey);
    if (crBuf) {
      crBuf.stdout += result.stderr || "";
      crBuf.running = false;
    }

    const crErr = result.exitCode !== 0 || !feedback ? (result.exitCode === -1 ? "Tech-lead agent was killed (process terminated)" : `Tech-lead agent exited with code ${result.exitCode}${!feedback ? " and produced no output" : ""}`) : undefined;
    return { approved, feedback, agentUsed: "tech-lead", error: crErr, usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined };
  }

  async function runDesignReview(phaseIdx: number, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ approved: boolean; feedback: string; agentUsed: string; error?: string; usage?: { input: number; output: number } }> {
    const designer = discoverAgents("both").find((a) => a.name === "designer");
    if (!designer) {
      const available = discoverAgents("both").map((a) => a.name).join(", ") || "(none)";
      return { approved: false, feedback: "No designer agent found. Available agents: " + available, agentUsed: "none", error: "designer" };
    }

    const phase = fleetState.phases[phaseIdx];
    const tasks = phase?.tasks.filter((t) => t.status === "complete" || t.status === "needs_fix") ?? [];

    onUpdate?.({ content: [{ type: "text", text: `  -> Designer reviewing visual quality...` }] });

    const reviewPrompt = `You are conducting a DESIGN REVIEW as Creative Director. Evaluate the UI/visual implementation against the following criteria:

## Review Criteria

1. **Layout & Structure**: Elements properly aligned? Consistent spacing? Content hierarchy clear?
2. **Visual Consistency**: Color scheme consistent? Typography uniform? Component styles match patterns?
3. **Accessibility**: Sufficient color contrast? Clear interactive states? Readable text?
4. **User Experience**: Navigation intuitive? User feedback for actions? No jarring transitions?
5. **Polish**: No visual glitches? Appropriate icons/images? Proper empty/loading/error states?

For each issue found, provide:
- Element/component description
- File path if identifiable
- What is visually wrong
- Suggested improvement
- Priority: CRITICAL, IMPORTANT, or NICE_TO_HAVE

If everything passes, explicitly state: "APPROVED: design review passed"

Tasks under review:
${tasks.map((t) => `Task: ${t.description}\nImplementation:\n${t.output || "(no output)"}\n`).join("\n---\n")}`;

    // Capture output for follow
    const drKey = `agent-designer-review`;
    agentOutputBuffers.set(drKey, { stdout: "", stderr: "", running: true });
    const reviewOutputCb2 = (chunk: string) => {
      const buf = agentOutputBuffers.get(drKey);
      if (buf) buf.stdout += chunk;
      appendToFollowedAgent("designer", chunk);
    };
    const result = await runSubagent(designer, reviewPrompt, ctx.cwd, signal, `design-review-${phaseIdx}`, reviewOutputCb2 as any);
    const feedback = result.output || "";
    const approved = feedback.toUpperCase().includes("APPROVED") && !feedback.toLowerCase().includes("fix") && !feedback.toLowerCase().includes("glitch") && !feedback.toLowerCase().includes("contrast");

    // Capture stderr
    const drBuf = agentOutputBuffers.get(drKey);
    if (drBuf) {
      drBuf.stdout += result.stderr || "";
      drBuf.running = false;
    }

    const drErr = result.exitCode !== 0 || !feedback ? (result.exitCode === -1 ? "Designer agent was killed (process terminated)" : `Designer agent exited with code ${result.exitCode}${!feedback ? " and produced no output" : ""}`) : undefined;
    return { approved, feedback, agentUsed: "designer", error: drErr, usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined };
  }

  async function runDeveloperFix(task: FleetTask, reviewFeedback: string, reviewType: string, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ success: boolean; error?: string; usage?: { input: number; output: number } }> {
    const developer = discoverAgents("both").find((a) => a.name === "developer");
    if (!developer) {
      const available = discoverAgents("both").map((a) => a.name).join(", ") || "(none)";
      return { success: false, error: `No developer agent found. Available agents: ${available}` };
    }
    if (!task.output) {
      return { success: false, error: "Task has no output to fix" };
    }

    onUpdate?.({ content: [{ type: "text", text: `  -> Developer fixing ${reviewType} issues...` }] });

    const fixPrompt = `Fix the issues identified in the ${reviewType} review:

Original task: ${task.description}
Your previous implementation:
${task.output}

${reviewType} review feedback:
${reviewFeedback}

Provide the complete corrected output with specific file changes. Address each issue mentioned in the feedback.
`;

    // Capture output for follow
    const fixKey = `agent-developer-fix-${task.id}`;
    agentOutputBuffers.set(fixKey, { stdout: "", stderr: "", running: true });
    const fixOutputCb = (chunk: string) => {
      const buf = agentOutputBuffers.get(fixKey);
      if (buf) buf.stdout += chunk;
      appendToFollowedAgent("developer", chunk);
    };
    const fixResult = await runSubagent(developer, fixPrompt, ctx.cwd, signal, `fix-${task.id}-${reviewType}`, fixOutputCb as any);
    task.output = buildTaskOutput(fixResult.output, fixResult.stderr);
    task.stderr = fixResult.stderr || "";
    task.reviewFeedback = reviewFeedback;
    task.reviewCount++;
    task.agentModel = fixResult.model;
    task.tokensUsed = fixResult.usage.input + fixResult.usage.output;
    task.messageCount = fixResult.usage.turns;
    fleetState.recentOutput = fixResult.output || "";

    // Capture stderr
    const fixBuf = agentOutputBuffers.get(fixKey);
    if (fixBuf) {
      fixBuf.stdout += fixResult.stderr || "";
      fixBuf.running = false;
    }

    // Orchestrator checks BOTH exit code AND output for fix success
    const fixOutput = fixResult.output || "";
    const hasFixOutput = fixOutput.trim().length > 0;
    const wasKilled = fixResult.exitCode === -1;
    if (wasKilled) {
      fleetState.recentOutput = "[CRITICAL] Developer fix process was killed — check stderr.";
    } else if (!hasFixOutput) {
      fleetState.recentOutput = "[WARNING] Developer fix produced no output — task will fail.";
    }
    return { success: fixResult.exitCode === 0 && hasFixOutput, error: wasKilled ? `Developer agent was killed (signal termination)` : fixResult.exitCode !== 0 ? `Developer agent exited with code ${fixResult.exitCode}` : undefined, usage: fixResult.usage ? { input: fixResult.usage.input, output: fixResult.usage.output } : undefined };
  }

  pi.registerTool({
    name: "review_task",
    label: "Review Task",
    description:
      "Submit completed tasks for two-stage review. First, the Tech Lead reviews code quality. " +
      "Then, the Designer reviews visual quality. " +
      "If either review fails, the Developer auto-fixes and resubmits.",
    parameters: Type.Object({
      phaseIndex: Type.Optional(Type.Number({ description: "Phase to review" })),
      reviewType: Type.Optional(
        Type.String({ description: "'full' (default: code+design), 'code' (tech-lead only), 'design' (designer only)" }),
      ),
      feedback: Type.Optional(Type.String({ description: "Manual review feedback (bypasses auto-review)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const phaseIdx = params.phaseIndex ?? fleetState.currentPhaseIndex;
      const phase = fleetState.phases[phaseIdx];
      const allAgents = discoverAgents("both");

      if (!phase) return { content: [{ type: "text", text: "No phase to review" }], details: {} };

      const incompleteTasks = phase.tasks.filter((t) => t.status !== "complete");
      if (incompleteTasks.length === 0) {
        if (phaseIdx < fleetState.phases.length - 1) {
          fleetState.currentPhaseIndex = phaseIdx + 1;
          saveState();
          refreshWidget(ctx);
          return { content: [{ type: "text", text: "All tasks complete. Moved to next phase." }], details: { moved: true } };
        }
        return { content: [{ type: "text", text: "All phases complete. Project done!" }], details: { done: true } };
      }

      const tasksToReview = incompleteTasks.filter((t) => t.status === "complete" || t.status === "needs_fix");
      if (tasksToReview.length === 0) return { content: [{ type: "text", text: "No tasks ready for review" }], details: {} };

      // Check pause before starting review
      if (fleetState.paused) {
        return {
          content: [{ type: "text", text:
            `⏸ Fleet is paused. Review blocked.\n` +
            `  Use fleet_control(action="resume") to restore state and continue.`
          }],
          details: { paused: true }
        };
      }

      fleetState.reviewIterations++;
      const reviewType = params.reviewType ?? "full";
      saveState();
      refreshWidget(ctx);

      onUpdate?.({
        content: [{ type: "text", text: `Review iteration ${fleetState.reviewIterations}: ${reviewType} review for ${tasksToReview.length} task(s)` }],
      });

      let codeResult: { approved: boolean; feedback: string; agentUsed: string; error?: string; usage?: { input: number; output: number } } | null = null;
      let designResult: { approved: boolean; feedback: string; agentUsed: string; error?: string; usage?: { input: number; output: number } } | null = null;

      if (reviewType === "full" || reviewType === "code") {
        codeResult = await runCodeReview(phaseIdx, signal, ctx, onUpdate);
      }
      if (reviewType === "full" || reviewType === "design") {
        designResult = await runDesignReview(phaseIdx, signal, ctx, onUpdate);
      }

      // Accumulate review tokens
      const reviewTokens = ((codeResult?.usage?.input || 0) + (codeResult?.usage?.output || 0))
        + ((designResult?.usage?.input || 0) + (designResult?.usage?.output || 0));
      fleetState.totalFleetTokens += reviewTokens;

      // Check for agent availability errors
      if (codeResult?.error) {
        const errors: string[] = [`Code review failed: ${codeResult.error}`];
        const available = discoverAgents("both").map((a) => a.name).join(", ") || "(none)";
        errors.push(`Available agents: ${available}`);
        return { content: [{ type: "text", text: errors.join("\n") }], details: { phase, codeResult, designResult } };
      }
      if (designResult?.error) {
        const errors: string[] = [`Design review failed: ${designResult.error}`];
        const available = discoverAgents("both").map((a) => a.name).join(", ") || "(none)";
        errors.push(`Available agents: ${available}`);
        return { content: [{ type: "text", text: errors.join("\n") }], details: { phase, codeResult, designResult } };
      }

      let allApproved = true;

      for (const task of tasksToReview) {
        // Check pause between tasks
        if (fleetState.paused) {
          saveState();
          return {
            content: [{ type: "text", text:
              `⏸ Review paused at task "${task.agentName}". State saved to disk.`
            }],
            details: { paused: true, completedTasks: tasksToReview.indexOf(task), totalTasks: tasksToReview.length }
          };
        }

        task.reviewFeedback = "";

        if (codeResult) {
          if (codeResult.approved) {
            task.codeReviewStatus = "approved";
            task.codeReviewFeedback = "";
          } else {
            task.codeReviewStatus = "needs_fix";
            task.codeReviewFeedback = codeResult.feedback;
            task.reviewFeedback += `[CODE REVIEW - ${codeResult.agentUsed}]:\n${codeResult.feedback}\n\n`;
            allApproved = false;
          }
        }

        if (designResult) {
          if (designResult.approved) {
            task.designReviewStatus = "approved";
            task.designReviewFeedback = "";
          } else {
            task.designReviewStatus = "needs_fix";
            task.designReviewFeedback = designResult.feedback;
            task.reviewFeedback += `[DESIGN REVIEW - ${designResult.agentUsed}]:\n${designResult.feedback}\n\n`;
            allApproved = false;
          }
        }

        if (!allApproved && task.reviewCount < task.maxReviewCount) {
          task.status = "needs_fix";

          if (codeResult && !codeResult.approved && task.codeReviewFeedback) {
            const fixCode = await runDeveloperFix(task, task.codeReviewFeedback, "code", signal, ctx, onUpdate);
            if (fixCode.error) {
              task.reviewFeedback += `[AUTO-FIX ERROR - Code]: ${fixCode.error}\n\n`;
            }
          }
          if (designResult && !designResult.approved && task.designReviewFeedback) {
            const fixDesign = await runDeveloperFix(task, task.designReviewFeedback, "design", signal, ctx, onUpdate);
            if (fixDesign.error) {
              task.reviewFeedback += `[AUTO-FIX ERROR - Design]: ${fixDesign.error}\n\n`;
            }
          }
        } else if (!allApproved) {
          task.status = "failed";
        } else {
          task.status = "complete";
        }
      }

      const allDone = phase.tasks.every((t) => t.status === "complete");
      if (allDone) {
        phase.status = "complete";
        phase.completedAt = Date.now();
        if (phaseIdx < fleetState.phases.length - 1) {
          fleetState.currentPhaseIndex = phaseIdx + 1;
        }
      } else if (allApproved) {
        phase.status = "complete";
        phase.completedAt = Date.now();
        if (phaseIdx < fleetState.phases.length - 1) {
          fleetState.currentPhaseIndex = phaseIdx + 1;
        }
      }

      fleetState.activeAgents = fleetState.activeAgents.filter((a) => a.status !== "running");
      saveState();
      refreshWidget(ctx);

      const reviewSummary: string[] = [];
      if (codeResult) reviewSummary.push(`Code review: ${codeResult.approved ? "APPROVED" : "NEEDS FIX"} (${codeResult.agentUsed})`);
      if (designResult) reviewSummary.push(`Design review: ${designResult.approved ? "APPROVED" : "NEEDS FIX"} (${designResult.agentUsed})`);

      return {
        content: [{
          type: "text",
          text: `Review iteration ${fleetState.reviewIterations}: ${reviewSummary.join(" | ")} | ` +
            `${allDone ? "Phase complete!" : `${tasksToReview.length - (allApproved ? tasksToReview.length : 0)} tasks need more work`}`,
        }],
        details: { phase, codeResult, designResult, reviewed: tasksToReview.length, allApproved },
      };
    },

    promptSnippet: "Two-stage review: code quality (tech-lead) + design quality (designer). Auto-fix on failure.",
  });

  pi.registerTool({
    name: "fleet_status",
    label: "Fleet Status",
    description: "Query fleet state: phases, tasks, agents, progress.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // Check for all-complete (fleet finished) before checking for no-phases
      const allComplete = fleetState.phases.length > 0 && fleetState.phases.every(p => p.status === "complete");
      if (allComplete || fleetState.phases.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Fleet is idle. ${allComplete ? "All phases complete." : "No phases defined."}
Use /caravel-fleet to toggle the widget bar, or use plan_project to define phases.

Status: idle | ${formatDuration(Date.now() - fleetState.startTime)} elapsed`,
          }],
          details: { phases: fleetState.phases, agents: fleetState.activeAgents },
        };
      }

      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      const completed = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);

      const phases = fleetState.phases.map((p, i) => {
        const done = p.tasks.filter((t) => t.status === "complete").length;
        // Strip embedded enumeration to avoid double-encoding
        const cleanName = p.name.replace(/^(Phase )?P\d+:\s*/i, "");
        return `  P${i}: ${cleanName} [${p.status}] (${done}/${p.tasks.length})`;
      });

      const agents = fleetState.activeAgents.map((a) => `  ${a.name}: [${a.status.toUpperCase()}]`);
      const progress = totalTasks > 0 ? `${Math.round((completed / totalTasks) * 100)}%` : "0%";

      return {
        content: [{
          type: "text",
          text: `Fleet: Phase ${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length} | ${progress} | ${fleetState.reviewIterations} reviews ${fleetState.paused ? "| [PAUSED]" : ""}\n\n` +
            phases.join("\n") +
            (agents.length > 0 ? `\n\n${agents.join("\n")}` : ""),
        }],
        details: { phases: fleetState.phases, agents: fleetState.activeAgents },
      };
    },

    promptSnippet: "Query fleet status and progress",
  });

  // ---- /caravel-pause: Pause fleet execution ----

  pi.registerCommand("caravel-pause", {
    description: "Pause fleet execution. Saves state to disk, blocks all execution (go, run_phase, reviews), and shows progress. Use /caravel-resume to restore state and continue.",
    handler: async (_args, ctx) => {
      if (fleetState.phases.length === 0) {
        return { content: [{ type: "text", text: "Fleet is idle. Nothing to pause." }] };
      }
      if (fleetState.paused) {
        return { content: [{ type: "text", text: "Fleet is already paused." }] };
      }
      // Save state before pausing
      saveState();
      fleetState.paused = true;
      refreshWidget(ctx);
      const phaseName = fleetState.currentPhaseIndex < fleetState.phases.length
        ? fleetState.phases[fleetState.currentPhaseIndex].name
        : "none";
      const savedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      return {
        content: [{ type: "text", text:
          `⏸ Fleet paused.\n` +
          `  State saved to: ${stateFilePath(ctx.cwd)}\n` +
          `  Current phase: ${phaseName}\n` +
          `  Progress: ${savedTasks}/${totalTasks} tasks complete\n` +
          `  All execution blocked until resumed.\n` +
          `  Use /caravel-resume to restore state and continue from this exact point.`
        }],
        details: { paused: true, saved: true, phase: phaseName, completedTasks: savedTasks, totalTasks }
      };
    },
  });

  // ---- /caravel-resume: Resume fleet execution ----

  pi.registerCommand("caravel-resume", {
    description: "Resume fleet execution. Loads saved state from disk (if available), clears pause flag, and continues from the exact point of pause. Use /caravel-pause to pause first.",
    handler: async (_args, ctx) => {
      if (!fleetState.paused) {
        return { content: [{ type: "text", text: "Fleet is not paused." }] };
      }
      // Load saved state from disk to ensure we resume from a known good checkpoint
      const loaded = loadState(ctx);
      fleetState.paused = false;
      refreshWidget(ctx);
      saveState(); // Save the cleared pause flag
      const phaseIdx = fleetState.currentPhaseIndex;
      const phaseName = phaseIdx < fleetState.phases.length ? fleetState.phases[phaseIdx].name : "none";
      const savedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      if (!loaded) {
        return {
          content: [{ type: "text", text:
            `▶ Fleet resumed (no saved state found).\n` +
            `  Current phase: ${phaseName}\n` +
            `  Execution continues from current point.\n` +
            `  To use save/resume: pause mid-execution to create a checkpoint first.`
          }],
          details: { paused: false, loaded: false, phase: phaseName }
        };
      }
      return {
        content: [{ type: "text", text:
          `▶ Fleet resumed. State loaded from disk.\n` +
          `  State file: ${stateFilePath(ctx.cwd)}\n` +
          `  Current phase: ${phaseName}\n` +
          `  Progress: ${savedTasks}/${totalTasks} tasks complete\n` +
          `  Execution continues from the exact point of pause.`
        }],
        details: { paused: false, loaded: true, phase: phaseName, completedTasks: savedTasks, totalTasks, stateFile: stateFilePath(ctx.cwd) }
      };
    },
  });

  // ---- /diagnose: fleet error diagnosis ----

  pi.registerCommand("diagnose", {
    description: "Diagnose fleet errors: missing agents, exit codes, stderr, token limits, and provide actionable fix steps",
    handler: async (_args, ctx) => {
      const diag = diagnoseFleetErrors();
      const th = ctx.ui.theme;
      const sep = theme.fg("dim", "─").repeat(52);
      const section = (title: string) => `${theme.fg("accent", `▸ ${title}`)}\n  ${theme.fg("dim", sep)}`;
      const sevIcon = (s: string) => s === "critical" ? theme.fg("error", "✗") : s === "warning" ? theme.fg("warning", "⚠") : theme.fg("dim", "○");

      let response = ``;

      // ── Header ──
      response += `${theme.fg("dim", `CARAVEL FLEET ERROR DIAGNOSIS`)}\n${theme.fg("dim", sep)}\n\n`;

      // ── Summary ──
      response += `${theme.fg("accent", "📋 Summary")}\n\n`;
      response += `${diag.summary}\n\n`;

      // ── Affected phases ──
      if (diag.affectedPhases.length > 0) {
        response += `${section("Affected Phases")}\n`;
        for (const p of diag.affectedPhases) {
          const failedCount = p.tasks.filter((t) => t.status === "failed").length;
          const total = p.tasks.length;
          response += `  ${theme.fg("error", "✗")} P${fleetState.phases.indexOf(p) + 1}: ${p.name} (${failedCount}/${total} failed)\n`;
        }
        response += "\n";
      }

      // ── Root causes ──
      if (diag.causes.length > 0) {
        response += `${section("Root Causes & Fix Steps")}\n`;
        for (let i = 0; i < diag.causes.length; i++) {
          const c = diag.causes[i]!;
          response += `\n${sevIcon(c.severity)} [${c.severity.toUpperCase()}] ${i + 1}. ${c.cause}\n`;
          response += `    Affected: ${c.affected}\n`;
          response += `    Cause: ${c.explanation}\n`;
          response += `    Fix steps:\n`;
          for (const step of c.fixSteps) {
            response += `      ${theme.fg("dim", "→")} ${step}\n`;
          }
        }
        response += "\n";
      }

      // ── Overall action ──
      response += `${theme.fg("accent", "💡 Overall Action")}\n`;
      response += `  ${theme.fg("dim", "→")} ${diag.overallAction}\n\n`;

      // ── Quick commands ──
      response += `${section("Quick Commands")}\n`;
      response += `  ${theme.fg("dim", "→")} /caravel-fleet - Toggle widget visibility\n`;
      response += `  ${theme.fg("dim", "→")} fleet_status - Query current state\n`;
      if (diag.affectedPhases.length > 0) {
        const lastFailedIdx = fleetState.phases.indexOf(diag.affectedPhases[diag.affectedPhases.length - 1]);
        response += `  ${theme.fg("dim", "→")} fleet_control(action="reset") - Reset fleet state\n`;
        response += `  ${theme.fg("dim", "→")} fleet_control(action="next") - Move past failed phases\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Missing agent") || c.cause.includes("missing"))) {
        response += `  ${theme.fg("accent", "→")} Create missing agent files in agents/ directory\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Token") || c.cause.includes("token"))) {
        response += `  ${theme.fg("accent", "→")} Reduce task scope or switch to a larger-context model\n`;
      }
      response += "\n";

      return { content: [{ type: "text", text: response }] };
    },
  });

  // ---- /grill: relentlessly challenge the user's idea ----

  pi.registerCommand("grill", {
    description: "Relentlessly challenge the user's project idea from two angles - requirements (why) and plan (how). One question at a time. Persists to SCOPE.md.",
    handler: async (_args, ctx) => {
      const th = ctx.ui.theme;
      const sep = theme.fg("dim", "─").repeat(52);

      // Create initial SCOPE.md template
      const scopePath = "SCOPE.md";
      const scopeTemplate = `# Project Scope

> Grill started: ${new Date().toISOString().split("T")[0]}
> Status: In progress
> Questions asked: 0
> User confirmed: Pending
> Ready to plan: Pending

## Requirements (The "Why")

| # | Question | Answer | Confirmed |
|---|----------|--------|-----------|
| 1 | Problem? |        | ☐ Pending |
| 2 | Users?   |        | ☐ Pending |
| 3 | Success? |        | ☐ Pending |
| 4 | Scope?   |        | ☐ Pending |
| 5 | Not built? |      | ☐ Pending |

## Design Decisions (The "How")

| # | Decision | Answer | Confirmed |
|---|----------|--------|-----------|
| 1 | Stack?   |        | ☐ Pending |
| 2 | Priority |        | ☐ Pending |
| 3 | Scale?   |        | ☐ Pending |

## Risks & Unknowns

- None yet (grill in progress)

## Sign-Off

- User confirmed: ☐ Not confirmed
- Ready to plan: ☐ Not ready
`;

      try {
        await fs.promises.writeFile(scopePath, scopeTemplate, "utf-8");
      } catch {
        // Silently continue if we can't write
      }

      let response = "";
      response += theme.fg("dim", "PROJECT SCOPE GRILL") + "\n";
      response += theme.fg("dim", sep) + "\n";
      response += "\n";
      response += theme.fg("accent", "🔥 Grill mode engaged — challenging your idea from two angles:\n\n") + "\n";
      response += theme.fg("dim", "  Angle A — Requirements  (Why are we building this? What problem does it solve?)") + "\n";
      response += theme.fg("dim", "  Angle B — Plan         (Is this the right approach? What are we missing?)") + "\n";
      response += "\n";
      response += theme.fg("dim", sep) + "\n\n";
      response += theme.fg("dim", "One question at a time. I'll provide a recommended answer with reasoning.\n\n") + "\n";
      response += theme.fg("accent", "📋 First question — The Problem:\n\n") + "\n";
      response += theme.fg("dim", "What problem are we actually solving? Who is this for? What do they do today?") + "\n";
      response += theme.fg("dim", "My guess: You have a specific pain point that this project addresses.") + "\n";
      response += theme.fg("dim", "Is that right, or is the real problem something else?") + "\n\n";
      response += theme.fg("dim", "Your answer will be saved to SCOPE.md.\n\n") + "\n";
      response += theme.fg("muted", "Artifacts: " + scopePath + " will persist your answers. Answer and I'll push the next question.") + "\n";

      return { content: [{ type: "text", text: response }] };
    },
  });

  pi.registerTool({
    name: "fleet_error_diagnosis",
    label: "Fleet Error Diagnosis",
    description: "Analyze fleet errors - missing agents, exit codes, stderr, token limits, rate limits - and provide actionable fix steps for each cause.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const diag = diagnoseFleetErrors();
      const th = ctx.ui.theme;
      const sep = theme.fg("dim", "─").repeat(52);
      const section = (title: string) => `${theme.fg("accent", `▸ ${title}`)}\n  ${theme.fg("dim", sep)}`;
      const sevIcon = (s: string) => s === "critical" ? theme.fg("error", "✗") : s === "warning" ? theme.fg("warning", "⚠") : theme.fg("dim", "○");

      let response = ``;

      response += `${theme.fg("dim", `CARAVEL FLEET ERROR DIAGNOSIS`)}\n${theme.fg("dim", sep)}\n\n`;
      response += `${theme.fg("accent", "📋 Summary")}\n\n`;
      response += `${diag.summary}\n\n`;

      if (diag.affectedPhases.length > 0) {
        response += `${section("Affected Phases")}\n`;
        for (const p of diag.affectedPhases) {
          const failedCount = p.tasks.filter((t) => t.status === "failed").length;
          const total = p.tasks.length;
          response += `  ${theme.fg("error", "✗")} P${fleetState.phases.indexOf(p) + 1}: ${p.name} (${failedCount}/${total} failed)\n`;
        }
        response += "\n";
      }

      if (diag.causes.length > 0) {
        response += `${section("Root Causes & Fix Steps")}\n`;
        for (let i = 0; i < diag.causes.length; i++) {
          const c = diag.causes[i]!;
          response += `\n${sevIcon(c.severity)} [${c.severity.toUpperCase()}] ${i + 1}. ${c.cause}\n`;
          response += `    Affected: ${c.affected}\n`;
          response += `    Cause: ${c.explanation}\n`;
          response += `    Fix steps:\n`;
          for (const step of c.fixSteps) {
            response += `      ${theme.fg("dim", "→")} ${step}\n`;
          }
        }
        response += "\n";
      }

      response += `${theme.fg("accent", "💡 Overall Action")}\n`;
      response += `  ${theme.fg("dim", "→")} ${diag.overallAction}\n\n`;

      response += `${section("Quick Commands")}\n`;
      response += `  ${theme.fg("dim", "→")} /caravel-fleet - Toggle widget visibility\n`;
      response += `  ${theme.fg("dim", "→")} fleet_status - Query current state\n`;
      if (diag.affectedPhases.length > 0) {
        response += `  ${theme.fg("dim", "→")} fleet_control(action="reset") - Reset fleet state\n`;
        response += `  ${theme.fg("dim", "→")} fleet_control(action="next") - Move past failed phases\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Missing agent") || c.cause.includes("missing"))) {
        response += `  ${theme.fg("accent", "→")} Create missing agent files in agents/ directory\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Token") || c.cause.includes("token"))) {
        response += `  ${theme.fg("accent", "→")} Reduce task scope or switch to a larger-context model\n`;
      }
      response += "\n";

      return { content: [{ type: "text", text: response }], details: { causes: diag.causes, summary: diag.summary, affectedPhases: diag.affectedPhases, affectedTasks: diag.affectedTasks } };
    },

    promptSnippet: "Diagnose fleet errors and provide fix steps",
  });

  pi.registerTool({
    name: "fleet_control",
    label: "Fleet Control",
    description: "Pause, resume, skip phase, move to next phase, reset fleet state, or auto-orchestrate.",
    parameters: Type.Object({
      action: Type.String({ description: "pause | resume | skip | next | reset | go" }),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      switch (params.action) {
        case "pause": {
          // Save state before pausing so we can resume exactly where we left off
          saveState();
          fleetState.paused = true;
          refreshWidget(ctx);
          const phaseName = fleetState.currentPhaseIndex < fleetState.phases.length
            ? fleetState.phases[fleetState.currentPhaseIndex].name
            : "none";
          const savedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
          const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
          return {
            content: [{ type: "text", text:
              `⏸ Fleet paused.\n` +
              `  State saved to disk.\n` +
              `  Current phase: ${phaseName}\n` +
              `  Progress: ${savedTasks}/${totalTasks} tasks complete\n` +
              `  Use resume to continue from this exact point.`
            }],
            details: { paused: true, saved: true, phase: phaseName, completedTasks: savedTasks, totalTasks }
          };
        }
        case "resume": {
          // Load saved state from disk to ensure we resume from a known good checkpoint
          const loaded = loadState(ctx);
          fleetState.paused = false;
          refreshWidget(ctx);
          saveState(); // Save the cleared pause flag
          if (!loaded) {
            return {
              content: [{ type: "text", text:
                `⚠️ Resume: No saved state file found. Starting fresh.\n\n` +
                `To use pause/resume:\n` +
                `  1. Call fleet_control(action="pause") mid-execution\n` +
                `  2. State is saved to .caravel/state.json\n` +
                `  3. Call fleet_control(action="resume") to restore exact state\n` +
                `  4. Execution continues from the exact point of pause`
              }],
              details: { paused: false, loaded: false, reason: "no_saved_state" }
            };
          }
          const phaseIdx = fleetState.currentPhaseIndex;
          const phaseName = phaseIdx < fleetState.phases.length ? fleetState.phases[phaseIdx].name : "none";
          const savedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
          const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
          return {
            content: [{ type: "text", text:
              `▶ Fleet resumed. State loaded from disk.\n` +
              `  Current phase: ${phaseName}\n` +
              `  Progress: ${savedTasks}/${totalTasks} tasks complete\n` +
              `  Execution will continue from the paused point.`
            }],
            details: { paused: false, loaded: true, phase: phaseName, completedTasks: savedTasks, totalTasks, loadedFrom: stateFilePath(ctx.cwd) }
          };
        }
        case "skip":
          if (fleetState.currentPhaseIndex < fleetState.phases.length) {
            fleetState.phases[fleetState.currentPhaseIndex].status = "complete";
            fleetState.currentPhaseIndex++;
            saveState();
            refreshWidget(ctx);
            return { content: [{ type: "text", text: "Phase skipped" }], details: {} };
          }
          return { content: [{ type: "text", text: "No phase to skip" }], details: {} };
        case "next":
          if (fleetState.currentPhaseIndex < fleetState.phases.length - 1) {
            fleetState.currentPhaseIndex++;
            saveState();
            refreshWidget(ctx);
            return { content: [{ type: "text", text: `Moved to phase ${fleetState.currentPhaseIndex + 1}` }], details: {} };
          }
          return { content: [{ type: "text", text: "Already at last phase" }], details: {} };
        case "reset":
          fleetState = {
            phases: [],
            currentPhaseIndex: 0,
            activeAgents: [],
            paused: false,
            startTime: 0,
            reviewIterations: 0,
            maxReviewIterations: 5,
            recentOutput: "",
            mainAgentActivity: {
              status: "idle",
              action: "idle",
              detail: "No active work",
              timestamp: Date.now(),
            },
          };
          saveState();
          refreshWidget(ctx);
          return { content: [{ type: "text", text: "Fleet state reset" }], details: {} };
        case "go": {
          if (fleetState.phases.length === 0) {
            return { content: [{ type: "text", text: "Fleet is idle. No phases defined. Use plan_project() first." }], details: {} };
          }
          // Check if fleet is paused
          if (fleetState.paused) {
            return {
              content: [{ type: "text", text:
                `⏸ Fleet is paused. Execution blocked.\n` +
                `  Use fleet_control(action="resume") to restore state and continue.`
              }],
              details: { paused: true }
            };
          }
          const results: string[] = [];
          let phaseIndex = fleetState.currentPhaseIndex;

          while (phaseIndex < fleetState.phases.length) {
            // Check pause flag between phases
            if (fleetState.paused) {
              results.push(`⏸ Execution paused at phase ${phaseIndex + 1}. State saved to disk.`);
              break;
            }

            const phase = fleetState.phases[phaseIndex];

            if (phase.status === "complete") {
              results.push(`✅ Phase ${phaseIndex + 1} "${phase.name}" - already complete`);
              phaseIndex++;
              continue;
            }

            if (phase.status === "failed" && phaseIndex !== fleetState.currentPhaseIndex) {
              results.push(`⚠️ Phase ${phaseIndex + 1} "${phase.name}" - failed, skipping`);
              phaseIndex++;
              continue;
            }

            results.push(`\n▶ Running Phase ${phaseIndex + 1}/${fleetState.phases.length}: "${phase.name}"`);
            fleetState.currentPhaseIndex = phaseIndex;
            saveState();
            refreshWidget(ctx);

            const phaseResult = await runPhaseInternal(phaseIndex, ctx, signal, onUpdate as any);
            results.push(phaseResult);

            // Check if phase execution was paused mid-task
            if (fleetState.paused) {
              results.push(`⏸ Phase execution paused. Use /caravel-resume to continue.`);
              break;
            }

            const hasReviewableTasks = phase.tasks.some(
              (t) => t.status === "complete" || t.status === "needs_fix"
            );

            if (hasReviewableTasks) {
              results.push(`\n🔍 Reviewing Phase ${phaseIndex + 1}...`);
              const reviewResult = await runReviewInternal(phaseIndex, ctx, onUpdate as any);
              results.push(reviewResult);

              // Check pause between review and re-run
              if (fleetState.paused) {
                results.push(`⏸ Review paused. Use /caravel-resume to continue.`);
                break;
              }

              const phaseStillIncomplete = phase.tasks.some(
                (t) => t.status !== "complete"
              );
              if (phaseStillIncomplete) {
                results.push(`\n🔁 Re-running Phase ${phaseIndex + 1} after review fixes...`);
                const rerunResult = await runPhaseInternal(phaseIndex, ctx, signal, onUpdate as any);
                results.push(rerunResult);
              }
            }

            const phaseComplete = phase.tasks.every((t) => t.status === "complete");
            if (phaseComplete) {
              phase.status = "complete";
              phase.completedAt = Date.now();
              results.push(`✅ Phase ${phaseIndex + 1} "${phase.name}" complete`);
            }

            saveState();
            refreshWidget(ctx);
            phaseIndex++;
          }

          const allComplete = fleetState.phases.every((p) => p.status === "complete");
          if (allComplete) {
            results.push(`\n🎉 All phases complete! Fleet has finished.`);
          }

          return { content: [{ type: "text", text: results.join("\n") }], details: { completed: true } };
        }
        // ── Background process management ──
        case "bg_start": {
          const bg = getBgManager();
          bg.setCwd(ctx.cwd);
          const result = await bg.startBackground(ctx);
          return {
            content: [{ type: "text", text: result.message }],
            details: { success: result.success, state: bg.getState() },
          };
        }
        case "bg_stop": {
          const bg = getBgManager();
          const result = await bg.stopBackground();
          return {
            content: [{ type: "text", text: result.message }],
            details: { success: result.success },
          };
        }
        case "bg_export": {
          const bg = getBgManager();
          const result = await bg.exportToBackground();
          return {
            content: [{ type: "text", text: result.message }],
            details: { success: result.success },
          };
        }
        case "migrate_to_zfs": {
          const bg = getBgManager();
          bg.setCwd(ctx.cwd);
          const result = await bg.migrateToZFS(ctx);
          return {
            content: [{ type: "text", text: result.message }],
            details: { success: result.success, state: bg.getState() },
          };
        }
        case "bg_status": {
          const bg = getBgManager();
          const state = bg.getState();
          const zfs = ensureZFS();
          const zfsState = zfs.getFleetState();
          const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
          const completedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
          const elapsed = state.startedAt > 0 ? formatDuration(Date.now() - state.startedAt) : "N/A";
          const lines: string[] = [
            "╔═══════════════════════════════════════════════════════════╗",
            "║  BACKGROUND FLEET STATUS                                  ║",
            "╠═══════════════════════════════════════════════════════════╣",
          ];
          // Background state
          lines.push(`║  ── Background Process ──                                ║`);
          lines.push(`║    Running: ${`${state.running ? "✓ yes" : "○ no"}`.padEnd(39)}║`);
          lines.push(`║    PID: ${String(state.pid ?? "none").padEnd(39)}║`);
          lines.push(`║    Started: ${new Date(state.startedAt).toISOString().padEnd(39)}║`);
          lines.push(`║    Active: ${elapsed.padEnd(39)}║`);
          lines.push(`║    State file: ${state.stateFile.padEnd(34)}║`);
          lines.push("║");
          // ZFS state
          lines.push(`║  ── ZFS Session ──                                       ║`);
          lines.push(`║    Available: ${`${zfsState.zellijAvailable ? "✓ yes" : "○ no"}`.padEnd(39)}║`);
          lines.push(`║    Session: ${zfsState.sessionName.padEnd(39)}║`);
          lines.push(`║    Panes: ${zfsState.activePanes} active / ${zfsState.exitedPanes} exited${"".padEnd(26)}║`);
          lines.push("║");
          // Fleet state
          lines.push(`║  ── Fleet Progress ──                                    ║`);
          if (fleetState.phases.length === 0) {
            lines.push(`║    Status: idle                                          ║`);
          } else {
            const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
            const phaseLabel = currentPhase
              ? `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${currentPhase.name}`
              : "No active phase";
            lines.push(`║    Phase: ${phaseLabel.padEnd(39)}║`);
            lines.push(`║    Progress: ${`${completedTasks}/${totalTasks} tasks`.padEnd(39)}║`);
            const progress = totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : "0%";
            lines.push(`║    Completed: ${progress.padEnd(39)}║`);
          }
          lines.push("╚═══════════════════════════════════════════════════════════╝");
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { bgState: state, zfsState, fleetProgress: { totalTasks, completedTasks, totalPhases: fleetState.phases.length, currentPhaseIndex: fleetState.currentPhaseIndex } },
          };
        }
        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
      }
    },

    promptSnippet: "Control fleet execution: pause, resume, skip, next, reset, go, bg_start, bg_stop, bg_export, migrate_to_zfs, bg_status",
  });

  // ============================================================================
  // /zellij-* commands - ZFS fleet session management
  // ============================================================================

  // ---- /zellij-start: Launch fleet in Zellij ----

  pi.registerCommand("zellij-start", {
    description: "Launch the Caravel fleet in a Zellij session. Creates the session (if not running), spawns the orchestrator and agent panes, and initializes the floating status bar. If Zellij is not installed, shows installation instructions.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();

      // Check ZFS availability
      const check = await zfs.checkAndInitZellij();
      if (!check.available) {
        return {
          content: [{
            type: "text",
            text:
              `⚠️ ZFS: Zellij not found on this system.\n\n` +
              `${check.message}\n\n` +
              `Fleet will fall back to background process execution.\n` +
              `For the full fleet experience, install Zellij:\n` +
              `  Linux:  curl -LO https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz && tar xzf zellij-*.tar.gz && sudo mv zellij /usr/local/bin/\n` +
              `  macOS:  brew install zellij\n` +
              `  Windows: winget install Zellij.Zellij`,
          }],
        };
      }

      // Discover if fleet session already exists in zellij
      const discovery = await zfs.discoverSession();
      if (discovery.exists) {
        // Session already exists — switch to it
        const switched = await zfs.switchToSession();
        if (switched) {
          return {
            content: [{
              type: "text",
              text:
                `🔗 Switched to existing ZFS session "${FLEET_SESSION}".\n\n` +
                `The fleet session is already running.\n` +
                `Use /zellij-panes to list panes, /zellij-status for overview.`,
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text:
              `ZFS session "${FLEET_SESSION}" already exists but could not switch to it.\n\n` +
              `Use /zellij-stop to shut it down, then try /zellij-start again.`,
          }],
        };
      }

      // Discover available agents and create session
      // Check if we're running inside Zellij — can't create a new session from within.
      const insideZellij = await zfs.detectInsideZellij();

      const allAgents = discoverAgents("both");
      const agentDefs = allAgents
        .filter((a) => a.name !== "orchestrator")
        .map((a) => ({
          name: a.name,
          description: a.description,
        }));

      if (agentDefs.length === 0) {
        return {
          content: [{
            type: "text",
            text:
              `⚠️ No agents configured. Cannot start fleet.\n\n` +
              `Add agent files to your agents/ directory with valid frontmatter:\n` +
              `  ---\n` +
              `  name: developer\n` +
              `  description: Code implementation agent\n` +
              `  model: gpt-4o\n` +
              `  ---\n` +
              `  Agent system prompt...`,
          }],
        };
      }

      // Inside Zellij — apply the fleet layout to the current session instead.
      // We can't create a new session from within, but we can switch the current
      // session to the fleet layout.
      if (insideZellij) {
        // Ensure the fleet layout exists
        const layoutPath = path.join(ctx.cwd, "zellij-layout.kdl");
        if (!fs.existsSync(layoutPath)) {
          const layout = zfs.getLayoutConfig() ?? generateFleetLayout(agentDefs);
          fs.writeFileSync(layoutPath, layout, "utf-8");
        }

        // Switch to the fleet layout in this session
        const switchResult = await zfs.switchToFleetLayout(ctx.cwd);
        if (!switchResult.success) {
          return {
            content: [{
              type: "text",
              text: `Could not switch to fleet layout: ${switchResult.message}\n\n` +
                `Try manually:\n` +
                `  \`zellij action switch-layout fleet\`\n` +
                `  (requires a \`zellij-layout.kdl\` file in the project root)`,
            }],
          };
        }

        // Initialize status bar (floating pane) if possible
        zfs.initStatusBar();

        // Get fleet state for summary
        const state = zfs.getFleetState();

        const summaryLines: string[] = [];
        summaryLines.push(`✅ Fleet layout applied to session "${state.sessionName}".`);
        summaryLines.push(``);
        summaryLines.push(`  You are running inside Zellij session "${state.sessionName}".`);
        summaryLines.push(`  The fleet layout is now active.`);
        summaryLines.push(``);
        summaryLines.push(`  Agent panes:`);
        for (const agent of agentDefs) {
          summaryLines.push(`    ▸ ${agent.name.padEnd(14)} - ${agent.description.slice(0, 40)}`);
        }
        summaryLines.push(``);
        summaryLines.push(`  To add agent panes, use /zellij-panes to spawn them.`);
        summaryLines.push(`  See /zellij-status for fleet overview.`);

        return {
          content: [{ type: "text", text: summaryLines.join("\n") }],
          details: { session: state.sessionName, agents: agentDefs, layout: "in-session" },
        };
      }

      // Load layout or use default
      const layout = zfs.getLayoutConfig();
      const layoutPath = path.join(ctx.cwd, "zellij-layout.kdl");
      const hasCustomLayout = fs.existsSync(layoutPath);

      const result = await zfs.createSession(agentDefs, ctx.cwd);


      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: `Failed to create ZFS session: ${result.message}`,
          }],
        };
      }

      // Initialize status bar
      zfs.initStatusBar();

      // Get fleet state for summary
      const state = zfs.getFleetState();

      // Show launch summary
      const summaryLines: string[] = [];
      summaryLines.push(`✅ ZFS fleet session "${state.sessionName}" started.`);
      summaryLines.push(``);
      summaryLines.push(`Session: ${state.sessionName}`);
      summaryLines.push(`Layout: ${hasCustomLayout ? `custom (${layoutPath})` : "default"}`);
      summaryLines.push(`Agent panes: ${agentDefs.length}`);
      summaryLines.push(`Platform: ${state.platform.platform} (${state.platform.shell})`);
      summaryLines.push(``);
      summaryLines.push(`Agent panes:`);
      for (const agent of agentDefs) {
        summaryLines.push(`  ▸ ${agent.name.padEnd(14)} - ${agent.description.slice(0, 40)}`);
      }
      summaryLines.push(``);
      summaryLines.push(`Navigation:`);
      summaryLines.push(`  <leader>+o  →  Orchestrator   |  <leader>+d  →  Developer`);
      summaryLines.push(`  <leader>+t  →  Tech Lead      |  <leader>+D  →  Designer`);
      summaryLines.push(`  <leader>+s  →  Status bar     |  <leader>+w  →  Toggle status bar`);
      summaryLines.push(`  <leader>+1-5  →  Cycle panes  |  /zellij-panes  →  List panes`);

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: { session: state.sessionName, agents: agentDefs, layout: hasCustomLayout ? "custom" : "default" },
      };
    },
  });

  // ---- /zellij-stop: Shutdown ZFS session ----

  pi.registerCommand("zellij-stop", {
    description: "Shutdown the ZFS fleet session. Terminates all agent panes, stops background processes, and kills the Zellij session. The fleet state is preserved for resumption.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const state = zfs.getFleetState();

      if (!state.zellijAvailable) {
        return {
          content: [{
            type: "text",
            text: `ZFS is not available. No session to stop.`,
          }],
        };
      }

      const activePanes = state.activePanes + state.activeProcesses;
      if (activePanes === 0) {
        // Kill session even if no panes (session might still exist)
        const killed = await zfs.killSession(state.sessionName);
        return {
          content: [{
            type: "text",
            text:
              `ZFS session "${state.sessionName}" stopped.\n` +
              `Session was empty (no active panes).`,
          }],
          details: { stopped: true, session: state.sessionName },
        };
      }

      // Clean up everything
      await zfs.cleanup();

      const summaryLines: string[] = [];
      summaryLines.push(`ZFS session "${state.sessionName}" stopped.`);
      summaryLines.push(``);
      summaryLines.push(`Terminated:`);
      summaryLines.push(`  Panes:  ${state.activePanes}`);
      summaryLines.push(`  Processes: ${state.activeProcesses}`);
      summaryLines.push(`  Session: ${state.sessionName}`);
      summaryLines.push(`  Platform: ${state.platform.platform} (${state.platform.shell})`);

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: { stopped: true, panes: state.activePanes, processes: state.activeProcesses, session: state.sessionName },
      };
    },
  });

  // ---- /zellij-panes: List available agent panes ----

  pi.registerCommand("zellij-panes", {
    description: "List all ZFS panes with their status. Shows agent names, pane IDs, running/exited state, and exit codes. Use this to find pane IDs for follow or stop operations.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const state = zfs.getFleetState();

      const lines: string[] = [];
      lines.push("╔═══════════════════════════════════════════════════════════╗");
      lines.push("║  ZFS PANES                                               ║");
      lines.push("╠═══════════════════════════════════════════════════════════╣");

      // Session header
      const sessionIcon = state.zellijAvailable ? "✓" : "○";
      const sessionColor = state.zellijAvailable ? "success" : "dim";
      const zfsLabel = state.zellijAvailable ? "✓ available" : "○ not available";
      lines.push(`║  Session: ${state.sessionName.padEnd(38)}║`);
      lines.push(`║  ZFS: ${zfsLabel.padEnd(38)}║`);
      lines.push(`║  Platform: ${`${state.platform.platform} (${state.platform.shell})`.padEnd(38)}║`);
      lines.push("║");

      // List active panes
      const panes = zfs.listPanes();
      const runningPanes = panes.filter((p) => p.running);
      const exitedPanes = panes.filter((p) => p.exited);

      if (runningPanes.length > 0) {
        lines.push("║  ▸ Running:                                               ║");
        for (const p of runningPanes) {
          const name = (p.name || "unnamed").padEnd(14);
          const pid = (p.paneId || "").slice(0, 30);
          lines.push(`║    ▸ ${name} (${pid.padEnd(30)}) [running]               ║`);
        }
        lines.push("");
      }

      if (exitedPanes.length > 0) {
        lines.push("║  ○ Exited:                                               ║");
        for (const p of exitedPanes) {
          const name = (p.name || "unnamed").padEnd(14);
          const pid = (p.paneId || "").slice(0, 30);
          const code = p.exitCode != null ? String(p.exitCode) : "?";
          lines.push(`║    ○ ${name} (${pid.padEnd(30)}) [exited:${code.padEnd(4)}]         ║`);
        }
        lines.push("");
      }

      if (runningPanes.length === 0 && exitedPanes.length === 0) {
        lines.push("║    No panes registered.                                  ║");
        lines.push("");
      }

      // Fleet state summary
      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      const completedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
      const progress = totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : "0%";
      const elapsed = formatDuration(Date.now() - (fleetState.startTime || Date.now()));

      lines.push("║  Fleet State:                                             ║");
      lines.push(`║    Phases: ${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}  │  Progress: ${progress.padEnd(6)}  │  ${elapsed.padEnd(10)} elapsed║`);
      lines.push(`║    Tasks: ${completedTasks}/${totalTasks}  │  Reviews: ${buildWidgetReviewStatus(fleetState)}  │  Tokens: ${formatTokens(fleetState.totalFleetTokens).padEnd(10)}║`);
      if (fleetState.paused) lines.push(`║    ⚠️  PAUSED                                              ║`);
      lines.push("║");
      lines.push("║  Commands:                                                ║");
      lines.push(`║    /zellij-panes  - This list                            ║`);
      lines.push(`║    /zellij-follow <name>  - Follow an agent              ║`);
      lines.push(`║    /zellij-status   - Fleet overview                     ║`);
      lines.push(`║    /zellij-start    - Start fleet session                ║`);
      lines.push(`║    /zellij-stop     - Stop fleet session                 ║`);
      lines.push("╚═══════════════════════════════════════════════════════════╝");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { panes, state },
      };
    },
  });

  // ---- /zellij-follow: Follow an agent's output ----

  pi.registerCommand("zellij-follow", {
    description: "Follow an agent's live output in the main pane. Use /zellij-follow list to see available agents, /zellij-follow <agent_name> to follow, /zellij-follow none to stop following, /zellij-follow switch to cycle between running agents.",
    handler: async (args: string[], ctx) => {
      const cmd = (args[0] ?? "none").toLowerCase();
      const zfs = ensureZFS();

      if (cmd === "list") {
        const runningAgents = fleetState.activeAgents.filter((a) => a.status === "running");
        const completedAgents = fleetState.activeAgents.filter((a) => a.status === "idle");
        const lines: string[] = [];
        lines.push("╔═══════════════════════════════════════════════════════╗");
        lines.push("║  ZFS FOLLOW TARGETS                                   ║");
        lines.push("╠═══════════════════════════════════════════════════════╣");

        // ZFS session status
        const state = zfs.getFleetState();
        const zfsIcon = state.zellijAvailable ? "✓" : "○";
        lines.push(`║  ZFS: ${zfsIcon} ${state.sessionName.padEnd(35)}║`);
        lines.push("");

        if (runningAgents.length > 0) {
          lines.push("║  ▸ Running:                                           ║");
          for (const a of runningAgents) {
            const icon = followedAgent.agent === a.name ? "▸" : "○";
            const name = a.name.padEnd(14);
            const task = (a.currentTask || "idle").padEnd(28);
            const model = (a.model || "?").padEnd(16);
            lines.push(`║    ${icon} ${name}  ${model}  ${task}      ║`);
          }
          lines.push("");
        }

        if (completedAgents.length > 0) {
          lines.push("║  ○ Completed:                                         ║");
          for (const a of completedAgents) {
            const name = a.name.padEnd(14);
            const model = (a.model || "?").padEnd(16);
            const tokens = a.tokensUsed != null ? `${formatTokens(a.tokensUsed)}t` : "?";
            lines.push(`║    ○ ${name}  ${model}  ${tokens.padEnd(14)}║`);
          }
          lines.push("");
        }

        if (runningAgents.length === 0 && completedAgents.length === 0) {
          lines.push("║    No agents have run yet.                            ║");
        }

        const followStatus = followedAgent.agent
          ? `Following: ${followedAgent.agent}`
          : "Not following anyone";
        lines.push("║");
        lines.push(`║  Status: ${followStatus.padEnd(37)}║`);
        lines.push("║");
        lines.push("║  Commands:                                            ║");
        lines.push(`║    /zellij-follow <agent>  - Follow agent output      ║`);
        lines.push(`║    /zellij-follow switch   - Cycle between agents    ║`);
        lines.push(`║    /zellij-follow none     - Stop following           ║`);
        lines.push(`║    /zellij-follow list     - Show this list           ║`);
        lines.push("╚═══════════════════════════════════════════════════════╝");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (cmd === "switch") {
        const runningAgents = fleetState.activeAgents.filter((a) => a.status === "running");
        if (runningAgents.length === 0) {
          return { content: [{ type: "text", text: "No running agents to follow." }] };
        }
        const currentIndex = runningAgents.findIndex((a) => a.name === followedAgent.agent);
        const nextIndex = (currentIndex + 1) % runningAgents.length;
        const nextAgent = runningAgents[nextIndex];

        if (followedAgent.agent) {
          agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
            stdout: followedAgent.output,
            stderr: "",
            running: false,
          });
        }

        followedAgent = {
          agent: nextAgent.name,
          output: getAgentOutput(nextAgent.name),
          isLive: true,
        };
        agentOutputBuffers.set(`agent-${nextAgent.name}`, { stdout: "", stderr: "", running: true });
        refreshWidget(ctx);
        ctx.ui.notify(`ZFS: Following ${nextAgent.name}`, "info");
        return { content: [{ type: "text", text: `Now following ${nextAgent.name}'s output.` }] };
      }

      if (cmd === "none") {
        if (followedAgent.agent) {
          agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
            stdout: followedAgent.output,
            stderr: "",
            running: false,
          });
        }
        const unfollowedName = followedAgent.agent;
        followedAgent = { agent: null, output: "", isLive: false };
        refreshWidget(ctx);
        if (unfollowedName) {
          ctx.ui.notify(`ZFS: Unfollowed ${unfollowedName}`, "info");
          return { content: [{ type: "text", text: `Stopped following ${unfollowedName}.` }] };
        }
        return { content: [{ type: "text", text: "Already not following anyone." }] };
      }

      // Try to follow the named agent
      const agentName = cmd;
      const targetAgent = fleetState.activeAgents.find((a) => a.name === agentName);
      const allAgents = discoverAgents("both");
      const knownAgent = allAgents.find((a) => a.name === agentName);

      if (!targetAgent && !knownAgent) {
        return { content: [{ type: "text", text: `Unknown agent "${agentName}". Use /zellij-follow list to see available agents.` }] };
      }

      if (followedAgent.agent === agentName) {
        return { content: [{ type: "text", text: `Already following ${agentName}.` }] };
      }

      // Capture previous agent output
      if (followedAgent.agent) {
        agentOutputBuffers.set(`agent-${followedAgent.agent}`, {
          stdout: followedAgent.output,
          stderr: "",
          running: false,
        });
      }

      // Ensure buffer exists
      const agentKey = `agent-${agentName}`;
      if (!agentOutputBuffers.has(agentKey)) {
        agentOutputBuffers.set(agentKey, { stdout: "", stderr: "", running: false });
      }

      followedAgent = {
        agent: agentName,
        output: getAgentOutput(agentName),
        isLive: targetAgent?.status === "running" || false,
      };

      // Update the buffer status
      const buf = agentOutputBuffers.get(agentKey);
      if (buf) {
        buf.running = targetAgent?.status === "running" || false;
      }

      // Try ZFS follow if agent has a pane
      if (targetAgent && targetAgent.status === "running") {
        // Try to subscribe to the agent's ZFS pane output
        const zfsPanes = zfs.listPanes();
        const matchingPane = zfsPanes.find((p) => p.name === agentName && p.running);
        if (matchingPane) {
          zfs.followPane(matchingPane.paneId, (chunk: string, paneName: string) => {
            appendToFollowedAgent(paneName, chunk);
          });
        }
      }

      refreshWidget(ctx);
      ctx.ui.notify(`ZFS: Following ${agentName}`, "info");
      return { content: [{ type: "text", text: `Now following ${agentName}'s output.` }] };
    },
  });

  // ---- /zellij-status: Show fleet overview ----

  pi.registerCommand("zellij-status", {
    description: "Show a comprehensive fleet overview: ZFS session status, fleet state (phases, tasks, progress), active agents with token usage, and quick action commands.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const state = zfs.getFleetState();
      const allAgents = discoverAgents("both");
      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      const completedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
      const progress = totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : "0%";
      const elapsed = formatDuration(Date.now() - (fleetState.startTime || Date.now()));

      const lines: string[] = [];
      lines.push("╔═══════════════════════════════════════════════════════════╗");
      lines.push("║  CARAVEL FLEET OVERVIEW                                  ║");
      lines.push("╠═══════════════════════════════════════════════════════════╣");

      // ── ZFS Session Status ──
      lines.push("║  ── ZFS Session ──                                      ║");
      const zfsIcon = state.zellijAvailable ? "✓" : "○";
      const zfsColor = state.zellijAvailable ? "success" : "dim";
      lines.push(`║    ZFS: ${zfsIcon} ${state.sessionName.padEnd(35)}║`);
      lines.push(`║    Platform: ${`${state.platform.platform} (${state.platform.shell})`.padEnd(35)}║`);
      lines.push(`║    Shell: ${state.platform.shellArg.padEnd(37)}║`);

      const activePanes = state.activePanes;
      const exitedPanes = state.exitedPanes;
      const activeProcs = state.activeProcesses;
      lines.push(`║    Panes: ${activePanes} active / ${exitedPanes} exited  │  Processes: ${activeProcs}${state.paused ? "  ⚠️  PAUSED" : "".padEnd(14)}║`);
      lines.push("║");

      // ── Fleet State ──
      lines.push("║  ── Fleet State ──                                      ║");

      if (fleetState.phases.length === 0) {
        lines.push("║    Status: idle                                          ║");
        lines.push(`║    Reviews: ${fleetState.reviewIterations}  │  Tokens: ${formatTokens(fleetState.totalFleetTokens).padEnd(27)}║`);
      } else {
        const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
        const phaseLabel = currentPhase
          ? `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${currentPhase.name}`
          : "No active phase";

        const sIcon = currentPhase
          ? currentPhase.status === "complete" ? "✓" :
            currentPhase.status === "failed" ? "✗" :
            currentPhase.status === "reviewing" ? "◉" :
            currentPhase.status === "running" ? "▸" :
            "○"
          : "○";
        const sText = currentPhase
          ? (currentPhase.status === "complete" ? "DONE" :
             currentPhase.status === "failed" ? "FAILED" :
             currentPhase.status === "reviewing" ? "REV" :
             currentPhase.status === "running" ? "RUN" :
             "?")
          : "?";
        const sColor = currentPhase
          ? (currentPhase.status === "complete" ? "success" :
             currentPhase.status === "failed" ? "error" :
             "accent")
          : "dim";

        lines.push(`║    ${sIcon} ${sText} ${phaseLabel.padEnd(44)}║`);
        lines.push(`║    Progress: ${progress.padEnd(6)}  │  Tasks: ${completedTasks}/${totalTasks}  │  ${elapsed.padEnd(10)} elapsed║`);
        lines.push(`║    Reviews: ${buildWidgetReviewStatus(fleetState)}  │  Tokens: ${formatTokens(fleetState.totalFleetTokens).padEnd(27)}║`);
        if (fleetState.paused) lines.push(`║    ⚠️  PAUSED                                          ║`);
      }
      lines.push("║");

      // ── Phases Detail ──
      if (fleetState.phases.length > 0) {
        lines.push("║  ── Phases ──                                           ║");
        for (const [i, phase] of fleetState.phases.entries()) {
          const done = phase.tasks.filter((t) => t.status === "complete").length;
          const total = phase.tasks.length;
          const icon = phase.status === "complete" ? "✓" :
            phase.status === "failed" ? "✗" :
            phase.status === "running" || phase.status === "reviewing" ? "▸" :
            phase.status === "pending" ? "○" : "?";
          const idx = i + 1;
          const current = idx === fleetState.currentPhaseIndex + 1 ? " ← current" : "";
          lines.push(`║    ${icon} P${idx}: ${phase.name.padEnd(32)}║`);
          lines.push(`║       ${done}/${total} tasks${current.padEnd(24)}║`);
        }
        lines.push("║");
      }

      // ── Active Agents ──
      const activeAgentList = fleetState.activeAgents.filter((a) => a.status !== "idle");
      if (activeAgentList.length > 0) {
        lines.push("║  ── Active Agents ──                                    ║");
        for (const agent of activeAgentList) {
          const icon = agent.status === "running" ? "▸" :
            agent.status === "reviewing" ? "◉" :
            agent.status === "error" ? "✗" : "○";
          const status = agent.status === "running" ? "RUNNING" :
            agent.status === "reviewing" ? "REV" :
            agent.status === "error" ? "ERROR" :
            "IDLE";
          const statusColor = agent.status === "running" ? "accent" :
            agent.status === "error" ? "error" : "dim";
          const model = (agent.model || "?").padEnd(16);
          const task = (agent.currentTask || "idle").padEnd(30);
          const inputT = formatTokens(agent.inputTokens || 0);
          const outputT = formatTokens(agent.outputTokens || 0);
          lines.push(`║    ${icon} ${agent.name.padEnd(14)} ${model} ${task}${statusColor === "accent" ? `  [${status}]  ${inputT}/${outputT}` : `  [${status}]`}`);
        }
        lines.push("║");
      }

      // ── Quick Actions ──
      lines.push("║  ── Quick Actions ──                                    ║");
      const zfsRunning = state.activePanes > 0 || state.activeProcesses > 0;
      lines.push(`║    /zellij-start    - ${zfsRunning ? "Fleet already running" : "Start ZFS fleet".padEnd(30)}║`);
      lines.push(`║    /zellij-stop     - ${zfsRunning ? "Stop ZFS fleet" : "No session to stop".padEnd(28)}║`);
      lines.push(`║    /zellij-panes    - List all panes                    ║`);
      lines.push(`║    /zellij-follow   - Follow agent output               ║`);
      lines.push(`║    /zellij-status   - This overview                     ║`);
      lines.push(`║    /follow <agent>  - Follow agent (general)            ║`);
      lines.push(`║    /caravel-fleet   - Toggle widget bar                  ║`);
      lines.push(`║    /caravel-go      - Auto-orchestrate all phases        ║`);
      lines.push(`║    /diagnose        - Diagnose errors                    ║`);
      if (fleetState.phases.length > 0) {
        lines.push(`║    fleet_status      - Fleet status query               ║`);
        lines.push(`║    fleet_control(action="pause")  - Pause fleet         ║`);
        lines.push(`║    fleet_control(action="resume") - Resume fleet        ║`);
      }
      lines.push("╚═══════════════════════════════════════════════════════════╝");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { state, fleetState, zfs },
      };
    },
  });

  // ---- /zfs_fleet_state: ZFS health check ----
  pi.registerCommand("zfs-fleet-state", {
    description: "Get the current fleet state: ZFS availability, pane counts, session info, platform.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const state = zfs.getFleetState();
      return {
        content: [{ type: "text", text:
`ZFS Fleet State:\n` +
`  Zellij: ${state.zellijAvailable ? "✓ available" : "✗ unavailable"}\n` +
`  Session: ${state.sessionName}\n` +
`  Paused: ${state.paused}\n` +
`  Active panes: ${state.activePanes}\n` +
`  Exited panes: ${state.exitedPanes}\n` +
`  Active processes: ${state.activeProcesses}\n` +
`  Platform: ${state.platform.platform} (${state.platform.shell})`}],
      };
    },
  });

  // ---- /zfs_pause: Pause all panes ----
  pi.registerCommand("zfs-pause", {
    description: "Pause all running panes (SIGSTOP / Windows equivalent).",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const result = await zfs.pauseAll();
      return {
        content: [{ type: "text", text: result ? "All panes paused." : "Failed to pause panes." }],
      };
    },
  });

  // ---- /zfs_resume: Resume all panes ----
  pi.registerCommand("zfs-resume", {
    description: "Resume all paused panes (SIGCONT).",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const result = await zfs.resumeAll();
      return {
        content: [{ type: "text", text: result ? "All panes resumed." : "Failed to resume panes." }],
      };
    },
  });

  // ---- /zfs_skip_agent: Skip a specific agent ----
  pi.registerCommand("zfs-skip-agent", {
    description: 'Skip (terminate) a specific agent\'s pane. Usage: /zfs-skip-agent developer',
    handler: async (args, ctx) => {
      const zfs = ensureZFS();
      const agentName = args?.trim() || "";
      if (!agentName) {
        return { content: [{ type: "text", text: "Usage: /zfs-skip-agent <agent_name>" }] };
      }
      const result = zfs.skipPane(agentName);
      return {
        content: [{ type: "text", text: result
          ? `Agent "${agentName}" skipped - pane terminated.`
          : `Agent "${agentName}" not found running.` }],
      };
    },
  });

  // ---- /zfs_list_panes: List all panes ----
  pi.registerCommand("zfs-list-panes", {
    description: "List all active and exited panes in the fleet session.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const panes = zfs.listPanes();
      const lines = panes.map((p) =>
        `  ${p.running ? "▸" : "✗"} ${p.name} (${p.paneId}) ${p.running ? "[running]" : `[exited:${p.exitCode ?? "?"}]`}`,
      );
      return {
        content: [{ type: "text", text: lines.length > 0 ? `Active panes:\n${lines.join("\n")}` : "No panes registered." }],
      };
    },
  });

  // ---- /zfs_status_bar_update: Force refresh status bar ----
  pi.registerCommand("zfs-status-bar-update", {
    description: "Force an immediate update of the floating pane status bar.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      if (!zfs.getFleetState().zellijAvailable) {
        return { content: [{ type: "text", text: "ZFS not available. Status bar cannot be updated." }] };
      }
      zfs.refreshStatusBar();
      return { content: [{ type: "text", text: "Status bar updated." }] };
    },
  });

  // ---- /zfs_status_bar_toggle: Toggle status bar ----
  pi.registerCommand("zfs-status-bar-toggle", {
    description: "Toggle the floating pane status bar on/off.",
    handler: async (_args, ctx) => {
      const zfs = ensureZFS();
      const info = zfs.getStatusBarInfo();
      if (!info.available) {
        return { content: [{ type: "text", text: "ZFS not available - status bar requires Zellij." }] };
      }
      if (info.active) {
        zfs.destroyStatusBar();
        return { content: [{ type: "text", text: "Status bar disabled." }] };
      } else {
        zfs.initStatusBar();
        zfs.refreshStatusBar();
        return { content: [{ type: "text", text: "Status bar enabled." }] };
      }
    },
  });

  // ---- /zfs-layout: Preview/generate fleet layout ----
  pi.registerCommand("zfs-layout", {
    description: "Preview or generate the fleet Zellij layout configuration. Pass --preview to see the KDL output, or pass agent names to generate.",
    handler: async (args, ctx) => {
      const zfs = ensureZFS();
      const allAgents = discoverAgents("both");
      const kdl = generateFleetLayout(allAgents.map(a => ({ name: a.name, description: a.description })));
      const kdlPath = path.join(ctx.cwd, "zellij-layout.kdl");
      fs.writeFileSync(kdlPath, kdl, "utf-8");
      return {
        content: [{ type: "text", text: `Fleet layout saved to: ${kdlPath}\n\n${kdl}` }],
      };
    },
  });

  // ============================================================================
  // /bg-* commands - Background process management
  // ============================================================================

  // ---- /bg-start: Start fleet in background mode ----

  pi.registerCommand("bg-start", {
    description: "Save current fleet state and launch it as a detached background process. The parent pi process can then exit while the fleet continues running. Use /bg-status to monitor progress. When pi is restarted, state is loaded from the saved checkpoint.",
    handler: async (_args, ctx) => {
      const bg = getBgManager();
      bg.setCwd(ctx.cwd);
      const result = await bg.startBackground(ctx);
      return {
        content: [{ type: "text", text: result.message }],
        details: { success: result.success, state: bg.getState() },
      };
    },
  });

  // ---- /bg-stop: Stop the background fleet ----

  pi.registerCommand("bg-stop", {
    description: "Stop the background fleet process. Fleet state is preserved in state.json for resumption. Use /bg-start to relaunch.",
    handler: async (_args, ctx) => {
      const bg = getBgManager();
      const result = await bg.stopBackground();
      return {
        content: [{ type: "text", text: result.message }],
        details: { success: result.success },
      };
    },
  });

  // ---- /bg-migrate: Migrate running fleet to ZFS ----

  pi.registerCommand("bg-migrate", {
    description: "Checkpoint the current fleet state, create a ZFS session with agent panes, and migrate monitoring to the ZFS floating status bar. Requires Zellij to be installed.",
    handler: async (_args, ctx) => {
      const bg = getBgManager();
      bg.setCwd(ctx.cwd);
      const result = await bg.migrateToZFS(ctx);
      return {
        content: [{ type: "text", text: result.message }],
        details: { success: result.success, state: bg.getState() },
      };
    },
  });

  // ---- /bg-export: Export ZFS fleet back to background mode ----

  pi.registerCommand("bg-export", {
    description: "Stop the ZFS fleet session and spawn a new background process to continue from the saved checkpoint. Use when you want to stop monitoring via ZFS but keep the fleet running.",
    handler: async (_args, ctx) => {
      const bg = getBgManager();
      bg.setCwd(ctx.cwd);
      const result = await bg.exportToBackground();
      return {
        content: [{ type: "text", text: result.message }],
        details: { success: result.success },
      };
    },
  });

  // ---- /bg-status: Show background fleet status ----

  pi.registerCommand("bg-status", {
    description: "Show comprehensive background fleet status: process state, ZFS session status, and fleet progress.",
    handler: async (_args, ctx) => {
      const bg = getBgManager();
      bg.setCwd(ctx.cwd);
      const state = bg.getState();
      const zfs = ensureZFS();
      const zfsState = zfs.getFleetState();
      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      const completedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
      const elapsed = state.startedAt > 0 ? formatDuration(Date.now() - state.startedAt) : "N/A";

      const lines: string[] = [
        "╔═══════════════════════════════════════════════════════════╗",
        "║  BACKGROUND FLEET STATUS                                  ║",
        "╠═══════════════════════════════════════════════════════════╣",
      ];
      lines.push(`║  ── Background Process ──                                ║`);
      lines.push(`║    Running: ${`${state.running ? "✓ yes" : "○ no"}`.padEnd(39)}║`);
      lines.push(`║    PID: ${String(state.pid ?? "none").padEnd(39)}║`);
      lines.push(`║    Started: ${new Date(state.startedAt).toISOString().padEnd(39)}║`);
      lines.push(`║    Active: ${elapsed.padEnd(39)}║`);
      lines.push(`║    State file: ${state.stateFile.padEnd(34)}║`);
      lines.push("║");
      lines.push(`║  ── ZFS Session ──                                       ║`);
      lines.push(`║    Available: ${`${zfsState.zellijAvailable ? "✓ yes" : "○ no"}`.padEnd(39)}║`);
      lines.push(`║    Session: ${zfsState.sessionName.padEnd(39)}║`);
      lines.push(`║    Panes: ${zfsState.activePanes} active / ${zfsState.exitedPanes} exited${"".padEnd(26)}║`);
      lines.push("║");
      lines.push(`║  ── Fleet Progress ──                                    ║`);
      if (fleetState.phases.length === 0) {
        lines.push(`║    Status: idle                                          ║`);
      } else {
        const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
        const phaseLabel = currentPhase
          ? `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${currentPhase.name}`
          : "No active phase";
        lines.push(`║    Phase: ${phaseLabel.padEnd(39)}║`);
        lines.push(`║    Progress: ${`${completedTasks}/${totalTasks} tasks`.padEnd(39)}║`);
        const progress = totalTasks > 0 ? `${Math.round((completedTasks / totalTasks) * 100)}%` : "0%";
        lines.push(`║    Completed: ${progress.padEnd(39)}║`);
      }
      lines.push("╚═══════════════════════════════════════════════════════════╝");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { bgState: state, zfsState, fleetProgress: { totalTasks, completedTasks, totalPhases: fleetState.phases.length, currentPhaseIndex: fleetState.currentPhaseIndex } },
      };
    },
  });
}
