/**
 * Caravel Fleet Orchestrator
 *
 * Multi-agent fleet orchestration with supervisor-worker pattern, two-stage review loops,
 * and a non-blocking fleet dashboard. Works with any model provider (local or cloud).
 *
 * UI:
 *   - /fleet command: toggle fleet dashboard (non-blocking widget bar + overlay)
 *   - Fleet status widget: persistent bar above editor with rich content
 *   - Dashboard overlay: non-blocking detail view (bottom-right)
 *   - Keyboard shortcuts: ↑↓ navigate | Tab: panels | Space: pause | P: skip | Esc: close
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
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  truncateToWidth,
  matchesKey,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ============================================================================
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
  mainAgentActivity?: {
    status: "idle" | "executing" | "thinking" | "waiting";
    action: string; // "bash", "read", "edit", "writing", etc.
    detail: string; // truncated action description
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
  reviewFeedback?: string;
  reviewCount: number;
  maxReviewCount: number;
  // Two-stage review
  codeReviewStatus?: "pending" | "approved" | "needs_fix" | "failed";
  codeReviewFeedback?: string;
  designReviewStatus?: "pending" | "approved" | "needs_fix" | "failed";
  designReviewFeedback?: string;
}

interface FleetAgentInfo {
  name: string;
  status: "idle" | "running" | "reviewing" | "error";
  currentTask?: string;
  model?: string;
  tokensUsed?: number;
  turns?: number;
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
  mainAgentActivity: {
    status: "idle",
    action: "idle",
    detail: "No active work",
    timestamp: Date.now(),
  },
};

// Non-blocking dashboard state (replaces blocking overlay)
let dashboardOverlayVisible = false;
let dashboardOverlayHandle: { setHidden: (hidden: boolean) => void; requestRender: () => void } | null = null;
let dashboardOverlayTui: any = null;
let widgetRefreshTimer: ReturnType<typeof setTimeout> | null = null;



// Process tracking
const activeProcesses = new Map<string, { proc: ReturnType<typeof spawn>; signal: AbortSignal }>();

// Module-level reference to pi (needed by saveState/loadState)
let _pi: ExtensionAPI | null = null;

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

  // "both" - project overrides user by name
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
    const parent = path.dirname(currentDir);
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

// ============================================================================
// Helpers
// ============================================================================

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
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
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
// State persistence
// ============================================================================

function saveState(): void {
  if (_pi) {
    _pi.appendEntry("caravel-state", fleetState);
  }
}

function loadState(ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();
  const caravelEntries = entries
    .filter((e) => e.type === "custom" && (e as any).customType === "caravel-state")
    .reverse();

  if (caravelEntries.length > 0) {
    const data = (caravelEntries[0] as any).data;
    if (data) {
      fleetState = {
        phases: data.phases ?? [],
        currentPhaseIndex: data.currentPhaseIndex ?? 0,
        activeAgents: data.activeAgents ?? [],
        paused: data.paused ?? false,
        startTime: data.startTime ?? Date.now(),
        reviewIterations: data.reviewIterations ?? 0,
        maxReviewIterations: data.maxReviewIterations ?? fleetState.maxReviewIterations,
        recentOutput: data.recentOutput ?? "",
        mainAgentActivity: data.mainAgentActivity ?? fleetState.mainAgentActivity,
      };
    }
  }
}

function refreshWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  // Always update the widget bar (it's always visible)
  ctx.ui.setWidget("caravel-fleet", buildWidgetLines(ctx));

  // If overlay is visible, also refresh it
  // Auto-close overlay when phases are cleared to prevent input capture
  if (dashboardOverlayVisible) {
    if (fleetState.phases.length === 0) {
      hideDashboardOverlay();
      ctx.ui.notify("Fleet dashboard closed (no active phases)", "info");
    } else {
      dashboardOverlayHandle?.requestRender();
    }
  }
}

/**
 * Set the main agent activity status.
 * Call this from tool_call events to track what the main agent is doing.
 */
function setMainAgentActivity(
  ctx: ExtensionContext,
  status: "idle" | "executing" | "thinking",
  action: string,
  detail: string,
): void {
  fleetState.mainAgentActivity = {
    status,
    action,
    detail: truncateToWidth(detail, 40),
    timestamp: Date.now(),
  };
  refreshWidget(ctx);
}

function startWidgetRefresh(ctx: ExtensionContext): void {
  stopWidgetRefresh();
  const refresh = () => {
    if (!fleetState.paused) refreshWidget(ctx);
    widgetRefreshTimer = setTimeout(refresh, 3000);
  };
  refresh();
}

function stopWidgetRefresh(): void {
  if (widgetRefreshTimer) {
    clearTimeout(widgetRefreshTimer);
    widgetRefreshTimer = null;
  }
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
): Promise<{ output: string; stderr: string; exitCode: number; messages: Message[]; usage: any }> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

  let tmpPath: string | null = null;
  if (agent.systemPrompt?.trim()) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "caravel-"));
    tmpPath = path.join(tmpDir, `prompt-${agent.name.replace(/\s/g, "-")}.md`);
    await fs.promises.writeFile(tmpPath, agent.systemPrompt, "utf-8");
    args.push("--append-system-prompt", tmpPath);
  }

  args.push(task);

  const result: { output: string; stderr: string; exitCode: number; messages: Message[]; usage: any } = {
    output: "",
    stderr: "",
    exitCode: 0,
    messages: [],
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
      activeProcesses.set(procId, { proc, signal: signal ?? new AbortController() });
    }

    let buffer = "";
    let lastAgentOutput = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      result.exitCode = code ?? 0;
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
          }
        }
        lastAgentOutput = getFinalOutput([msg]);
      }
    }
  });
}

// ============================================================================
// Non-blocking dashboard: enhanced widget bar + optional overlay
// ============================================================================

/**
 * Build rich multi-line content for the widget bar.
 * Left-bordered, simple horizontal lines (no box-drawing corners or right border).
 */
function buildWidgetLines(ctx: ExtensionContext): string[] {
  const th = ctx.ui.theme;
  const now = Date.now();
  const elapsed = now - fleetState.startTime;
  const elapsedStr = formatDuration(elapsed);

  const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = fleetState.phases.reduce(
    (s, p) => s + p.tasks.filter((t) => t.status === "complete").length,
    0,
  );
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round((progress / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const allAgents = discoverAgents("both");
  const activeAgents = fleetState.activeAgents.filter((a) => a.status !== "idle");
  const hasActiveAgents = activeAgents.length > 0;

  const mainAgent = fleetState.mainAgentActivity;
  const isMainAgentActive = mainAgent?.status === "executing" || mainAgent?.status === "thinking";

  // Content width: use terminal width minus a small margin for the left border
  const termWidth = process.stdout.columns || 120;
  const W = Math.max(30, termWidth - 2); // leave 1 char on each side

  const lines: string[] = [];

  // Helper: pad a line to exactly W visible chars with box-drawing borders
  const makeBoxLine = (content: string): string => {
    const cw = visibleWidth(content);
    const pad = Math.max(0, W - 2 - cw); // subtract 2 for ║ borders
    return `║${content}${" ".repeat(pad)}║`;
  };

  // ─ Border top (box-drawing corners) ─
  lines.push(th.fg("borderMuted", `╔${"═".repeat(W - 2)}╗`));

  if (fleetState.phases.length === 0) {
    // ─ IDLE STATE ─
    const agentCount = allAgents.length;
    const statusColor = fleetState.paused ? "warning" : "muted";
    const statusIcon = fleetState.paused ? "⏸" : "●";

    // Title line
    const agentInfo = `${agentCount} agent` + (agentCount !== 1 ? "s" : "") + " configured";
    const titleContent = th.fg("dim", "CARAVEL FLEET") + "  " + th.fg("muted", agentInfo) + "  " + th.fg(statusColor, "STATUS " + statusIcon);
    lines.push(makeBoxLine(titleContent));

    // Agent activity: show BOTH running (if active) and last-executed for history
    if (mainAgent && mainAgent.action !== "idle") {
      if (isMainAgentActive && mainAgent) {
        const actColor = mainAgent.status === "thinking" ? "dim" : "accent";
        const actIcon = mainAgent.status === "thinking" ? "◇" : "▸";
        const maxDetail = Math.max(10, W - 20);
        const truncated = mainAgent.detail.length > maxDetail ? mainAgent.detail.slice(0, maxDetail - 1) + "…" : mainAgent.detail;
        lines.push(makeBoxLine(`${actIcon} ${th.fg(actColor, `running: ${mainAgent.action}: ${truncated}`)}`));
      }
      // Always show last-executed for history
      const timeAgo = now - mainAgent.timestamp;
      const timeStr = timeAgo < 60000 ? `${Math.round(timeAgo / 1000)}s ago`
        : timeAgo < 3600000 ? `${Math.round(timeAgo / 60000)}m ago`
        : `${Math.round(timeAgo / 3600000)}h ago`;
      const maxDetail = Math.max(10, W - 30);
      const truncated = mainAgent.detail.length > maxDetail ? mainAgent.detail.slice(0, maxDetail - 1) + "…" : mainAgent.detail;
      lines.push(makeBoxLine(th.fg("muted", `last: ${mainAgent.action} → ${truncated} (${timeStr})`)));
    }

    // Info line
    lines.push(makeBoxLine(th.fg("muted", `● ${fleetState.reviewIterations} reviews  │  ${elapsedStr}`)));

    // Border bottom (box-drawing corners)
    lines.push(th.fg("borderMuted", `╚${"═".repeat(W - 2)}╝`));
    return lines;
  }

  // ─ ACTIVE STATE ─
  const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
  const phaseInfo = currentPhase
    ? th.fg("accent", `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${currentPhase.name}`)
    : th.fg("muted", `Phase index out of range (${fleetState.currentPhaseIndex}/${fleetState.phases.length})`);

  // Title line: phase info left, status% right
  const statusIcon = currentPhase
    ? currentPhase.status === "complete" ? th.fg("success", "✓")
    : currentPhase.status === "failed" ? th.fg("error", "✗")
    : (currentPhase.status === "running" || currentPhase.status === "reviewing") ? th.fg("accent", "▸")
    : th.fg("muted", "○")
    : th.fg("muted", "○");
  const statusRight = statusIcon + th.fg("muted", ` ${progress}%`);
  lines.push(makeBoxLine(phaseInfo + "  " + statusRight));

  // Progress bar line
  lines.push(makeBoxLine(th.fg("accent", `[${bar}] ${progress}%`)));

  // Agent activity: show BOTH running (if active) and last-executed for history
  if (mainAgent && mainAgent.action !== "idle") {
    if (isMainAgentActive && mainAgent) {
      const actColor = mainAgent.status === "thinking" ? "dim" : "accent";
      const actIcon = mainAgent.status === "thinking" ? "◇" : "▸";
      const maxDetail = Math.max(10, W - 20);
      const truncated = mainAgent.detail.length > maxDetail ? mainAgent.detail.slice(0, maxDetail - 1) + "…" : mainAgent.detail;
      lines.push(makeBoxLine(`${actIcon} ${th.fg(actColor, `running: ${mainAgent.action}: ${truncated}`)}`));
    }
    // Always show last-executed for history
    const timeAgo = now - mainAgent.timestamp;
    const timeStr = timeAgo < 60000 ? `${Math.round(timeAgo / 1000)}s ago`
      : timeAgo < 3600000 ? `${Math.round(timeAgo / 60000)}m ago`
      : `${Math.round(timeAgo / 3600000)}h ago`;
    const maxDetail = Math.max(10, W - 30);
    const truncated = mainAgent.detail.length > maxDetail ? mainAgent.detail.slice(0, maxDetail - 1) + "…" : mainAgent.detail;
    lines.push(makeBoxLine(th.fg("muted", `last: ${mainAgent.action} → ${truncated} (${timeStr})`)));
  }

  // Fleet agent lines
  if (hasActiveAgents) {
    const agentLines = activeAgents.map((a) => {
      const status = a.status === "running" ? "running" : a.status === "reviewing" ? "reviewing" : "error";
      const color = status === "running" ? "accent" : status === "reviewing" ? "warning" : "error";
      const icon = status === "running" ? "▸" : status === "reviewing" ? "↻" : "✗";
      const task = a.currentTask ? ` ${truncate(a.currentTask, 20)}` : "";
      return th.fg(color, `${icon} ${a.name}${task}`);
    });
    lines.push(makeBoxLine(`  ${agentLines.join(`  │  `)}`));
  } else {
    lines.push(makeBoxLine(th.fg("dim", `${completedTasks}/${totalTasks} tasks`)));
  }

  // Summary line
  const summaryParts: string[] = [
    `${completedTasks}/${totalTasks} tasks`,
    `${fleetState.reviewIterations} reviews`,
    elapsedStr,
  ];
  if (fleetState.paused) summaryParts.push(th.fg("warning", "PAUSED"));
  lines.push(makeBoxLine(th.fg("dim", summaryParts.join("  │  "))));

  // Border bottom (box-drawing corners)
  lines.push(th.fg("borderMuted", `╚${"═".repeat(W - 2)}╝`));

  return lines;
}


/**
 * Show the non-capturing overlay dashboard (rich detail view).
 * Positioned bottom-right, doesn't block typing.
 * Auto-closes immediately when there's no content to display.
 */
function showDashboardOverlay(ctx: ExtensionContext): void {
  // Auto-close if no phases to show - prevents input capture when idle
  if (fleetState.phases.length === 0) {
    ctx.ui.notify("CARAVEL FLEET: no active phases (fleet is IDLE)", "info");
    return;
  }
  if (dashboardOverlayVisible) return;
  dashboardOverlayVisible = true;

  ctx.ui.custom<void>((tui, theme, _kb, done) => {
    dashboardOverlayTui = tui;
    return new DashboardOverlayComponent(tui, theme, () => {
      dashboardOverlayVisible = false;
      dashboardOverlayTui = null;
      dashboardOverlayHandle = null;
      done();
    });
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "bottom-right",
      width: 60,
      maxHeight: "60%",
      margin: { bottom: 2, right: 2 },
    },
    onHandle: (handle) => {
      // Store the real handle for visibility toggle
      dashboardOverlayHandle = {
        setHidden: (hidden: boolean) => {
          if (hidden) {
            dashboardOverlayVisible = false;
            handle.hide();
          } else {
            dashboardOverlayVisible = true;
            handle.setHidden(false);
          }
        },
        requestRender: () => dashboardOverlayTui?.requestRender(),
      };
      handle.setHidden(false); // Make visible
    },
  });
}

/**
 * Hide the dashboard overlay.
 */
function hideDashboardOverlay(): void {
  if (!dashboardOverlayVisible || !dashboardOverlayHandle) return;
  dashboardOverlayVisible = false;
  dashboardOverlayHandle.setHidden(true);
  dashboardOverlayHandle = null;
}

/**
 * Toggle dashboard: show or hide both widget bar and overlay.
 */
function toggleDashboard(ctx: ExtensionContext): void {
  if (dashboardOverlayVisible) {
    hideDashboardOverlay();
    ctx.ui.notify("CARAVEL: overlay closed", "info");
  } else {
    // Widget bar is always visible via refreshWidget; just show the overlay
    if (fleetState.phases.length === 0) {
      ctx.ui.notify("CARAVEL FLEET: idle — no phases to display", "info");
    } else {
      ctx.ui.notify("CARAVEL: overlay opened", "info");
    }
    showDashboardOverlay(ctx);
  }
}

// ============================================================================
// Dashboard overlay component (non-capturing, persistent)
// ============================================================================

interface DashboardOverlayTab {
  label: string;
  render: (th: any, w: number) => string[];
}

class DashboardOverlayComponent {
  private selectedTab = 0;
  private selectedPhase = 0;
  private selectedAgent = 0;
  private terminalScroll = 0;
  private disposeFn?: () => void;

  constructor(
    private tui: any,
    private theme: any,
    private onClose: () => void,
  ) {}

  handleInput(data: string): void {
    // Escape always closes the overlay
    if (matchesKey(data, "escape")) {
      hideDashboardOverlay();
      this.onClose();
      return;
    }

    // When no phases exist, only Escape is handled - all other input
    // falls through silently so it can be captured by the main editor
    if (fleetState.phases.length === 0) {
      return;
    }

    // Tab navigation
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const tabs = ["TASKS", "AGENTS", "REVIEW", "TERMINAL"];
      this.selectedTab = matchesKey(data, "tab")
        ? (this.selectedTab + 1) % tabs.length
        : (this.selectedTab - 1 + tabs.length) % tabs.length;
      this.tui.requestRender();
      return;
    }

    // Up/down navigation
    if (matchesKey(data, "up")) {
      if (this.selectedTab === 0 && fleetState.phases.length > 0) {
        this.selectedPhase = Math.max(0, this.selectedPhase - 1);
      } else if (this.selectedTab === 1) {
        this.selectedAgent = Math.max(0, this.selectedAgent - 1);
      } else if (this.selectedTab === 3) {
        this.terminalScroll = Math.max(0, this.terminalScroll - 1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.selectedTab === 0 && fleetState.phases.length > 0) {
        this.selectedPhase = Math.min(fleetState.phases.length - 1, this.selectedPhase + 1);
      } else if (this.selectedTab === 1) {
        this.selectedAgent = Math.min(
          Math.max(0, fleetState.activeAgents.length - 1),
          this.selectedAgent + 1,
        );
      } else if (this.selectedTab === 3) {
        const outputLines = fleetState.recentOutput.split("\n");
        const maxScroll = Math.max(0, outputLines.length - 12);
        this.terminalScroll = Math.min(maxScroll, this.terminalScroll + 1);
      }
      this.tui.requestRender();
      return;
    }

    // Space: pause/resume
    if (matchesKey(data, "space")) {
      fleetState.paused = !fleetState.paused;
      saveState();
      this.tui.requestRender();
      return;
    }

    // P: skip current phase
    if (matchesKey(data, "p")) {
      if (this.selectedPhase >= 0 && this.selectedPhase < fleetState.phases.length) {
        fleetState.phases[this.selectedPhase].status = "complete";
        fleetState.phases[this.selectedPhase].completedAt = Date.now();
        fleetState.currentPhaseIndex = Math.min(
          this.selectedPhase + 1,
          fleetState.phases.length - 1,
        );
        saveState();
        this.tui.requestRender();
      }
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    // FIXED width: all panels render at exactly 60 cols, regardless of terminal width
    const W = 60;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);
    const borderAccent = (text: string) => th.fg("borderAccent", text);
    const hline = " ".repeat(W - 2);
    const lines: string[] = [];

    // ── Cyberpunk box frame ──
    lines.push(borderAccent(`╔${"═".repeat(W - 2)}╗`));

    // ── Header row ──
    const title = th.fg("accent", "CARAVEL FLEET");
    const statusStr = this.getFleetStatus(th);
    const headerText = `  ${title}  ${"│".padEnd(2)}  ${statusStr}`;
    lines.push(borderAccent(`║ ${pad(headerText, W - 2)} ║`));

    // ── Accent bar ──
    lines.push(borderAccent(`║${"─".repeat(W - 2)}║`));

    // ── Tabs ──
    const tabs = ["TASKS", "AGENTS", "REVIEW", "TERMINAL"];
    const tabLine = tabs.map((t, i) => {
      const label = i === this.selectedTab ? th.fg("accent", `[${t}]`) : ` [${t}]`;
      return i > 0 ? " │ " + label : label;
    }).join("");
    lines.push(borderAccent(`║ ${pad(tabLine, W - 2)} ║`));

    // ── Panel divider ──
    lines.push(borderAccent(`║${"─".repeat(W - 2)}║`));

    // ── Panel content ──
    const panelContent = this.renderPanel(th);
    lines.push(...panelContent);

    // ── Footer divider ──
    lines.push(borderAccent(`║${"─".repeat(W - 2)}║`));

    // ── Footer ──
    const fleetStatus = fleetState.phases.length === 0 ? "IDLE"
      : fleetState.paused ? "PAUSED" : "RUNNING";
    const statusColor = fleetStatus === "RUNNING" ? "accent" : fleetStatus === "PAUSED" ? "warning" : "muted";
    const footerLeft = th.fg(statusColor, `[${fleetStatus}]`);
    const footerRight = `▶↑↓nav │Tab:pan │Sp:pause │P:skip │Esc:close`;
    lines.push(borderAccent(`║ ${footerLeft} │ ${pad(footerRight, W - 15)} ║`));
    lines.push(borderAccent(`╚${"═".repeat(W - 2)}╝`));

    return lines;
  }

  private getFleetStatus(th: any): string {
    if (fleetState.phases.length === 0) return th.fg("muted", "● IDLE");
    if (fleetState.paused) return th.fg("warning", "⏸ PAUSED");
    const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
    if (!currentPhase) return th.fg("muted", "○ UNKNOWN");
    if (currentPhase.status === "complete") return th.fg("success", "✓ DONE");
    if (currentPhase.status === "failed") return th.fg("error", "✗ FAILED");
    if (currentPhase.status === "running") return th.fg("accent", "▸ RUNNING");
    if (currentPhase.status === "reviewing") return th.fg("warning", "↻ REV");
    return th.fg("muted", "○ PENDING");
  }

  private renderPanel(th: any): string[] {
    // Fixed width for all panels: W = 60 (from render()), so content width = 58
    const W = 60;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);
    const borderAccent = (text: string) => th.fg("borderAccent", text);
    const contentW = W - 4; // subtract "║ " and " ║"

    switch (this.selectedTab) {
      case 0: return this.renderTasksPanel(th, contentW, border, borderAccent, pad);
      case 1: return this.renderAgentsPanel(th, contentW, border, borderAccent, pad);
      case 2: return this.renderReviewPanel(th, contentW, border, borderAccent, pad);
      case 3: return this.renderTerminalPanel(th, contentW, border, borderAccent, pad);
      default: return [border(` ║ ${pad("Unknown panel", contentW)} ║`)];
    }
  }

  private renderTasksPanel(th: any, contentW: number, border: any, borderAccent: any, pad: any): string[] {
    const lines: string[] = [];

    if (fleetState.phases.length === 0) {
      const agentCount = discoverAgents("both").length;
      lines.push(borderAccent(`║ ${pad("▶ FLEET IS IDLE", contentW)} ║`));
      lines.push(border(`║ ${pad(`Agents configured: ${agentCount}  │  Reviews completed: ${fleetState.reviewIterations}`, contentW)} ║`));
      if (fleetState.mainAgentActivity && fleetState.mainAgentActivity.action !== "idle") {
        const act = fleetState.mainAgentActivity;
        lines.push(border(`║ ${pad(`Main agent: ${act.action} → ${act.detail}`, contentW)} ║`));
      }
      lines.push(border(`║ ${pad("Use plan_project to define phases and tasks.", contentW)} ║`));
      return lines;
    }

    // Summary header
    const totalTasks = fleetState.phases.reduce((s: number, p: any) => s + p.tasks.length, 0);
    const completedTasks = fleetState.phases.reduce((s: number, p: any) => s + p.tasks.filter((t: any) => t.status === "complete").length, 0);
    lines.push(border(`║ ${pad(`▲ ${completedTasks}/${totalTasks} TASKS COMPLETED ▲`, contentW)} ║`));

    for (let i = 0; i < fleetState.phases.length; i++) {
      const phase = fleetState.phases[i]!;
      const isCurrent = i === this.selectedPhase;
      const isSelected = i === fleetState.currentPhaseIndex;

      const statusIcon = this.phaseStatusIcon(phase.status);
      const statusColor = phase.status === "complete" ? "success" : phase.status === "failed" ? "error" : phase.status === "running" ? "accent" : "muted";
      const name = isCurrent ? th.fg("accent", phase.name) : phase.name;
      const marker = isSelected ? "▸" : isCurrent ? "·" : "  ";

      const completed = phase.tasks.filter((t: any) => t.status === "complete").length;
      const total = phase.tasks.length;

      const phaseLine = `${marker} ${statusIcon} P${i + 1}: ${name}  [${completed}/${total}]`;
      lines.push(border(`║ ${pad(phaseLine, contentW)} ║`));

      if (isCurrent || isSelected) {
        for (let j = 0; j < phase.tasks.length; j++) {
          const task = phase.tasks[j]!;
          const taskSelected = j === this.selectedPhase && isCurrent;
          const taskMarker = taskSelected ? "▸ " : "  ";
          const taskStatus = this.taskStatusIcon(task.status);
          const taskAgent = th.fg("muted", task.agentName);

          // Review indicators
          const codeIcon = task.codeReviewStatus === "approved" ? th.fg("success", "+")
            : task.codeReviewStatus === "needs_fix" ? th.fg("error", "!")
            : th.fg("dim", "-");
          const desIcon = task.designReviewStatus === "approved" ? th.fg("success", "+")
            : task.designReviewStatus === "needs_fix" ? th.fg("error", "!")
            : th.fg("dim", "-");

          const taskName = truncate(task.description, 30);
          const taskLine = `${taskMarker}${taskStatus} [${taskAgent}] ${taskName} (${codeIcon}${desIcon})`;
          lines.push(border(`║ ${pad(taskLine, contentW)} ║`));
        }
      }
    }

    return lines;
  }

  private renderAgentsPanel(th: any, contentW: number, border: any, borderAccent: any, pad: any): string[] {
    const lines: string[] = [];
    const agents = discoverAgents("both");
    const active = fleetState.activeAgents;

    if (agents.length === 0) {
      lines.push(border(`║ ${pad("No agents configured.", contentW)} ║`));
      return lines;
    }

    // Agent list
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      const isActive = active.find((a) => a.name === agent.name);
      const isFocused = i === this.selectedAgent;
      const status = isActive ? isActive.status : "idle";

      const statusStr = status === "running" ? "RUN" : status === "reviewing" ? "REV" : status === "error" ? "ERR" : "IDLE";
      const statusColor = status === "running" ? "accent" : status === "reviewing" ? "warning" : status === "error" ? "error" : "muted";
      const marker = isFocused ? "▸" : "  ";
      const name = isFocused ? th.fg("accent", agent.name) : agent.name;
      const modelStr = truncate(agent.model.split("/").pop() || agent.model, 22);
      const taskStr = isActive?.currentTask ? ` | ${truncate(isActive.currentTask, 25)}` : "";

      lines.push(border(`║ ${pad(`${marker}${name} [${th.fg(statusColor, statusStr)}]`, contentW)} ║`));
      lines.push(border(`║ ${pad(`  ${modelStr}${taskStr}`, contentW)} ║`));
    }

    // Active agents section
    if (active.length > 0) {
      lines.push(border(`║${"─".repeat(contentW)}║`));
      lines.push(borderAccent(`║ ${pad("▶ ACTIVE AGENTS", contentW)} ║`));
      for (const agent of active) {
        if (agent.status !== "idle") {
          const taskStr = truncate(agent.currentTask || "N/A", 36);
          lines.push(border(`║ ${pad(`  ${agent.name}: ${taskStr}`, contentW)} ║`));
        }
      }
    }

    return lines;
  }

  private renderReviewPanel(th: any, contentW: number, border: any, borderAccent: any, pad: any): string[] {
    const lines: string[] = [];

    lines.push(border(`║ ${pad("TWO-STAGE REVIEW GATE", contentW)} ║`));
    lines.push(border(`║ ${pad(`Iterations: ${fleetState.reviewIterations} / ${fleetState.maxReviewIterations}`, contentW)} ║`));
    lines.push(border(`║${"─".repeat(contentW)}║`));
    lines.push(border(`║ ${pad("STAGE 1: Code Review (Tech Lead)", contentW)} ║`));
    lines.push(border(`║ ${pad("  Correctness, security, perf, architecture", contentW)} ║`));
    lines.push(border(`║ ${pad("  Code quality, testing", contentW)} ║`));
    lines.push(border(`║`));
    lines.push(border(`║ ${pad("STAGE 2: Design Review (Designer)", contentW)} ║`));
    lines.push(border(`║ ${pad("  Layout, consistency, accessibility", contentW)} ║`));
    lines.push(border(`║ ${pad("  UX, polish, visual quality", contentW)} ║`));

    // Review summary
    let codeApproved = 0, codeNeedsFix = 0, designApproved = 0, designNeedsFix = 0;
    for (const phase of fleetState.phases) {
      for (const task of phase.tasks) {
        if (task.codeReviewStatus === "approved") codeApproved++;
        if (task.codeReviewStatus === "needs_fix") codeNeedsFix++;
        if (task.designReviewStatus === "approved") designApproved++;
        if (task.designReviewStatus === "needs_fix") designNeedsFix++;
      }
    }

    if (codeApproved + codeNeedsFix + designApproved + designNeedsFix > 0) {
      lines.push(border(`║${"─".repeat(contentW)}║`));
      lines.push(borderAccent(`║ ${pad("▲ REVIEW SUMMARY ▲", contentW)} ║`));
      lines.push(border(`║ ${pad(`  Code: ${th.fg("success", codeApproved)} ok  │  ${th.fg("error", codeNeedsFix)} fix`, contentW)} ║`));
      lines.push(border(`║ ${pad(`  Design: ${th.fg("success", designApproved)} ok  │  ${th.fg("error", designNeedsFix)} fix`, contentW)} ║`));
    }

    // Progress bar
    if (fleetState.reviewIterations < fleetState.maxReviewIterations) {
      const pct = Math.round((fleetState.reviewIterations / fleetState.maxReviewIterations) * 100);
      const barW = 18;
      const filled = Math.round((pct / 100) * barW);
      const bar = "█".repeat(filled) + "░".repeat(barW - filled);
      lines.push(border(`║ ${pad(`[${bar}] ${pct}%`, contentW)} ║`));
    }

    lines.push(border(`║${"─".repeat(contentW)}║`));
    lines.push(border(`║ ${pad("RECENT FEEDBACK:", contentW)} ║`));

    let foundFeedback = false;
    for (let i = fleetState.phases.length - 1; i >= 0; i--) {
      for (const task of fleetState.phases[i]!.tasks) {
        if (task.reviewFeedback) {
          const feedback = truncate(task.reviewFeedback, contentW - 4);
          lines.push(border(`║ ${pad(`  [${fleetState.phases[i]!.name}] ${feedback}`, contentW)} ║`));
          foundFeedback = true;
          if (foundFeedback) break;
        }
      }
      if (foundFeedback) break;
    }
    if (!foundFeedback) lines.push(border(`║ ${pad("  (none yet)", contentW)} ║`));

    return lines;
  }

  private renderTerminalPanel(th: any, contentW: number, border: any, borderAccent: any, pad: any): string[] {
    const lines: string[] = [];

    lines.push(borderAccent(`║ ${pad("▶ AGENT OUTPUT LOG", contentW)} ║`));
    lines.push(border(`║${"─".repeat(contentW)}║`));

    const output = fleetState.recentOutput;
    if (!output) {
      lines.push(border(`║ ${pad("(No output yet.)", contentW)} ║`));
      return lines;
    }

    const outputLines = output.split("\n");
    const maxLines = 14;
    const start = Math.min(this.terminalScroll, Math.max(0, outputLines.length - maxLines));
    const show = outputLines.slice(start, start + maxLines);

    for (const line of show) {
      lines.push(border(`║ ${pad(truncate(line, contentW - 2), contentW - 2)} ║`));
    }

    if (outputLines.length > maxLines) {
      const remaining = outputLines.length - maxLines;
      lines.push(border(`║ ${pad(`... ${remaining} more lines`, contentW)} ║`));
    }

    return lines;
  }

  private phaseStatusIcon(status: string): string {
    switch (status) {
      case "pending": return "[ ]";
      case "running": return "▸";
      case "reviewing": return "[?]";
      case "complete": return "✓";
      case "failed": return "[!]";
      default: return "[ ]";
    }
  }

  private taskStatusIcon(status: string): string {
    switch (status) {
      case "pending": return "-";
      case "running": return "=>";
      case "reviewing": return "?";
      case "complete": return "+";
      case "needs_fix": return "!";
      case "failed": return "X";
      default: return "-";
    }
  }

  invalidate(): void {}
  dispose(): void {
    dashboardOverlayVisible = false;
    dashboardOverlayHandle = null;
  }
}

// ============================================================================
// Auto-orchestration helpers
// ============================================================================

/**
 * Internal helper to run a single phase (used by /go command).
 */
async function runPhaseInternal(
  phaseIdx: number,
  ctx: ExtensionContext,
): Promise<string> {
  if (phaseIdx < 0 || phaseIdx >= fleetState.phases.length) {
    return `Invalid phase index: ${phaseIdx}`;
  }

  const phase = fleetState.phases[phaseIdx]!;
  phase.status = "running";
  fleetState.currentPhaseIndex = phaseIdx;
  saveState();
  refreshWidget(ctx);

  const results: Array<{ agentName: string; exitCode: number; output: string; stderr: string }> = [];
  const allAgents = discoverAgents("both");

  for (const task of phase.tasks) {
    if (task.status === "complete") continue; // skip already done tasks

    const agentDef = allAgents.find((a) => a.name === task.agentName);
    if (!agentDef) {
      task.status = "failed";
      results.push({ agentName: task.agentName, exitCode: 1, output: "", stderr: `Agent "${task.agentName}" not found` });
      continue;
    }

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

    const result = await runSubagent(agentDef, task.description, ctx.cwd);
    task.output = result.output;
    task.status = result.exitCode === 0 ? "complete" as const : "failed" as const;
    fleetState.recentOutput = result.output || result.stderr;

    fleetState.activeAgents = fleetState.activeAgents.map((a) =>
      a.name === agentDef.name
        ? {
            ...a,
            status: result.exitCode === 0 ? "idle" as const : "error" as const,
            currentTask: undefined,
            model: agentDef.model,
            tokensUsed: result.usage?.input + result.usage?.output,
            turns: result.usage?.turns,
          }
        : a
    );

    results.push({ agentName: task.agentName, exitCode: result.exitCode, output: result.output, stderr: result.stderr });
  }

  const allDone = phase.tasks.every((t) => t.status === "complete");
  phase.status = allDone ? "complete" : (phase.tasks.some((t) => t.status === "failed") ? "failed" : "reviewing");
  phase.completedAt = Date.now();

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

/**
 * Internal helper to run review on a phase (used by /go command).
 */
async function runReviewInternal(
  phaseIdx: number,
  ctx: ExtensionContext,
): Promise<string> {
  const phase = fleetState.phases[phaseIdx];
  if (!phase) return "No phase to review";

  const incompleteTasks = phase.tasks.filter((t) => t.status !== "complete");
  if (incompleteTasks.length === 0) {
    return "All tasks complete. No review needed.";
  }

  // Find tasks ready for review
  const tasksToReview = incompleteTasks.filter((t) => t.status === "complete" || t.status === "needs_fix");
  if (tasksToReview.length === 0) {
    return "No tasks ready for review yet.";
  }

  fleetState.reviewIterations++;
  saveState();
  refreshWidget(ctx);

  // Code review
  const codeResult = await runCodeReview(phaseIdx, undefined, ctx);
  const designResult = await runDesignReview(phaseIdx, undefined, ctx);

  let allApproved = true;

  for (const task of tasksToReview) {
    task.reviewFeedback = "";

    // Evaluate code review
    if (codeResult.approved) {
      task.codeReviewStatus = "approved";
    } else {
      task.codeReviewStatus = "needs_fix";
      task.codeReviewFeedback = codeResult.feedback;
      task.reviewFeedback += `[CODE REVIEW - ${codeResult.agentUsed}]:\n${codeResult.feedback}\n\n`;
      allApproved = false;
    }

    // Evaluate design review
    if (designResult.approved) {
      task.designReviewStatus = "approved";
    } else {
      task.designReviewStatus = "needs_fix";
      task.designReviewFeedback = designResult.feedback;
      task.reviewFeedback += `[DESIGN REVIEW - ${designResult.agentUsed}]:\n${designResult.feedback}\n\n`;
      allApproved = false;
    }

    // Auto-fix if under max iterations
    if (!allApproved && task.reviewCount < task.maxReviewCount) {
      task.status = "needs_fix";

      if (codeResult.approved === false && task.codeReviewFeedback) {
        await runDeveloperFix(task, task.codeReviewFeedback, "code", undefined, ctx);
      }
      if (designResult.approved === false && task.designReviewFeedback) {
        await runDeveloperFix(task, task.designReviewFeedback, "design", undefined, ctx);
      }

      // Re-evaluate after fix
      if (codeResult.approved === false) {
        const recheckCode = await runCodeReview(phaseIdx, undefined, ctx);
        if (recheckCode.approved) {
          task.codeReviewStatus = "approved";
        } else {
          task.codeReviewFeedback = recheckCode.feedback;
        }
      }
      if (designResult.approved === false) {
        const recheckDesign = await runDesignReview(phaseIdx, undefined, ctx);
        if (recheckDesign.approved) {
          task.designReviewStatus = "approved";
        } else {
          task.designReviewFeedback = recheckDesign.feedback;
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
 * Internal helper to analyze an existing codebase.
 */
async function runAnalysisPhase(ctx: ExtensionContext): Promise<FleetTask[]> {
  const allAgents = discoverAgents("both");
  const analyzer = allAgents.find((a) => a.name === "auditor") ?? allAgents.find((a) => a.name === "developer");
  if (!analyzer) {
    return [{
      id: generateId(),
      agentName: "none",
      description: "No analyzer agent available",
      status: "failed" as const,
      reviewCount: 0,
      maxReviewCount: 3,
    }];
  }

  // Run analysis subagent
  const analysisPrompt = `
You are analyzing an existing codebase. Perform the following analysis:

1. **Project Structure**: List all top-level directories and key files
2. **Tech Stack**: Identify the programming languages, frameworks, build tools, and dependencies
3. **Architecture**: Describe the overall architecture (MVC, microservices, monorepo, etc.)
4. **Entry Points**: Identify main entry files (index.ts, main.ts, App.tsx, etc.)
5. **Dependencies**: List key dependencies from package.json, requirements.txt, Cargo.toml, etc.
6. **Test Coverage**: Identify test files and test framework used
7. **Configuration**: Note key config files (tsconfig.json, webpack.config.js, docker-compose.yml, etc.)

Provide a structured analysis report in the following format:

# Codebase Analysis Report

## Project Overview
[language, framework, purpose]

## Directory Structure
[brief overview of main directories]

## Tech Stack
- Languages: [...]
- Frameworks: [...]
- Build Tools: [...]
- Dependencies: [...]

## Architecture
[description of architectural pattern]

## Entry Points
[file paths]

## Test Coverage
[test framework, key test files, coverage status]

## Configuration
[key config files]

## Recommendations
[suggestions for next steps based on the codebase state]
`;

  const result = await runSubagent(analyzer, analysisPrompt, ctx.cwd);

  return [{
    id: generateId(),
    agentName: analyzer.name,
    description: "Codebase Analysis - scan structure, detect tech stack, map dependencies",
    status: result.exitCode === 0 ? "complete" as const : "failed" as const,
    output: result.output,
    reviewFeedback: result.stderr,
    reviewCount: 0,
    maxReviewCount: 3,
  }];
}

// ============================================================================
// Main extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  _pi = pi;
  // ---- Events ----

  pi.on("session_start", async (_event, ctx) => {
    loadState(ctx);
    refreshWidget(ctx);
    ctx.ui.setWorkingVisible(false);
    startWidgetRefresh(ctx);

    ctx.ui.notify("Caravel fleet initialized", "info");
  });

  pi.on("agent_end", async (event, ctx) => {
    // Track main agent activity
    const lastMsg = event.messages?.[event.messages.length - 1];
    if (lastMsg?.role === "assistant") {
      let action = "idle";
      let detail = "Turn complete";
      for (const part of lastMsg.content) {
        if (part.type === "tool_use") {
          const toolName = part.name;
          action = toolName;
          // Extract useful detail from input
          const inputStr = JSON.stringify(part.input || {});
          if (toolName === "bash" && part.input?.command) {
            action = "bash";
            detail = truncateToWidth(part.input.command, 40);
          } else if (toolName === "read" && part.input?.path) {
            action = "read";
            detail = truncateToWidth(part.input.path, 40);
          } else if (toolName === "edit" && part.input?.path) {
            action = "edit";
            detail = truncateToWidth(part.input.path, 40);
          } else if (toolName === "write" && part.input?.path) {
            action = "write";
            detail = truncateToWidth(part.input.path, 40);
          } else {
            action = toolName;
            detail = truncateToWidth(inputStr.slice(0, 50), 40);
          }
          break;
        }
        if (part.type === "text") {
          action = "response";
          detail = truncateToWidth(part.text.slice(0, 60), 40);
        }
      }
      fleetState.mainAgentActivity = {
        status: "idle", // Turn finished, so agent is idle now
        action,
        detail,
        timestamp: Date.now(),
      };
    }
    refreshWidget(ctx);
    saveState();
    // Refresh overlay if visible
    if (dashboardOverlayVisible && dashboardOverlayHandle) {
      dashboardOverlayHandle.requestRender();
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    // Track when main agent starts executing a tool
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
    stopWidgetRefresh();
    hideDashboardOverlay();
  });

  // ---- Dashboard (non-blocking) ----

  pi.registerCommand("fleet", {
    description: "Toggle fleet dashboard (non-blocking widget bar + overlay)",
    handler: async (_args, ctx) => toggleDashboard(ctx),
  });

  // ---- Auto-orchestration commands ----

  /**
   * /go command — auto-orchestrates the fleet.
   * If phases exist: runs them all sequentially with review between each.
   * If no phases: returns helpful message telling user to first plan.
   */
  pi.registerCommand("go", {
    description: "Auto-orchestrate the fleet: run all phases sequentially with review between each",
    handler: async (_args, ctx) => {
      if (fleetState.phases.length === 0) {
        return { content: [{ type: "text", text: `Fleet is idle. No phases defined.

To start, either:
  1. Use plan_project() to define phases, then call /go again
  2. Describe your project in natural language and the planner agent will create the plan` }] };
      }

      // Auto-open dashboard
      showDashboardOverlay(ctx);

      const results: string[] = [];
      let currentIdx = fleetState.currentPhaseIndex;
      let phaseIndex = currentIdx;

      // Run remaining phases sequentially
      while (phaseIndex < fleetState.phases.length) {
        const phase = fleetState.phases[phaseIndex];

        // Skip already complete phases
        if (phase.status === "complete") {
          results.push(`✅ Phase ${phaseIndex + 1} "${phase.name}" — already complete`);
          phaseIndex++;
          continue;
        }

        // Skip failed phases unless they're the current one
        if (phase.status === "failed" && phaseIndex !== currentIdx) {
          results.push(`⚠️ Phase ${phaseIndex + 1} "${phase.name}" — failed, skipping`);
          phaseIndex++;
          continue;
        }

        results.push(`\n▶ Running Phase ${phaseIndex + 1}/${fleetState.phases.length}: "${phase.name}"`);
        fleetState.currentPhaseIndex = phaseIndex;
        saveState();
        refreshWidget(ctx);

        // Run the phase
        const phaseResult = await runPhaseInternal(phaseIndex, ctx);
        results.push(phaseResult);

        // Run review if phase has complete or needs_fix tasks
        const hasReviewableTasks = phase.tasks.some(
          (t) => t.status === "complete" || t.status === "needs_fix"
        );

        if (hasReviewableTasks) {
          results.push(`\n🔍 Reviewing Phase ${phaseIndex + 1}...`);
          const reviewResult = await runReviewInternal(phaseIndex, ctx);
          results.push(reviewResult);

          // If review found issues, run phase again
          const phaseStillIncomplete = phase.tasks.some(
            (t) => t.status !== "complete"
          );
          if (phaseStillIncomplete) {
            results.push(`\n🔁 Re-running Phase ${phaseIndex + 1} after review fixes...`);
            const rerunResult = await runPhaseInternal(phaseIndex, ctx);
            results.push(rerunResult);
          }
        }

        // Check if phase is now complete
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

      // Check if all phases are done
      const allComplete = fleetState.phases.every((p) => p.status === "complete");
      if (allComplete) {
        results.push(`\n🎉 All phases complete! Fleet has finished.`);
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    },
  });

  /**
   * /analyze command — for taking over an existing codebase.
   * Runs a discovery phase that scans project structure, detects tech stack,
   * maps dependencies, and produces a structured analysis report.
   */
  pi.registerCommand("analyze", {
    description: "Analyze an existing codebase: scan structure, detect tech stack, map dependencies",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Analyzing codebase...", "info");

      // Create an analysis phase
      const analysisPhase: FleetPhase = {
        id: generateId(),
        name: "Codebase Analysis",
        status: "running",
        tasks: [],
      };

      // Run analysis tasks
      const analysisTasks = await runAnalysisPhase(ctx);
      analysisPhase.tasks = analysisTasks;

      fleetState.phases = [analysisPhase];
      fleetState.currentPhaseIndex = 0;
      fleetState.startTime = fleetState.startTime || Date.now();
      fleetState.reviewIterations = 0;

      saveState();
      refreshWidget(ctx);
      showDashboardOverlay(ctx);

      return {
        content: [{ type: "text", text: `Codebase analysis complete. Use plan_project() to create a full implementation plan based on the analysis, then call /go to run it.` }],
        details: { phase: analysisPhase },
      };
    },
  });

  // ---- Tools ----

  pi.registerTool({
    name: "plan_project",
    label: "Plan Project",
    description:
      "Decompose a project into phases and tasks. Each phase has tasks assigned to specific agents. " +
      "Returns the fleet state. Use run_phase to execute phases sequentially.",
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

      const summary = phases
        .map((p, i) => `  P${i + 1}: ${p.name} (${p.tasks.length} tasks)`)
        .join("\n");

      return {
        content: [{ type: "text", text: `Project "${params.name}" planned:\n${summary}` }],
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
      const idx = params.phaseIndex ?? fleetState.currentPhaseIndex;
      if (idx < 0 || idx >= fleetState.phases.length) {
        return {
          content: [{ type: "text", text: `Invalid phase index. Available: 0-${fleetState.phases.length - 1}` }],
          details: {},
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

        const result = await runSubagent(agentDef, task.description, ctx.cwd, signal, `task-${task.id}`);
        task.output = result.output;
        task.status = result.exitCode === 0 ? "complete" as const : "failed" as const;
        fleetState.recentOutput = result.output || result.stderr;

        fleetState.activeAgents = fleetState.activeAgents.map((a) =>
          a.name === agentDef.name
            ? {
                ...a,
                status: result.exitCode === 0 ? "idle" as const : "error" as const,
                currentTask: undefined,
                model: agentDef.model,
                tokensUsed: result.usage?.input + result.usage?.output,
                turns: result.usage?.turns,
              }
            : a
        );

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

  // ---- Internal: run a single review cycle ----

  async function runCodeReview(phaseIdx: number, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ approved: boolean; feedback: string; agentUsed: string }> {
    const techLead = discoverAgents("both").find((a) => a.name === "tech-lead");
    if (!techLead) return { approved: false, feedback: "No tech-lead agent available", agentUsed: "none" };

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

    const result = await runSubagent(techLead, reviewPrompt, ctx.cwd, signal, `code-review-${phaseIdx}`);
    const feedback = result.output;
    const approved = feedback.toUpperCase().includes("APPROVED") && !feedback.toLowerCase().includes("fix") && !feedback.toLowerCase().includes("error") && !feedback.toLowerCase().includes("vulnerability");

    return { approved, feedback, agentUsed: "tech-lead" };
  }

  async function runDesignReview(phaseIdx: number, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ approved: boolean; feedback: string; agentUsed: string }> {
    const designer = discoverAgents("both").find((a) => a.name === "designer");
    if (!designer) return { approved: false, feedback: "No designer agent available", agentUsed: "none" };

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

    const result = await runSubagent(designer, reviewPrompt, ctx.cwd, signal, `design-review-${phaseIdx}`);
    const feedback = result.output;
    const approved = feedback.toUpperCase().includes("APPROVED") && !feedback.toLowerCase().includes("fix") && !feedback.toLowerCase().includes("glitch") && !feedback.toLowerCase().includes("contrast");

    return { approved, feedback, agentUsed: "designer" };
  }

  async function runDeveloperFix(task: FleetTask, reviewFeedback: string, reviewType: string, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<boolean> {
    const developer = discoverAgents("both").find((a) => a.name === "developer");
    if (!developer || !task.output) return false;

    onUpdate?.({ content: [{ type: "text", text: `  -> Developer fixing ${reviewType} issues...` }] });

    const fixPrompt = `Fix the issues identified in the ${reviewType} review:

Original task: ${task.description}
Your previous implementation:
${task.output}

${reviewType} review feedback:
${reviewFeedback}

Provide the complete corrected output with specific file changes. Address each issue mentioned in the feedback.
`;

    const fixResult = await runSubagent(developer, fixPrompt, ctx.cwd, signal, `fix-${task.id}-${reviewType}`);
    task.output = fixResult.output;
    task.reviewFeedback = reviewFeedback;
    task.reviewCount++;
    fleetState.recentOutput = fixResult.output;

    return fixResult.exitCode === 0;
  }

  pi.registerTool({
    name: "review_task",
    label: "Review Task",
    description:
      "Submit completed tasks for two-stage review. First, the Tech Lead reviews code quality (correctness, security, performance, architecture). " +
      "Then, the Designer reviews visual quality (layout, consistency, accessibility, polish). " +
      "If either review fails, the Developer auto-fixes and resubmits. Loop until approved or max iterations.",
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
        // All complete, move to next phase
        if (phaseIdx < fleetState.phases.length - 1) {
          fleetState.currentPhaseIndex = phaseIdx + 1;
          saveState();
          refreshWidget(ctx);
          return {
            content: [{ type: "text", text: "All tasks complete. Moved to next phase." }],
            details: { moved: true },
          };
        }
        return {
          content: [{ type: "text", text: "All phases complete. Project done!" }],
          details: { done: true },
        };
      }

      // Find tasks needing review
      const tasksToReview = incompleteTasks.filter((t) => t.status === "complete" || t.status === "needs_fix");
      if (tasksToReview.length === 0) return { content: [{ type: "text", text: "No tasks ready for review" }], details: {} };

      fleetState.reviewIterations++;
      const reviewType = params.reviewType ?? "full";
      saveState();
      refreshWidget(ctx);

      onUpdate?.({
        content: [{ type: "text", text: `Review iteration ${fleetState.reviewIterations}: ${reviewType} review for ${tasksToReview.length} task(s)` }],
      });

      let codeResult: { approved: boolean; feedback: string; agentUsed: string } | null = null;
      let designResult: { approved: boolean; feedback: string; agentUsed: string } | null = null;

      // Stage 1: Code review (Tech Lead)
      if (reviewType === "full" || reviewType === "code") {
        codeResult = await runCodeReview(phaseIdx, signal, ctx, onUpdate);
      }

      // Stage 2: Design review (Designer)
      if (reviewType === "full" || reviewType === "design") {
        designResult = await runDesignReview(phaseIdx, signal, ctx, onUpdate);
      }

      // Check results
      let allApproved = true;

      for (const task of tasksToReview) {
        task.reviewFeedback = "";

        // Evaluate code review
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

        // Evaluate design review
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

          // If not approved and under max iterations, auto-fix
        if (!allApproved && task.reviewCount < task.maxReviewCount) {
          task.status = "needs_fix";

          // Fix code issues first
          if (codeResult && !codeResult.approved && task.codeReviewFeedback) {
            await runDeveloperFix(task, task.codeReviewFeedback, "code", signal, ctx, onUpdate);
          }

          // Fix design issues
          if (designResult && !designResult.approved && task.designReviewFeedback) {
            await runDeveloperFix(task, task.designReviewFeedback, "design", signal, ctx, onUpdate);
          }
        } else if (!allApproved) {
          // Max review iterations reached
          task.status = "failed";
        } else {
          task.status = "complete";
        }
      }

      // Check if phase is complete
      const allDone = phase.tasks.every((t) => t.status === "complete");
      if (allDone) {
        phase.status = "complete";
        phase.completedAt = Date.now();
        if (phaseIdx < fleetState.phases.length - 1) {
          fleetState.currentPhaseIndex = phaseIdx + 1;
        }
      } else if (allApproved) {
        // All tasks in tasksToReview were approved
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
      if (fleetState.phases.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Fleet is idle. No phases defined.
Use /fleet to view the dashboard, or use plan_project to define phases.

Status: idle | Reviews: ${fleetState.reviewIterations} | Elapsed: ${formatDuration(Date.now() - fleetState.startTime)}`,
          }],
          details: { phases: fleetState.phases, agents: fleetState.activeAgents },
        };
      }

      const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
      const completed = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);

      const phases = fleetState.phases.map((p, i) => {
        const done = p.tasks.filter((t) => t.status === "complete").length;
        return `  P${i}: ${p.name} [${p.status}] (${done}/${p.tasks.length})`;
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

  pi.registerTool({
    name: "fleet_control",
    label: "Fleet Control",
    description: "Pause, resume, skip phase, move to next phase, reset fleet state, or auto-orchestrate all remaining phases with review.",
    parameters: Type.Object({
      action: Type.String({ description: "pause | resume | skip | next | reset | go" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "pause":
          fleetState.paused = true;
          refreshWidget(ctx);
          return { content: [{ type: "text", text: "Fleet paused" }], details: { paused: true } };
        case "resume":
          fleetState.paused = false;
          refreshWidget(ctx);
          return { content: [{ type: "text", text: "Fleet resumed" }], details: { paused: false } };
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
        case "go":
          if (fleetState.phases.length === 0) {
            return { content: [{ type: "text", text: "Fleet is idle. No phases defined. Use plan_project() first." }], details: {} };
          }
          // Trigger /go by calling the auto-orchestration
          // This will be handled by the /go command registration above
          // For tool invocation, we just report readiness
          return { content: [{ type: "text", text: "Fleet ready to run. Use /go command or plan_project() to define phases first." }], details: {} };
        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
      }
    },

    promptSnippet: "Control fleet execution: pause, resume, skip, next, reset, or go (auto-orchestrate)",
  });
}
