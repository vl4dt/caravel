/**
 * Caravel Fleet Orchestrator
 *
 * Multi-agent fleet orchestration using only local models.
 *
 * Models:
 *   - Developer/Tech Lead:  llama.cpp @ 10.74.74.151:9090 (Qwen3.6-35B-A3B)
 *   - Designer/Vision:      lm-studio @ 10.74.74.175:1234 (Gemma 4)
 *
 * UI:
 *   - /fleet command: open fleet dashboard overlay (3 panels)
 *   - Fleet status widget: persistent bar above editor
 *   - Fleet keyboard shortcuts: F (toggle), Tab (panels), Enter (details), Space (pause)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type Focusable,
  type KeybindingsManager,
  type TUI,
  type Component,
  getAgentDir,
  matchesKey,
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  Markdown,
  Spacer,
  getMarkdownTheme,
  CURSOR_MARKER,
  visibleWidth,
  truncateToWidth,
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
  startTime: 0,
  reviewIterations: 0,
  maxReviewIterations: 5,
  recentOutput: "",
};

// Dashboard state
let dashboardOpen = false;
let dashboardPanel = 0; // 0=tasks, 1=agents, 2=review, 3=terminal
let dashboardSelectedTask = -1;
let dashboardSelectedAgent = -1;
let dashboardSelectedPhase = -1;
let dashboardTui: TUI | undefined;
let dashboardDone: ((result: string) => void) | undefined;
let dashboardAbortController: AbortController | undefined;
let lastDashboardKeys: string[] = [];
const KEY_HISTORY_SIZE = 100;

// Widget state
let widgetLines: string[] = [];

// Process tracking
const activeProcesses = new Map<string, { proc: ReturnType<typeof spawn>; signal: AbortSignal }>();

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
  pi.appendEntry("caravel-state", fleetState);
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
        maxReviewIterations: fleetState.maxReviewIterations,
        recentOutput: data.recentOutput ?? "",
      };
    }
  }
}

function refreshWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const now = Date.now();
  const elapsed = now - fleetState.startTime;
  const elapsedStr = formatDuration(elapsed);

  const agentStatuses = fleetState.activeAgents
    .filter((a) => a.status !== "idle")
    .map((a) => {
      const icon = a.status === "running" ? "[RUN]" : a.status === "reviewing" ? "[REV]" : "[ERR]";
      return `${truncate(a.name, 10)}${icon}`;
    })
    .join("  ");

  const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = fleetState.phases.reduce(
    (s, p) => s + p.tasks.filter((t) => t.status === "complete").length,
    0
  );
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const barWidth = 25;
  const filled = Math.round((progress / 100) * barWidth);
  const bar = "[" + "#".repeat(filled) + "-".repeat(barWidth - filled) + "]";

  const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];
  const phaseInfo = currentPhase
    ? `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${currentPhase.name}`
    : "No phases";

  const parts = [phaseInfo, bar, `${progress}%`];
  if (agentStatuses) parts.push(agentStatuses);
  parts.push(elapsedStr);
  if (fleetState.paused) parts.push("[PAUSED]");

  widgetLines = [` [${parts.join(" | ")}]`];
  ctx.ui.setWidget("caravel-fleet", widgetLines);
}

function startWidgetRefresh(ctx: ExtensionContext): void {
  const refresh = () => {
    if (!fleetState.paused) refreshWidget(ctx);
    setTimeout(refresh, 3000);
  };
  refresh();
}

function stopWidgetRefresh(): void {
  // Will restart on next session_start
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
// Fleet Dashboard Overlay
// ============================================================================

interface DashboardPanel {
  label: string;
  render(ctx: ExtensionContext, theme: any): Component;
}

class FleetDashboardComponent implements Focusable {
  readonly width = Math.min(90, 80);

  focused = false;

  private panelIndex = 0;
  private selectedPhase = 0;
  private selectedTask = 0;
  private selectedAgent = 0;
  private selectedTab = 0; // 0=tasks, 1=agents, 2=review, 3=terminal

  constructor(
    private ctx: ExtensionContext,
    private done: (result: string | undefined) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      dashboardOpen = false;
      this.done("closed");
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.selectedTab = matchesKey(data, "tab")
        ? (this.selectedTab + 1) % 4
        : (this.selectedTab - 1 + 4) % 4;
      dashboardTui?.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.selectedTab === 0) {
        // Tasks: show task detail
        this.done(`task_${this.selectedPhase}_${this.selectedTask}`);
      } else if (this.selectedTab === 1) {
        this.done(`agent_${this.selectedAgent}`);
      } else if (this.selectedTab === 2) {
        this.done("review");
      } else {
        this.done("closed");
      }
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.selectedTab === 0) {
        if (fleetState.phases.length > 0) this.selectedPhase = Math.max(0, this.selectedPhase - 1);
        this.selectedTask = 0;
      } else if (this.selectedTab === 1) {
        this.selectedAgent = Math.max(0, this.selectedAgent - 1);
      }
      dashboardTui?.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.selectedTab === 0 && fleetState.phases.length > 0) {
        this.selectedPhase = Math.min(fleetState.phases.length - 1, this.selectedPhase + 1);
        this.selectedTask = 0;
      } else if (this.selectedTab === 1) {
        this.selectedAgent = Math.min(
          Math.max(0, fleetState.activeAgents.length - 1),
          this.selectedAgent + 1,
        );
      }
      dashboardTui?.requestRender();
      return;
    }

    if (matchesKey(data, "space")) {
      fleetState.paused = !fleetState.paused;
      saveState();
      this.ctx.ui.notify(`Fleet ${fleetState.paused ? "paused" : "resumed"}`, "info");
      dashboardTui?.requestRender();
      return;
    }

    if (matchesKey(data, "p")) {
      // Skip current phase
      if (this.selectedPhase >= 0 && this.selectedPhase < fleetState.phases.length) {
        fleetState.phases[this.selectedPhase].status = "complete";
        fleetState.phases[this.selectedPhase].completedAt = Date.now();
        fleetState.currentPhaseIndex = Math.min(
          this.selectedPhase + 1,
          fleetState.phases.length - 1,
        );
        saveState();
        refreshWidget(this.ctx);
        dashboardTui?.requestRender();
      }
      return;
    }

    if (matchesKey(data, "r")) {
      // Trigger review
      this.done("review");
      return;
    }
  }

  render(width: number): string[] {
    const th = this.ctx.ui.theme;
    const lines: string[] = [];
    const w = Math.min(width - 2, this.width);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));

    const border = (text: string) => th.fg("border", text);
    const hline = " ".repeat(w);

    lines.push(border(`╭${hline}╮`));

    // Title
    const title = `  CARAVEL FLEET  (Tab:panel | Up/Down:navigate | Enter:select | Space:pause | P:skip | R:review | Esc:close)`;
    lines.push(border(` ${pad(title.slice(0, w - 2), w - 2)} `));
    lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));

    // Tabs
    const tabs = ["TASKS", "AGENTS", "REVIEW", "TERMINAL"];
    const tabLine = tabs.map((t, i) => {
      const label = i === this.selectedTab ? th.fg("accent", ` ${t} `) : ` ${t} `;
      return i > 0 ? border(" |") + label : label;
    }).join("");
    lines.push(border(` ${pad(tabLine, w - 2)} `));
    lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));

    // Panel content
    const panelContent = this.renderPanel(th, w);
    lines.push(...panelContent);

    // Footer
    const footer = ` ${formatDuration(Date.now() - fleetState.startTime)} | ${fleetState.reviewIterations} reviews | ${fleetState.paused ? "[PAUSED]" : "[RUNNING]"} `;
    lines.push(border(` ${pad(footer, w - 2)} `));
    lines.push(border(`╰${hline}╯`));

    return lines;
  }

  private renderPanel(th: any, w: number): string[] {
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);

    switch (this.selectedTab) {
      case 0: return this.renderTasksPanel(th, w);
      case 1: return this.renderAgentsPanel(th, w);
      case 2: return this.renderReviewPanel(th, w);
      case 3: return this.renderTerminalPanel(th, w);
      default: return [border(` ${pad("Unknown panel", w - 2)} `)];
    }
  }

  private renderTasksPanel(th: any, w: number): string[] {
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);

    const lines: string[] = [];
    if (fleetState.phases.length === 0) {
      lines.push(border(` ${pad("No phases defined. Use plan_project to start.", w - 2)} `));
      return lines;
    }

    for (let i = 0; i < fleetState.phases.length; i++) {
      const phase = fleetState.phases[i]!;
      const isCurrent = i === this.selectedPhase;
      const isSelected = i === fleetState.currentPhaseIndex;

      const statusIcon = this.phaseStatusIcon(phase.status);
      const name = isCurrent ? th.fg("accent", phase.name) : phase.name;
      const marker = isSelected ? ">>>" : isCurrent ? " " : "   ";

      // Count tasks by status
      const completed = phase.tasks.filter((t) => t.status === "complete").length;
      const total = phase.tasks.length;
      const pct = total > 0 ? `${completed}/${total}` : "--";

      lines.push(
        border(` ${pad(`${marker} ${statusIcon} P${i + 1}: ${name}`, w - 2)} `),
      );

      if (isCurrent || isSelected) {
        for (let j = 0; j < phase.tasks.length; j++) {
          const task = phase.tasks[j]!;
          const taskSelected = j === this.selectedTask;
          const taskMarker = taskSelected ? "  >" : "    ";
          const taskStatus = this.taskStatusIcon(task.status);
          const taskAgent = th.fg("dim", task.agentName);

          // Review status indicators
          const codeOk = task.codeReviewStatus === "approved";
          const codeFail = task.codeReviewStatus === "needs_fix";
          const codeP = task.codeReviewStatus === "pending";
          const codeIcon = codeOk ? th.fg("success", "+") : codeFail ? th.fg("error", "!") : codeP ? th.fg("dim", "-") : "-";

          const desOk = task.designReviewStatus === "approved";
          const desFail = task.designReviewStatus === "needs_fix";
          const desP = task.designReviewStatus === "pending";
          const desIcon = desOk ? th.fg("success", "+") : desFail ? th.fg("error", "!") : desP ? th.fg("dim", "-") : "-";

          const reviewIndicators = `(${codeIcon}${desIcon})`;
          const taskName = truncate(task.description, 38);
          lines.push(
            border(` ${pad(`${taskMarker}${taskStatus} [${taskAgent}] ${taskName} ${reviewIndicators}`, w - 2)} `),
          );
        }
      }

      const summary = `     ${th.fg("dim", `(${pct} tasks)`)}${isSelected ? "" : ""}`;
      lines.push(border(` ${pad(summary, w - 2)} `));
    }

    return lines;
  }

  private renderAgentsPanel(th: any, w: number): string[] {
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);

    const lines: string[] = [];
    const agents = discoverAgents("both");
    const active = fleetState.activeAgents;

    if (agents.length === 0) {
      lines.push(border(` ${pad("No agents configured. Add agent files to ~/.pi/agents/ or .pi/agents/.", w - 2)} `));
      return lines;
    }

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      const isActive = active.find((a) => a.name === agent.name);
      const isFocused = i === this.selectedAgent;

      const status = isActive ? isActive.status : "idle";
      const statusStr = status === "running" ? "RUNNING" : status === "reviewing" ? "REVIEWING" : status === "error" ? "ERROR" : "IDLE";
      const statusColor =
        status === "running" ? "accent" : status === "reviewing" ? "warning" : status === "error" ? "error" : "muted";
      const marker = isFocused ? " >" : "  ";

      const name = isFocused ? th.fg("accent", agent.name) : agent.name;
      const modelStr = truncate(agent.model.split("/").pop() || agent.model, 25);
      const taskStr = isActive?.currentTask ? truncate(` | ${isActive.currentTask}`, 30) : "";

      lines.push(
        border(` ${pad(`${marker}${name} [${th.fg(statusColor, statusStr)}]`, w - 2)} `),
        border(` ${pad(`    Model: ${th.fg("dim", modelStr)}${taskStr}`, w - 2)} `),
      );
    }

    if (active.length > 0) {
      lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));
      lines.push(border(` ${th.fg("accent", "Active Agents")} `));
      for (const agent of active) {
        if (agent.status !== "idle") {
          const taskStr = truncate(agent.currentTask || "N/A", 40);
          lines.push(
            border(` ${pad(`  ${agent.name}: ${taskStr}`, w - 2)} `),
          );
        }
      }
    }

    return lines;
  }

  private renderReviewPanel(th: any, w: number): string[] {
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);

    const lines: string[] = [];
    lines.push(border(` ${pad("Review Flow", w - 2)} `));
    lines.push(border(` ${pad("Two-Stage Review Gate", w - 2)} `));
    lines.push(border(` ${pad("Iterations: " + fleetState.reviewIterations, w - 2)} `));
    lines.push(border(` ${pad("Max: " + fleetState.maxReviewIterations, w - 2)} `));

    lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));
    lines.push(border(` ${pad("Stage 1: Code Review", w - 2)} `));
    lines.push(border(` ${pad("  Tech Lead -> checks: correctness, security, architecture", w - 2)} `));
    lines.push(border(` ${pad("  Performance, code quality, testing", w - 2)} `));

    lines.push(border(` ${pad("Stage 2: Design Review", w - 2)} `));
    lines.push(border(` ${pad("  Designer -> checks: layout, consistency, accessibility", w - 2)} `));
    lines.push(border(` ${pad("  UX, polish, visual quality", w - 2)} `));

    lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));
    lines.push(border(` ${pad("Flow:", w - 2)} `));
    lines.push(border(` ${pad("  Developer -> [Code Review] -> [Design Review] -> Developer", w - 2)} `));
    lines.push(border(` ${pad("  (either stage can return for fixes, up to N iterations)", w - 2)} `));

    // Task-level review status summary
    let totalTasksWithReview = 0;
    let codeApproved = 0;
    let codeNeedsFix = 0;
    let designApproved = 0;
    let designNeedsFix = 0;

    for (const phase of fleetState.phases) {
      for (const task of phase.tasks) {
        if (task.codeReviewStatus) {
          totalTasksWithReview++;
          if (task.codeReviewStatus === "approved") codeApproved++;
          if (task.codeReviewStatus === "needs_fix") codeNeedsFix++;
        }
        if (task.designReviewStatus) {
          if (task.designReviewStatus === "approved") designApproved++;
          if (task.designReviewStatus === "needs_fix") designNeedsFix++;
        }
      }
    }

    if (totalTasksWithReview > 0) {
      lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));
      lines.push(border(` ${pad("Review Summary:", w - 2)} `));
      lines.push(border(` ${pad(`  Code: ${codeApproved} approved | ${codeNeedsFix} needs fix`, w - 2)} `));
      lines.push(border(` ${pad(`  Design: ${designApproved} approved | ${designNeedsFix} needs fix`, w - 2)} `));
    }

    if (fleetState.reviewIterations < fleetState.maxReviewIterations) {
      const pct = Math.round((fleetState.reviewIterations / fleetState.maxReviewIterations) * 100);
      const barW = 20;
      const filled = Math.round((pct / 100) * barW);
      const bar = "[" + "=".repeat(filled) + "-".repeat(barW - filled) + "]";
      lines.push(border(` ${pad(`${bar} ${pct}%`, w - 2)} `));
    }

    lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));
    lines.push(border(` ${pad("Recent review feedback:", w - 2)} `));

    // Find recent review feedback from phases
    let foundFeedback = false;
    for (let i = fleetState.phases.length - 1; i >= 0; i--) {
      for (const task of fleetState.phases[i]!.tasks) {
        if (task.reviewFeedback) {
          const feedback = truncate(task.reviewFeedback, 50);
          lines.push(border(` ${pad(`  [${fleetState.phases[i]!.name}] ${feedback}`, w - 2)} `));
          foundFeedback = true;
          if (foundFeedback) break;
        }
      }
      if (foundFeedback) break;
    }

    if (!foundFeedback) {
      lines.push(border(` ${pad("  (none yet)", w - 2)} `));
    }

    return lines;
  }

  private renderTerminalPanel(th: any, w: number): string[] {
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const border = (text: string) => th.fg("border", text);

    const lines: string[] = [];
    lines.push(border(` ${pad("Live Terminal (recent output)", w - 2)} `));
    lines.push(border(` ${"─".repeat(Math.min(w - 2, 60))} `));

    const output = fleetState.recentOutput;
    if (!output) {
      lines.push(border(` ${pad("(No output yet. Start a phase to see output.)", w - 2)} `));
      return lines;
    }

    // Show last N lines of output
    const maxLines = 12;
    const outputLines = output.split("\n");
    const show = outputLines.slice(-maxLines);

    for (const line of show) {
      const truncated = truncate(line, w - 2);
      lines.push(border(` ${pad(truncated, w - 2)} `));
    }

    if (outputLines.length > maxLines) {
      lines.push(border(` ${pad(`... (${outputLines.length - maxLines} more lines)`, w - 2)} `));
    }

    return lines;
  }

  private phaseStatusIcon(status: string): string {
    switch (status) {
      case "pending": return "[ ]";
      case "running": return "=>>";
      case "reviewing": return "[?]";
      case "complete": return "[x]";
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
    dashboardDone = undefined;
    dashboardTui = undefined;
  }
}

// ============================================================================
// Dashboard command
// ============================================================================

function openDashboard(ctx: ExtensionContext): void {
  if (dashboardOpen) {
    dashboardOpen = false;
    dashboardDone?.("closed");
    return;
  }

  dashboardOpen = true;
  dashboardPanel = 0;

  const done = (result: string) => {
    dashboardOpen = false;
    dashboardDone?.(result);
  };

  ctx.ui.custom<string>((tui, theme, keybindings, finish) => {
    dashboardTui = tui;
    dashboardDone = finish;
    return new FleetDashboardComponent(ctx, (result) => {
      finish(result as string);
    });
  }, { overlay: true });
}

// ============================================================================
// Main extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // ---- Events ----

  pi.on("session_start", async (_event, ctx) => {
    loadState(ctx);
    refreshWidget(ctx);
    pi.setWorkingVisible(false);
    startWidgetRefresh(ctx);

    ctx.ui.notify("Caravel fleet initialized", "info");
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshWidget(ctx);
    saveState();
  });

  pi.on("session_shutdown", () => {
    saveState();
    stopWidgetRefresh();
  });

  // ---- Dashboard ----

  pi.registerCommand("fleet", {
    description: "Open fleet dashboard overlay",
    handler: async (_args, ctx) => openDashboard(ctx),
  });

  pi.registerCommand("fleet-toggle", {
    description: "Toggle fleet dashboard (open/close)",
    handler: async (_args, ctx) => {
      if (dashboardOpen) {
        dashboardOpen = false;
        dashboardDone?.("closed");
        ctx.ui.notify("Fleet dashboard closed", "info");
      } else {
        openDashboard(ctx);
      }
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

      for (const task of phase.tasks) {
        const agentDef = discoverAgents("both").find((a) => a.name === task.agentName);
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
      fleetState.activeAgents = fleetState.activeAgents.map((a) =>
        a.status === "running" ? { ...a, status: "idle" as const } : a
      );

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
      let combinedFeedback = "";
      let anyFixed = false;

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

        // If not approved, auto-fix
        if (!allApproved && task.reviewCount < task.maxReviewCount) {
          task.status = "needs_fix";

          // Fix code issues first
          if (codeResult && !codeResult.approved && task.codeReviewFeedback) {
            const fixed = await runDeveloperFix(task, task.codeReviewFeedback, "code", signal, ctx, onUpdate);
            if (fixed) anyFixed = true;
          }

          // Fix design issues
          if (designResult && !designResult.approved && task.designReviewFeedback) {
            const fixed = await runDeveloperFix(task, task.designReviewFeedback, "design", signal, ctx, onUpdate);
            if (fixed) anyFixed = true;
          }
        } else if (!allApproved) {
          task.status = "failed";
        } else {
          task.status = "complete";
          anyFixed = true;
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
        // All tasks approved even if not all were in tasksToReview
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
    description: "Pause, resume, skip phase, or reset fleet state.",
    parameters: Type.Object({
      action: Type.String({ description: "pause | resume | skip | next | reset" }),
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
          };
          saveState();
          refreshWidget(ctx);
          return { content: [{ type: "text", text: "Fleet state reset" }], details: {} };
        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
      }
    },

    promptSnippet: "Control fleet execution: pause, resume, skip, or reset",
  });
}
