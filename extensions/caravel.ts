/**
 * Caravel Fleet Orchestrator
 *
 * Multi-agent fleet orchestration with supervisor-worker pattern, two-stage review loops.
 * Works with any model provider (local or cloud).
 *
 * UI:
 *   - Fleet status: persistent 6-line widget bar above the editor
 *   - The widget bar shows: header/status, phase + progress, summary stats, last action
 *   - /fleet command: toggle the widget bar visibility
 *   - The widget bar is always stable: fixed 6 lines, never changes height or width
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
  reviewFeedback?: string;
  reviewCount: number;
  maxReviewCount: number;
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

let widgetVisible = true;
let _pi: ExtensionAPI | null = null;
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

// ============================================================================
// Widget bar — always exactly 6 lines, never changes size
// ============================================================================

/**
 * Build the fixed 6-line widget bar content.
 * This is designed to never change height or width, providing a stable visual anchor.
 */
function buildWidgetLines(ctx: ExtensionContext): string[] {
  const th = ctx.ui.theme;
  const now = Date.now();

  const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = fleetState.phases.reduce(
    (s, p) => s + p.tasks.filter((t) => t.status === "complete").length,
    0,
  );
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const elapsed = formatDuration(now - fleetState.startTime);

  const border = th.fg("borderMuted");
  const borderAccent = th.fg("accent");
  const muted = th.fg("muted");
  const dim = th.fg("dim");

  // Always exactly 6 lines:
  // Line 1: top border
  // Line 2: title/status header
  // Line 3: phase info + progress bar
  // Line 4: stats summary
  // Line 5: last agent action (or idle info)
  // Line 6: bottom border

  // ── Top border ──
  const topBorder = th.fg("borderMuted", "╔══════════════════════════════════════════════════════════════╗");

  if (fleetState.phases.length === 0) {
    // ── IDLE STATE ──
    const agentCount = discoverAgents("both").length;
    const statusIcon = fleetState.paused ? th.fg("warning", "⏸") : th.fg("muted", "●");
    const statusText = fleetState.paused ? "PAUSED" : "IDLE";
    const statusColor = fleetState.paused ? "warning" : "muted";

    const title = th.fg("accent", "CARAVEL FLEET");
    const header = `  ${title}  ${muted("│")}  ${th.fg(statusColor, statusIcon + " " + statusText)}`;
    const headerLine = th.fg("borderMuted", "║") + header.padEnd(62) + th.fg("borderMuted", " ║");

    // Progress bar (always shown, 0% when idle)
    const barW = 20;
    const bar = "░".repeat(barW);
    const progressLine = th.fg("borderMuted", "║") + `  [${bar}] 0%  ${muted("│")}  ${agentCount} agents configured  │  ${elapsed}`.padEnd(62) + th.fg("borderMuted", " ║");

    // Agent activity
    const mainAgent = fleetState.mainAgentActivity;
    let actionLine = muted("  last: idle — no active work yet");
    if (mainAgent && mainAgent.action !== "idle") {
      const icon = mainAgent.status === "thinking" ? th.fg("dim", "◇") : th.fg("dim", "▸");
      const timeAgo = now - mainAgent.timestamp;
      const timeStr = timeAgo < 60000 ? `${Math.round(timeAgo / 1000)}s ago`
        : timeAgo < 3600000 ? `${Math.round(timeAgo / 60000)}m ago`
        : `${Math.round(timeAgo / 3600000)}h ago`;
      const detail = truncate(mainAgent.detail, 20);
      actionLine = muted(`  ${icon} last: ${mainAgent.action} → ${detail}  (${timeStr})`);
    }
    const actionBarLine = th.fg("borderMuted", "║") + actionLine.padEnd(62) + th.fg("borderMuted", " ║");

    // Review count line
    const reviewLine = th.fg("borderMuted", "║") + `  ${th.fg("dim", `● ${fleetState.reviewIterations} reviews completed`)}  ${muted("│")}  ${muted(`Elapsed: ${elapsed}`)}`.padEnd(62) + th.fg("borderMuted", " ║");

    const bottomBorder = th.fg("borderMuted", "╚══════════════════════════════════════════════════════════════╝");

    return [topBorder, headerLine, progressLine, actionBarLine, reviewLine, bottomBorder];
  }

  // ── ACTIVE STATE ──
  const currentPhase = fleetState.phases[fleetState.currentPhaseIndex];

  // Header: phase name + status
  const phaseLabel = currentPhase
    ? th.fg("accent", `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${currentPhase.name}`)
    : th.fg("muted", "No current phase");

  const statusIcon = currentPhase
    ? currentPhase.status === "complete" ? th.fg("success", "✓")
    : currentPhase.status === "failed" ? th.fg("error", "✗")
    : (currentPhase.status === "running" || currentPhase.status === "reviewing") ? th.fg("accent", "▸")
    : th.fg("muted", "○")
    : th.fg("muted", "○");
  const statusText = currentPhase
    ? (currentPhase.status === "complete" ? "DONE" : currentPhase.status === "failed" ? "FAILED" : currentPhase.status === "reviewing" ? "REV" : "RUN")
    : "UNKNOWN";
  const statusColor = currentPhase
    ? currentPhase.status === "complete" ? "success" : currentPhase.status === "failed" ? "error" : "accent"
    : "muted";

  const header = `  ${th.fg("accent", "CARAVEL FLEET")}  ${muted("│")}  ${phaseLabel}  ${muted("│")}  ${th.fg(statusColor, statusIcon + " " + statusText)}`;
  const headerLine = th.fg("borderMuted", "║") + header.padEnd(62) + th.fg("borderMuted", " ║");

  // Progress bar
  const barW = 20;
  const filled = Math.round((progress / 100) * barW);
  const bar = "█".repeat(filled) + "░".repeat(barW - filled);
  const progressLine = th.fg("borderMuted", "║") + `  [${bar}] ${progress}%  ${muted("│")}  ${completedTasks}/${totalTasks} tasks  │  ${elapsed}`.padEnd(62) + th.fg("borderMuted", " ║");

  // Agent activity
  const mainAgent = fleetState.mainAgentActivity;
  const activeAgentsList = fleetState.activeAgents.filter((a) => a.status !== "idle");
  let agentLine = "";

  if (fleetState.paused) {
    agentLine = muted("  ⏸ PAUSED");
  } else if (mainAgent && mainAgent.action !== "idle" && (mainAgent.status === "executing" || mainAgent.status === "thinking")) {
    const actColor = mainAgent.status === "thinking" ? "dim" : "accent";
    const actIcon = mainAgent.status === "thinking" ? th.fg("dim", "◇") : th.fg("accent", "▸");
    const detail = truncate(mainAgent.detail, 20);
    agentLine = `  ${actIcon} running: ${mainAgent.action} → ${detail}`;
  } else if (mainAgent && mainAgent.action !== "idle") {
    const timeAgo = now - mainAgent.timestamp;
    const timeStr = timeAgo < 60000 ? `${Math.round(timeAgo / 1000)}s ago`
      : timeAgo < 3600000 ? `${Math.round(timeAgo / 60000)}m ago`
      : `${Math.round(timeAgo / 3600000)}h ago`;
    const detail = truncate(mainAgent.detail, 20);
    agentLine = `  ▸ last: ${mainAgent.action} → ${detail}  (${timeStr})`;
  } else if (activeAgentsList.length > 0) {
    agentLine = activeAgentsList.map((a) => `  ${th.fg("accent", "▸")} ${a.name}`).join("  │  ");
  } else {
    agentLine = muted("  idle — waiting for work");
  }
  const agentBarLine = th.fg("borderMuted", "║") + agentLine.padEnd(62) + th.fg("borderMuted", " ║");

  // Reviews + elapsed
  const statsLine = th.fg("borderMuted", "║") + `  ${th.fg("dim", `${fleetState.reviewIterations} reviews`)}  ${muted("│")}  ${muted(`Elapsed: ${elapsed}`)}`.padEnd(62) + th.fg("borderMuted", " ║");

  const bottomBorder = th.fg("borderMuted", "╚══════════════════════════════════════════════════════════════╝");

  return [topBorder, headerLine, progressLine, agentBarLine, statsLine, bottomBorder];
}

/**
 * Update or create the persistent widget bar.
 * Always creates exactly one widget, never stacks multiple bars.
 */
function refreshWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("caravel-fleet", widgetVisible ? buildWidgetLines(ctx) : null);
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
): Promise<{ output: string; stderr: string; exitCode: number; messages: Message[]; usage: any }> {
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
      const abortSignal = signal ?? (new AbortController()).signal;
      activeProcesses.set(procId, { proc, signal: abortSignal });
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
// Dashboard toggle (widget bar only, no overlay)
// ============================================================================

function toggleWidgetVisibility(ctx: ExtensionContext): void {
  widgetVisible = !widgetVisible;
  refreshWidget(ctx);
  ctx.ui.notify(`CARAVEL: widget ${widgetVisible ? "shown" : "hidden"}`, "info");
}

// ============================================================================
// Auto-orchestration helpers
// ============================================================================

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
    if (task.status === "complete") continue;

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

  const tasksToReview = incompleteTasks.filter((t) => t.status === "complete" || t.status === "needs_fix");
  if (tasksToReview.length === 0) {
    return "No tasks ready for review yet.";
  }

  fleetState.reviewIterations++;
  saveState();
  refreshWidget(ctx);

  const codeResult = await runCodeReview(phaseIdx, undefined, ctx);
  const designResult = await runDesignReview(phaseIdx, undefined, ctx);

  // Check for agent availability errors first — can't fix missing agents
  if (codeResult.error) {
    return `Review #${fleetState.reviewIterations}: ⚠️ Code review failed — ${codeResult.error}`;
  }
  if (designResult.error) {
    return `Review #${fleetState.reviewIterations}: ⚠️ Design review failed — ${designResult.error}`;
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
        const fixCode = await runDeveloperFix(task, task.codeReviewFeedback, "code", undefined, ctx);
        if (fixCode.error) {
          task.reviewFeedback += `[AUTO-FIX ERROR - Code]: ${fixCode.error}\n\n`;
        }
      }

      // Try auto-fix design issues
      if (designResult.approved === false && task.designReviewFeedback) {
        const fixDesign = await runDeveloperFix(task, task.designReviewFeedback, "design", undefined, ctx);
        if (fixDesign.error) {
          task.reviewFeedback += `[AUTO-FIX ERROR - Design]: ${fixDesign.error}\n\n`;
        }
      }

      // Re-check after fix
      if (codeResult.approved === false) {
        const recheckCode = await runCodeReview(phaseIdx, undefined, ctx);
        if (!recheckCode.error && recheckCode.approved) {
          task.codeReviewStatus = "approved";
        } else if (recheckCode.error) {
          task.codeReviewStatus = "failed";
          task.codeReviewFeedback = recheckCode.feedback;
          task.reviewFeedback += `[RE-CHECK ERROR - Code]: ${recheckCode.error}\n\n`;
        }
      }
      if (designResult.approved === false) {
        const recheckDesign = await runDesignReview(phaseIdx, undefined, ctx);
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
async function runAnalysisPhase(ctx: ExtensionContext): Promise<{ tasks: FleetTask[]; report: string; errors: string[] }> {
  const allAgents = discoverAgents("both");
  const auditor = allAgents.find((a) => a.name === "auditor");
  const developer = allAgents.find((a) => a.name === "developer");

  // Determine which agent to use: auditor first, then developer as fallback
  const analyzer = auditor || developer;
  if (!analyzer) {
    const failedTask: FleetTask = {
      id: generateId(),
      agentName: "none",
      description: "No analyzer agent available",
      status: "failed" as const,
      reviewCount: 0,
      maxReviewCount: 3,
    };
    return { tasks: [failedTask], report: "", errors: ["No analyzer agent configured. Add an 'auditor' or 'developer' agent to your agents/ directory with a valid model configured."] };
  }

  const analysisTask: FleetTask = {
    id: generateId(),
    agentName: analyzer.name,
    description: "Perform a comprehensive codebase analysis: scan directory structure, detect tech stack, identify entry points, list dependencies, assess test coverage, and provide a structured analysis report.",
    status: "running" as const,
    reviewCount: 0,
    maxReviewCount: 3,
  };

  const analysisPrompt = `You are analyzing an existing codebase at ${ctx.cwd}. Perform a thorough analysis:

## What to Analyze

1. **Project Structure**: List top-level directories and key files. Note the overall organization.
2. **Tech Stack**: Identify languages, frameworks, build tools, and dependencies from package files.
3. **Architecture**: Describe the overall pattern (MVC, monorepo, microservices, etc.)
4. **Entry Points**: Find main entry files (index.ts, main.ts, App.tsx, etc.)
5. **Dependencies**: List key packages from package.json, requirements.txt, Cargo.toml, etc.
6. **Test Coverage**: Identify test files and frameworks in use
7. **Configuration**: Note key config files (tsconfig, webpack, docker-compose, etc.)

## Provide Your Report In This Format:

# Codebase Analysis

## Overview
[language, framework, purpose in 2-3 sentences]

## Structure
[brief directory overview]

## Tech Stack
- Languages: [...]
- Frameworks: [...]
- Build Tools: [...]
- Key Dependencies: [...]

## Architecture
[description]

## Entry Points
[file paths]

## Test Coverage
[test framework, key test files, coverage status]

## Recommendations
[what to do next based on the codebase state]`;

  try {
    const result = await runSubagent(analyzer, analysisPrompt, ctx.cwd);
    analysisTask.status = result.exitCode === 0 && result.output?.trim().length > 0 ? "complete" : "failed";
    analysisTask.output = result.output || "";
    analysisTask.reviewFeedback = result.stderr || "";
    fleetState.recentOutput = result.output || result.stderr || "";

    if (result.exitCode === 0 && analysisTask.output) {
      return { tasks: [analysisTask], report: analysisTask.output, errors: [] };
    }

    return {
      tasks: [analysisTask],
      report: analysisTask.output || "(empty output)",
      errors: [result.stderr || `Exit code: ${result.exitCode}`, result.exitCode !== 0 ? "Subagent exited with non-zero code" : "Subagent produced no output"],
    };
  } catch (err) {
    analysisTask.status = "failed";
    analysisTask.output = "";
    analysisTask.reviewFeedback = String(err);
    return {
      tasks: [analysisTask],
      report: "",
      errors: [String(err), `Failed to run ${analyzer.name} agent: ${analyzer.model || "no model configured"}`],
    };
  }
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
          detail = truncateToWidth(part.text.slice(0, 60), 40);
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

  pi.registerCommand("fleet", {
    description: "Toggle fleet widget bar visibility",
    handler: async (_args, ctx) => {
      toggleWidgetVisibility(ctx);
    },
  });

  // ---- /go: auto-orchestrate all phases ----

  pi.registerCommand("go", {
    description: "Auto-orchestrate the fleet: run all phases sequentially with review between each",
    handler: async (_args, ctx) => {
      if (fleetState.phases.length === 0) {
        return { content: [{ type: "text", text: `Fleet is idle. No phases defined.\n\nTo start, either:\n  1. Use plan_project() to define phases, then call /go again\n  2. Describe your project in natural language and the planner agent will create the plan` }] };
      }

      const results: string[] = [];
      let phaseIndex = fleetState.currentPhaseIndex;

      while (phaseIndex < fleetState.phases.length) {
        const phase = fleetState.phases[phaseIndex];

        if (phase.status === "complete") {
          results.push(`✅ Phase ${phaseIndex + 1} "${phase.name}" — already complete`);
          phaseIndex++;
          continue;
        }

        if (phase.status === "failed" && phaseIndex !== fleetState.currentPhaseIndex) {
          results.push(`⚠️ Phase ${phaseIndex + 1} "${phase.name}" — failed, skipping`);
          phaseIndex++;
          continue;
        }

        results.push(`\n▶ Running Phase ${phaseIndex + 1}/${fleetState.phases.length}: "${phase.name}"`);
        fleetState.currentPhaseIndex = phaseIndex;
        saveState();
        refreshWidget(ctx);

        const phaseResult = await runPhaseInternal(phaseIndex, ctx);
        results.push(phaseResult);

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
            const rerunResult = await runPhaseInternal(phaseIndex, ctx);
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

      // Run the actual analysis (creates real tasks that execute subagents)
      const analysisResult = await runAnalysisPhase(ctx);

      if (analysisResult.tasks.length === 0) {
        return { content: [{ type: "text", text: "No analyzer agent available. Please configure an 'auditor' or 'developer' agent in your agents/ directory." }] };
      }

      // Create a phase from the analysis tasks
      const allComplete = analysisResult.tasks.every((t) => t.status === "complete");
      const analysisPhase: FleetPhase = {
        id: generateId(),
        name: "Codebase Analysis",
        status: allComplete ? "complete" : "failed",
        tasks: analysisResult.tasks,
      };

      fleetState.phases = [analysisPhase];
      fleetState.currentPhaseIndex = 0;
      fleetState.startTime = fleetState.startTime || Date.now();
      fleetState.reviewIterations = 0;

      saveState();
      refreshWidget(ctx);

      // Build a readable response
      let response = "";
      if (allComplete) {
        response += `✅ Codebase analysis complete:\n\n${analysisResult.report}`;
        response += `\n\nYou can now use plan_project() to create a full implementation plan based on this analysis, then call /go to run it.`;
      } else {
        response += `⚠️ Analysis encountered issues:\n\n`;
        if (analysisResult.report && analysisResult.report !== "(empty output)") {
          response += `Partial output:\n${analysisResult.report}\n\n`;
        }
        response += `Errors:\n${analysisResult.errors.map((e) => `  - ${e}`).join("\n")}`;
        if (analysisResult.errors.some((e) => e.toLowerCase().includes("no analyzer agent") || e.toLowerCase().includes("no agent"))) {
          response += `\n\n💡 To fix: Add an 'auditor.md' or 'developer.md' agent to your agents/ directory with a valid model configured.`;
        }
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

  // ---- Internal: review helpers ----

  async function runCodeReview(phaseIdx: number, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ approved: boolean; feedback: string; agentUsed: string; error?: string }> {
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

    const result = await runSubagent(techLead, reviewPrompt, ctx.cwd, signal, `code-review-${phaseIdx}`);
    const feedback = result.output || "";
    const approved = feedback.toUpperCase().includes("APPROVED") && !feedback.toLowerCase().includes("fix") && !feedback.toLowerCase().includes("error") && !feedback.toLowerCase().includes("vulnerability");

    return { approved, feedback, agentUsed: "tech-lead", error: result.exitCode !== 0 || !feedback ? `Tech-lead agent exited with code ${result.exitCode}${!feedback ? " and produced no output" : ""}` : undefined };
  }

  async function runDesignReview(phaseIdx: number, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ approved: boolean; feedback: string; agentUsed: string; error?: string }> {
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

    const result = await runSubagent(designer, reviewPrompt, ctx.cwd, signal, `design-review-${phaseIdx}`);
    const feedback = result.output || "";
    const approved = feedback.toUpperCase().includes("APPROVED") && !feedback.toLowerCase().includes("fix") && !feedback.toLowerCase().includes("glitch") && !feedback.toLowerCase().includes("contrast");

    return { approved, feedback, agentUsed: "designer", error: result.exitCode !== 0 || !feedback ? `Designer agent exited with code ${result.exitCode}${!feedback ? " and produced no output" : ""}` : undefined };
  }

  async function runDeveloperFix(task: FleetTask, reviewFeedback: string, reviewType: string, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: any): Promise<{ success: boolean; error?: string }> {
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

    const fixResult = await runSubagent(developer, fixPrompt, ctx.cwd, signal, `fix-${task.id}-${reviewType}`);
    task.output = fixResult.output;
    task.reviewFeedback = reviewFeedback;
    task.reviewCount++;
    fleetState.recentOutput = fixResult.output || "";

    return { success: fixResult.exitCode === 0, error: fixResult.exitCode !== 0 ? `Developer agent exited with code ${fixResult.exitCode}` : undefined };
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

      fleetState.reviewIterations++;
      const reviewType = params.reviewType ?? "full";
      saveState();
      refreshWidget(ctx);

      onUpdate?.({
        content: [{ type: "text", text: `Review iteration ${fleetState.reviewIterations}: ${reviewType} review for ${tasksToReview.length} task(s)` }],
      });

      let codeResult: { approved: boolean; feedback: string; agentUsed: string; error?: string } | null = null;
      let designResult: { approved: boolean; feedback: string; agentUsed: string; error?: string } | null = null;

      if (reviewType === "full" || reviewType === "code") {
        codeResult = await runCodeReview(phaseIdx, signal, ctx, onUpdate);
      }
      if (reviewType === "full" || reviewType === "design") {
        designResult = await runDesignReview(phaseIdx, signal, ctx, onUpdate);
      }

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
      if (fleetState.phases.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Fleet is idle. No phases defined.
Use /fleet to toggle the widget bar, or use plan_project to define phases.

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
    description: "Pause, resume, skip phase, move to next phase, reset fleet state, or auto-orchestrate.",
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
          return { content: [{ type: "text", text: "Fleet ready to run. Use /go command or plan_project() to define phases first." }], details: {} };
        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
      }
    },

    promptSnippet: "Control fleet execution: pause, resume, skip, next, reset, or go",
  });
}
