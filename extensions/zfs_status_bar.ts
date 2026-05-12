/**
 * Caravel Fleet — ZFS Status Bar
 *
 * Persistent 10-line summary showing all agents' status (running/idle/error),
 * progress, and token usage. Rendered in a floating Zellij pane for monitoring
 * fleet activity without switching panes.
 *
 * Design:
 *   Line 1:  Header — fleet name + phase context + overall status
 *   Line 2:  Agent status grid — all agents in one compact row
 *   Line 3:  Phase info — progress bar + task count + elapsed time
 *   Line 4:  Per-agent detail rows (up to 3 visible at once)
 *   Line 5-7: More per-agent detail or idle state
 *   Line 8:  Token usage summary
 *   Line 9:  Review iteration + elapsed time
 *  Line 10: Footer
 *
 * Replaces/augments the widget bar when ZFS (Zellij mode) is active.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

/** Status icon for an agent. */
type AgentStatusIcon = "▸" | "●" | "◉" | "✗" | "○";

/** Rendered agent status entry. */
interface StatusAgentEntry {
  name: string;
  icon: AgentStatusIcon;
  color: string;       // color hint: success / accent / error / muted / dim
  task: string;
  tokens: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** Full status bar render input. */
interface StatusBarFleetSnapshot {
  /** Whether ZFS (Zellij) mode is active. */
  zfsActive: boolean;
  /** Whether a ZFS session exists. */
  zfsSessionActive: boolean;
  /** Fleet name. */
  fleetName: string;
  /** Current phase index (0-based). */
  currentPhaseIndex: number;
  /** Total phases. */
  totalPhases: number;
  /** Current phase name (empty if no phases). */
  currentPhaseName: string;
  /** Current phase status. */
  currentPhaseStatus: string;
  /** Completed task count. */
  completedTasks: number;
  /** Total task count. */
  totalTasks: number;
  /** Progress percentage (0-100). */
  progress: number;
  /** Elapsed time string. */
  elapsed: string;
  /** All active agents (running, idle, error). */
  agents: StatusAgentEntry[];
  /** All agents including historical. */
  allAgents: StatusAgentEntry[];
  /** Review iteration count. */
  reviewIterations: number;
  /** Total fleet token usage. */
  totalFleetTokens: number;
  /** Per-agent token totals (for detailed display). */
  totalAgentInputTokens: number;
  totalAgentOutputTokens: number;
  /** Main agent activity. */
  mainAgentActivity?: {
    status: string;
    action: string;
    detail: string;
    timestamp: number;
  } | null;
  /** Whether the fleet is paused. */
  paused: boolean;
  /** Last known agent action (for idle state). */
  lastAction?: string;
  /** Time ago string for last action. */
  lastActionAgo?: string;
  /** Platform info. */
  platform?: "windows" | "linux" | "macos" | "unix";
  /** Platform shell. */
  platformShell?: string;
}

// ============================================================================
// StatusBarRenderer — pure rendering logic
// ============================================================================

const BAR_WIDTH = 80;
const BAR_H = 10;

const BORDER_V = "║";
const BORDER_TL = "╔";
const BORDER_TR = "╗";
const BORDER_BL = "╚";
const BORDER_BR = "╝";
const BORDER_H = "═";
const BORDER_T = "┬";
const BORDER_B = "┴";
const BORDER_L = "├";
const BORDER_R = "┤";
const CROSS = "┼";
const DOT = "•";

/** Format tokens count for display. */
function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

/** Format a progress bar of given width. */
function progressBar(filled: number, total: number, width: number): string {
  const ratio = total > 0 ? filled / total : 0;
  const bars = Math.round(ratio * width);
  return "█".repeat(Math.max(0, bars)) + "░".repeat(Math.max(0, width - bars));
}

/** Center-pad a string within a given width. */
function centerPad(text: string, width: number): string {
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(Math.max(0, left)) + text;
}

/** Escape special characters for display. */
function escape(s: string): string {
  return s.replace(/[<>]/g, "");
}

/**
 * Build the per-agent status grid for line 2.
 * Shows all agents compactly in a single row.
 */
function buildAgentGrid(snap: StatusBarFleetSnapshot): string {
  if (snap.zfsActive) {
    const sessionIcon = snap.zfsSessionActive ? "✓" : "○";
    const sessionColor = snap.zfsSessionActive ? "success" : "dim";
    const sessionLabel = snap.zfsSessionActive ? "ZFS" : "ZFS";
    return centerPad(`${sessionIcon} ${sessionLabel}  │  ${snap.agents.length} agents  │  Fleet active`, BAR_WIDTH);
  }

  if (snap.agents.length === 0) {
    return centerPad("● 0 agents  │  Fleet idle", BAR_WIDTH);
  }

  // Build compact agent list
  const agents = snap.agents;
  const parts: string[] = [];

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const statusText = a.task
      ? `${a.icon} ${a.name.slice(0, 8).padEnd(8)}`
      : `${a.icon} ${a.name.slice(0, 8).padEnd(8)}`;
    parts.push(statusText);
  }

  // Trim to fit within available width
  const result = parts.join("  │  ");
  if (result.length > BAR_WIDTH - 4) {
    return result.slice(0, BAR_WIDTH - 4) + "…";
  }

  return "  " + result;
}

/**
 * Build the per-agent detail rows (lines 4-7).
 * Shows up to 3 agents in detail.
 */
function buildAgentDetails(snap: StatusBarFleetSnapshot): string {
  const active = snap.agents.filter(a => a.task !== "");
  if (active.length === 0) {
    if (snap.mainAgentActivity && snap.mainAgentActivity.action !== "idle") {
      const ma = snap.mainAgentActivity;
      const icon = ma.status === "executing" ? "▸" : "◇";
      return `  ${icon} ${ma.action} → ${escape(ma.detail).slice(0, 50)}`;
    }
    // Idle state — show last action
    if (snap.lastAction) {
      const ago = snap.lastActionAgo || "";
      return `  ● last: ${escape(snap.lastAction)}${ago ? ` (${ago})` : ""}`;
    }
    return "  ● idle — waiting for work";
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

/**
 * Build the phase info line (line 3).
 */
function buildPhaseInfo(snap: StatusBarFleetSnapshot): string {
  if (snap.paused) {
    return centerPad(`⏸ PAUSED  │  P${snap.currentPhaseIndex + 1}/${snap.totalPhases}`, BAR_WIDTH);
  }

  const phaseLabel = snap.currentPhaseName
    ? `P${snap.currentPhaseIndex + 1}/${snap.totalPhases}: ${snap.currentPhaseName}`
    : "No active phase";

  const pBar = snap.totalTasks > 0
    ? `[${progressBar(snap.completedTasks, snap.totalTasks, 15)} ${snap.progress}%]`
    : "[░░░░░░░░░░░░░░░ 0%]";

  const statusIcon = snap.currentPhaseStatus === "complete" ? "✓" :
    snap.currentPhaseStatus === "failed" ? "✗" :
    snap.currentPhaseStatus === "reviewing" ? "◉" :
    snap.currentPhaseStatus === "running" ? "▸" : "○";

  const statusColor = snap.currentPhaseStatus === "complete" ? "success" :
    snap.currentPhaseStatus === "failed" ? "error" : "accent";

  return `${phaseLabel}  ${pBar}  ${snap.completedTasks}/${snap.totalTasks} tasks  ${snap.elapsed}  ${statusIcon}`;
}

/**
 * Build the footer (line 10).
 */
function buildFooter(snap: StatusBarFleetSnapshot): string {
  const tokenStr = `▸ ${formatTokenCount(snap.totalAgentInputTokens)}i / ${formatTokenCount(snap.totalAgentOutputTokens)}o | fleet: ${formatTokenCount(snap.totalFleetTokens)} tokens`;
  const reviewStr = snap.reviewIterations > 0 ? `#${snap.reviewIterations}` : "";
  const reviewLabel = reviewStr ? `reviews${reviewStr}` : "0 reviews";

  const parts: string[] = [
    reviewLabel,
    `Elapsed: ${snap.elapsed}`,
    snap.zfsActive ? "ZFS" : "pi",
  ];

  if (snap.platform) {
    parts.push(snap.platform);
  }

  const content = parts.join("  │  ");
  return content;
}

/**
 * Main render function. Returns the full status bar as a string.
 */
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

  // Fill remaining lines with agent details or padding
  const usedLines = lines.length;
  for (let i = usedLines; i < BAR_H - 1; i++) {
    lines.push(`${BORDER_V}${" ".repeat(BAR_WIDTH)}${BORDER_V}`);
  }

  lines.push(`${BORDER_V}${footer}${BORDER_V}`);
  lines.push(`${BORDER_BL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_BR}`);

  return lines.join("\n");
}

/**
 * Render a compact 6-line status bar (for constrained environments).
 */
export function renderCompactStatusBar(snap: StatusBarFleetSnapshot): string {
  const agentsGrid = buildAgentGrid(snap);
  const phaseInfo = buildPhaseInfo(snap);
  const tokenLine = `▸ ${formatTokenCount(snap.totalAgentInputTokens)}i / ${formatTokenCount(snap.totalAgentOutputTokens)}o  │  fleet: ${formatTokenCount(snap.totalFleetTokens)} tokens  │  ${snap.reviewIterations} reviews`;
  const elapsedLine = `Elapsed: ${snap.elapsed}`;
  const modeLine = snap.zfsActive ? "[ZFS]" : "[pi]";

  const header = `${snap.fleetName}  ${modeLine}  │  P${snap.currentPhaseIndex + 1}/${snap.totalPhases}`;

  return [
    `${BORDER_TL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_TR}`,
    `${BORDER_V}${centerPad(header, BAR_WIDTH)}${BORDER_V}`,
    `${BORDER_V}${agentsGrid}${BORDER_V}`,
    `${BORDER_V}${phaseInfo}${BORDER_V}`,
    `${BORDER_V}${tokenLine}${BORDER_V}`,
    `${BORDER_V}${elapsedLine}${BORDER_V}`,
    `${BORDER_BL}${BORDER_H.repeat(BAR_WIDTH)}${BORDER_BR}`,
  ].join("\n");
}

// ============================================================================
// ZFSStatusBarManager — floating pane lifecycle
// ============================================================================

interface ZFSStatusBarManagerOptions {
  /** Floating pane name in the ZFS layout. */
  floatingPaneName: string;
  /** Session name for ZFS. */
  sessionName: string;
  /** Working directory. */
  cwd: string;
  /** Callback to get current fleet state for status bar rendering. */
  getFleetState: () => StatusBarFleetSnapshot | null;
  /** Callback to get ZFS platform info. */
  getPlatformInfo?: () => { shell: string; isWindows: boolean; platform: string };
}

export class ZFSStatusBarManager {
  private opts: ZFSStatusBarManagerOptions;
  private floatingPaneName: string;
  private sessionName: string;
  private cwd: string;
  private getFleetState: () => StatusBarFleetSnapshot | null;
  private getPlatformInfo: () => { shell: string; isWindows: boolean; platform: string };
  private lastRendered: string = "";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshIntervalMs: number = 2000; // Update every 2 seconds

  constructor(opts: ZFSStatusBarManagerOptions) {
    this.opts = opts;
    this.floatingPaneName = opts.floatingPaneName;
    this.sessionName = opts.sessionName;
    this.cwd = opts.cwd;
    this.getFleetState = opts.getFleetState;
    this.getPlatformInfo = opts.getPlatformInfo || (() => ({
      shell: "bash",
      isWindows: process.platform === "win32",
      platform: process.platform,
    }));
  }

  /**
   * Start the status bar — creates a temp script and updates the floating pane.
   */
  start(): void {
    this.stop();
    this.lastRendered = "";

    // Generate initial status bar and create floating pane script
    const scriptPath = this.generateScript();
    this.updateFloatingPane(scriptPath);

    // Start periodic refresh
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, this.refreshIntervalMs);
  }

  /**
   * Stop the status bar — kill the floating pane's process.
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Kill the floating pane
    this.killFloatingPane();
  }

  /**
   * Refresh the status bar content.
   */
  refresh(): void {
    const scriptPath = this.generateScript();
    this.updateFloatingPane(scriptPath);
  }

  /**
   * Get the current rendered status bar text.
   */
  getLastRendered(): string {
    return this.lastRendered;
  }

  /**
   * Get a fleet state snapshot for status bar rendering.
   */
  getFleetSnapshot(): StatusBarFleetSnapshot | null {
    try {
      return this.getFleetState();
    } catch {
      return null;
    }
  }

  // ── Internal helpers ──

  /** Generate a temp script that outputs the status bar. */
  private generateScript(): string {
    const snap = this.getFleetState();
    if (!snap) {
      this.lastRendered = "[status bar unavailable]";
      return this.lastRendered;
    }

    const rendered = renderCompactStatusBar(snap);
    this.lastRendered = rendered;

    // Write to temp file for the floating pane to execute
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `caravel-status-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpFile, rendered, "utf-8");
    } catch {
      // Non-fatal — temp file write failed
    }

    return rendered;
  }

  /** Update the floating pane to show the status bar. */
  private updateFloatingPane(scriptContent: string): void {
    // Try to send the status bar content to the floating pane via zellij action
    const { spawn } = require("node:child_process") as typeof import("node:child_process");

    // Use zellij's send-key to inject the status bar text
    // Alternative: close and reopen the floating pane with updated content
    const platform = this.getPlatformInfo();
    const isWindows = platform.isWindows;

    if (isWindows) {
      // On Windows, use zellij to send the content to the floating pane
      const cmd = `zellij action send-text -s ${this.sessionName} -n ${this.floatingPaneName} "${scriptContent.slice(0, 1000).replace(/"/g, '\\"')}"`;
      spawn(platform.shell === "cmd" ? "cmd" : "powershell", [
        platform.shell === "cmd" ? "/c" : "-NoProfile",
        cmd,
      ], { stdio: "ignore", shell: true });
    } else {
      const cmd = `zellij action send-text -s ${this.sessionName} -n ${this.floatingPaneName} "${scriptContent.slice(0, 1000).replace(/"/g, '\\"')}"`;
      spawn(platform.shell || "bash", ["-c", cmd], { stdio: "ignore", shell: true });
    }
  }

  /** Kill the floating pane's process. */
  private killFloatingPane(): void {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    try {
      spawn("zellij", ["action", "close-pane", "-s", this.sessionName], {
        stdio: "ignore",
        shell: true,
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Force an immediate update of the floating pane with the latest state.
   */
  update(): void {
    const snap = this.getFleetState();
    if (!snap) return;

    const rendered = renderCompactStatusBar(snap);
    this.lastRendered = rendered;

    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const platform = this.getPlatformInfo();
    const isWindows = platform.isWindows;

    if (isWindows) {
      const encoded = Buffer.from(rendered).toString("base64");
      const cmd = `echo ${encoded} | base64 -d`;
      spawn(platform.shell === "cmd" ? "cmd" : "powershell", [
        platform.shell === "cmd" ? "/c" : "-NoProfile",
        `zellij action send-text -s ${this.sessionName} -n ${this.floatingPaneName} -- "${cmd}"`,
      ], { stdio: "ignore", shell: true });
    } else {
      const encoded = Buffer.from(rendered).toString("base64");
      const cmd = `echo ${encoded} | base64 -d`;
      spawn(platform.shell || "bash", [
        "-c",
        `zellij action send-text -s ${this.sessionName} -n ${this.floatingPaneName} -- "${cmd}"`,
      ], { stdio: "ignore", shell: true });
    }
  }
}

// ============================================================================
// Helpers for building fleet snapshots
// ============================================================================

/**
 * Build a StatusBarFleetSnapshot from caravel.ts fleet state.
 * This function is exported so caravel.ts can call it to build snapshots.
 */
export function buildFleetSnapshot(opts: {
  phases: Array<{
    id: string;
    name: string;
    status: string;
    tasks: Array<{
      id: string;
      agentName: string;
      status: string;
      description?: string;
      tokensUsed?: number;
      inputTokens?: number;
      outputTokens?: number;
      messageCount?: number;
      codeReviewStatus?: string;
      designReviewStatus?: string;
    }>;
  }>;
  currentPhaseIndex: number;
  activeAgents: Array<{
    name: string;
    status: string;
    currentTask?: string;
    model?: string;
    tokensUsed?: number;
    inputTokens?: number;
    outputTokens?: number;
    turns?: number;
  }>;
  paused: boolean;
  startTime: number;
  reviewIterations: number;
  totalFleetTokens: number;
  mainAgentActivity?: { status: string; action: string; detail: string; timestamp: number } | null;
  zfsActive: boolean;
  zfsSessionActive: boolean;
  lastAction?: string;
  lastActionAgo?: string;
}): StatusBarFleetSnapshot {
  const now = Date.now();
  const elapsed = formatDuration(now - opts.startTime);

  const totalTasks = opts.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = opts.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete" || t.status === "needs_fix").length, 0);
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const currentPhase = opts.phases[opts.currentPhaseIndex];
  const currentPhaseName = currentPhase?.name || "";
  const currentPhaseStatus = currentPhase?.status || "pending";

  // Build agent entries
  const allAgentNames = new Set<string>();
  // From phases (agent names from tasks)
  for (const phase of opts.phases) {
    for (const task of phase.tasks) {
      allAgentNames.add(task.agentName);
    }
  }
  // From active agents
  for (const agent of opts.activeAgents) {
    allAgentNames.add(agent.name);
  }

  // Build agent status entries
  const activeAgentEntries: StatusAgentEntry[] = [];
  const allAgentEntries: StatusAgentEntry[] = [];

  // Add active agents
  for (const agent of opts.activeAgents) {
    const icon = agent.status === "running" ? "▸" :
      agent.status === "reviewing" ? "◉" :
      agent.status === "error" ? "✗" :
      agent.status === "idle" ? "●" : "○";
    const color = agent.status === "running" ? "accent" :
      agent.status === "error" ? "error" :
      agent.status === "reviewing" ? "accent" : "dim";

    const entry: StatusAgentEntry = {
      name: agent.name,
      icon: icon as AgentStatusIcon,
      color,
      task: agent.currentTask || "",
      tokens: agent.tokensUsed != null ? formatTokenCount(agent.tokensUsed) : "",
      model: agent.model || "",
      inputTokens: agent.inputTokens || 0,
      outputTokens: agent.outputTokens || 0,
      turns: agent.turns || 0,
    };

    activeAgentEntries.push(entry);
    allAgentEntries.push(entry);
  }

  // Add historical agents (from phases, not already in active)
  const knownNames = new Set(opts.activeAgents.map((a) => a.name));
  for (const name of allAgentNames) {
    if (!knownNames.has(name)) {
      // Historical agent — we don't have live status, mark as idle
      allAgentEntries.push({
        name,
        icon: "○",
        color: "muted",
        task: "",
        tokens: "",
        model: "",
        inputTokens: 0,
        outputTokens: 0,
        turns: 0,
      });
    }
  }

  // Token totals
  const totalInputTokens = opts.activeAgents.reduce((s, a) => s + (a.inputTokens || 0), 0);
  const totalOutputTokens = opts.activeAgents.reduce((s, a) => s + (a.outputTokens || 0), 0);

  return {
    zfsActive: opts.zfsActive,
    zfsSessionActive: opts.zfsSessionActive,
    fleetName: "CARAVEL FLEET",
    currentPhaseIndex: opts.currentPhaseIndex,
    totalPhases: opts.phases.length,
    currentPhaseName,
    currentPhaseStatus,
    completedTasks,
    totalTasks,
    progress,
    elapsed,
    agents: activeAgentEntries,
    allAgents: allAgentEntries,
    reviewIterations: opts.reviewIterations,
    totalFleetTokens: opts.totalFleetTokens,
    totalAgentInputTokens: totalInputTokens,
    totalAgentOutputTokens: totalOutputTokens,
    mainAgentActivity: opts.mainAgentActivity,
    paused: opts.paused,
    lastAction: opts.lastAction,
    lastActionAgo: opts.lastActionAgo,
  };
}

/** Format duration from milliseconds. */
function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}
