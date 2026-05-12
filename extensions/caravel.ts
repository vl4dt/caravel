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
import { ZFS } from "./zellij-fleet";

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
  metadata?: { preFlight?: PreFlightScan; [key: string]: unknown };
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
let _pi: ExtensionAPI | null = null;
const activeProcesses = new Map<string, { proc: ReturnType<typeof spawn>; signal: AbortSignal }>();

// ── ZFS fleet instance (bridges ZFS process management with fleet state) ──
let zfs: ZFS | null = null;

function ensureZFS(): ZFS {
  if (!zfs) {
    zfs = new ZFS();
    zfs.setCwd(process.cwd());
    zfs.checkAndInitZellij();
  }
  return zfs;
}

// ============================================================================
// Follow system — track which agent's live output the user is watching
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
    buf.stdout += text;
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
    buf.stderr += text;
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

// ============================================================================
// Helpers
// ============================================================================

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
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.001) return `$${(cost * 1000).toFixed(1)}m`;
  return `$${cost.toFixed(4)}`;
}

/** Generate actionable guidance based on the error messages encountered. */
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
    suggestions.push("The agent may have hung — check the model provider status");
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
    summary = `ℹ️ Fleet has ${warningCount} warning(s) to review.`;
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
        totalFleetTokens: data.totalFleetTokens ?? 0,
        mainAgentActivity: data.mainAgentActivity ?? fleetState.mainAgentActivity,
      };
    }
  }
}

// ============================================================================
// Widget bar — always exactly 4 lines, left-edge only
// ============================================================================

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

  const muted = (t: string) => th.fg("muted", t);
  const dim = (t: string) => th.fg("dim", t);
  const edge = (t: string) => th.fg("borderMuted", "│") + "  " + t;

  // ── Build follow indicator ──
  let followLine = "";
  if (followedAgent.agent) {
    const followIcon = followedAgent.isLive ? th.fg("success", "▸") : th.fg("dim", "○");
    const followColor = followedAgent.isLive ? "success" : "dim";
    const status = followedAgent.isLive ? "LIVE" : "IDLE";
    const followStatusColor = followedAgent.isLive ? "success" : "dim";
    followLine = `${followIcon} ${followedAgent.agent.padEnd(14)} [${th.fg(followStatusColor, status)}]`;
  }

  if (fleetState.phases.length === 0) {
    // ── IDLE ──
    const agentCount = discoverAgents("both").length;
    const statusIcon = fleetState.paused ? th.fg("warning", "⏸") : th.fg("muted", "●");
    const statusText = fleetState.paused ? "PAUSED" : "IDLE";
    const sc = fleetState.paused ? "warning" : "muted";
    const title = th.fg("accent", "CARAVEL FLEET");
    return [
      edge(`${title}  ${muted("│")}  ${th.fg(sc, statusIcon + " " + statusText)}`),
      edge(`[░░░░░░░░░░░░░░░░░░░░] 0%  ${muted("│")}  ${agentCount} agents configured  │  ${elapsed}`),
      followLine ? edge(th.fg("dim", `  ${followLine}`)) : edge(muted("  last: idle — no active work yet")),
      edge(`${th.fg("dim", `● ${fleetState.reviewIterations} reviews completed`)}  ${muted("│")}  ${muted(`Elapsed: ${elapsed}`)}`),
      edge(muted(`▸ fleet: ${formatTokens(fleetState.totalFleetTokens)}${followLine ? "  │  " + th.fg("dim", `followed: ${followedAgent.agent}`) : ""}`)),
    ];
  }

  // ── ACTIVE ──
  const phase = fleetState.phases[fleetState.currentPhaseIndex];
  const phaseLabel = phase
    ? th.fg("accent", `P${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}: ${phase.name}`)
    : th.fg("muted", "No current phase");

  const sIcon = phase
    ? phase.status === "complete" ? th.fg("success", "✓")
    : phase.status === "failed" ? th.fg("error", "✗")
    : (phase.status === "running" || phase.status === "reviewing") ? th.fg("accent", "▸")
    : th.fg("muted", "○")
    : th.fg("muted", "○");
  const sText = phase
    ? (phase.status === "complete" ? "DONE" : phase.status === "failed" ? "FAILED" : phase.status === "reviewing" ? "REV" : "RUN")
    : "UNKNOWN";
  const sColor = phase
    ? (phase.status === "complete" ? "success" : phase.status === "failed" ? "error" : "accent")
    : "muted";

  const filled = Math.round((progress / 100) * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);

  const ma = fleetState.mainAgentActivity;
  const activeAgentsList = fleetState.activeAgents.filter((a) => a.status !== "idle");
  let line3 = "";

  // ── Token usage line ──
  const totalInput = activeAgentsList.reduce((s, a) => s + (a.inputTokens || 0), 0);
  const totalOutput = activeAgentsList.reduce((s, a) => s + (a.outputTokens || 0), 0);
  const agentTokens = activeAgentsList.map((a) => {
    const name = a.name.length > 10 ? a.name.slice(0, 9) + "…" : a.name;
    const inp = formatTokens(a.inputTokens || 0);
    const out = formatTokens(a.outputTokens || 0);
    return `${name}(${inp}/${out})`;
  }).join("  │  ");
  const tokenLine = agentTokens
    ? `▸ tokens: ${formatTokens(totalInput)}i/${formatTokens(totalOutput)}o │ [${agentTokens}]`
    : `▸ fleet: ${formatTokens(fleetState.totalFleetTokens)}`;

  if (fleetState.paused) {
    line3 = muted("  ⏸ PAUSED");
  } else if (phase && (phase.status === "running" || phase.status === "reviewing")) {
    // Show per-task detail for running/reviewing phase
    const activeTasks = phase.tasks.filter((t) => t.status === "running" || t.status === "reviewing");
    const pendingTasks = phase.tasks.filter((t) => t.status === "pending");
    const taskDetails: string[] = [];

    activeTasks.forEach((t) => {
      const idx = phase.tasks.indexOf(t);
      const statusIcon = t.status === "reviewing" ? th.fg("accent", "◉") : th.fg("accent", "▸");
      const statusText = t.status === "reviewing" ? "REV" : "RUN";
      const statusColor = t.status === "reviewing" ? "accent" : "success";
      const truncatedDesc = truncate(t.description, 28);
      taskDetails.push(
        `${statusIcon} P${phase.tasks.indexOf(t) + 1} [${th.fg(statusColor, statusText)}] ${t.agentName}#${idx + 1} → ${truncatedDesc}`,
      );
    });

    // Show last completed task in the phase
    const lastComplete = [...phase.tasks].reverse().find((t) => t.status === "complete");
    if (lastComplete) {
      const idx = phase.tasks.indexOf(lastComplete);
      taskDetails.push(
        `  ${th.fg("success", "✓")} P${idx + 1} [OK] ${lastComplete.agentName}#${idx + 1} → ${truncate(lastComplete.description, 28)}`,
      );
    }

    // Show pending task that will run next
    if (pendingTasks.length > 0) {
      const next = pendingTasks[0];
      const idx = phase.tasks.indexOf(next);
      taskDetails.push(
        `  ${th.fg("muted", "○")} P${idx + 1} [WAIT] ${next.agentName}#${idx + 1} → ${truncate(next.description, 28)}`,
      );
    }

    line3 = taskDetails.join("  │  ");
    if (!line3) {
      line3 = muted("  idle — waiting for work");
    }
  } else if (ma && ma.action !== "idle" && (ma.status === "executing" || ma.status === "thinking")) {
    const actIcon = ma.status === "thinking" ? th.fg("dim", "◇") : th.fg("accent", "▸");
    line3 = `  ${actIcon} running: ${ma.action} → ${truncate(ma.detail, 20)}`;
  } else if (ma && ma.action !== "idle") {
    const age = now - ma.timestamp;
    const ts = age < 60000 ? `${Math.round(age / 1000)}s ago`
      : age < 3600000 ? `${Math.round(age / 60000)}m ago`
      : `${Math.round(age / 3600000)}h ago`;
    line3 = `  ▸ last: ${ma.action} → ${truncate(ma.detail, 20)}  (${ts})`;
  } else if (activeAgentsList.length > 0) {
    line3 = activeAgentsList.map((a) => {
      const model = a.model || "unknown";
      return `  ${th.fg("accent", "▸")} ${a.name} → ${model}`;
    }).join("  │  ");
  } else {
    line3 = muted("  idle — waiting for work");
  }

  // Build a follow output snippet to append to the last line
  let followOutput = "";
  if (followedAgent.agent) {
    const buf = agentOutputBuffers.get(`agent-${followedAgent.agent}`);
    if (buf && buf.stdout.trim()) {
      const lines = buf.stdout.trim().split("\n");
      const tail = lines.slice(-1).join(" ").trim().slice(-50);
      if (tail) {
        followOutput = `  │  ▸ follow: ${followedAgent.agent} → ${truncate(tail, 40)}`;
      }
    }
  }

  return [
    edge(`${th.fg("accent", "CARAVEL FLEET")}  ${muted("│")}  ${phaseLabel}  ${muted("│")}  ${th.fg(sColor, sIcon + " " + sText)}`),
    edge(`[${bar}] ${progress}%  ${muted("│")}  ${completedTasks}/${totalTasks} tasks  │  ${elapsed}`),
    edge(line3 + (followOutput ? followOutput : "")),
    edge(`${th.fg("dim", `${fleetState.reviewIterations} reviews`)}  ${muted("│")}  ${muted(`Elapsed: ${elapsed}`)}`),
    edge(tokenLine + (followLine ? `  │  ${followLine}` : "")),
  ];
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

    // Track per-agent token usage
    let agentInputTokens = 0;
    let agentOutputTokens = 0;

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
        onUpdate?.([{ type: "text", text: `  ▸ ${agentDef.name} (${agentDef.model || "unknown"}): ${truncate(chunk.slice(-60), 40)} [${formatTokens(lastTokenCount)} tokens]` }]);
      }
      // Capture agent output for follow
      const buf = agentOutputBuffers.get(agentKey);
      if (buf) buf.stdout += chunk;
      // Also route to followed agent buffer in real-time
      appendToFollowedAgent(agentDef.name, chunk);
    };

    const result = await runSubagent(agentDef, task.description, ctx.cwd, signal, taskProgressId, progressCb);
    agentInputTokens = result.usage?.input || 0;
    agentOutputTokens = result.usage?.output || 0;
    task.output = buildTaskOutput(result.output, result.stderr);
    task.stderr = result.stderr || "";
    task.status = result.exitCode === 0 ? "complete" as const : "failed" as const;
    task.agentModel = result.model;
    task.tokensUsed = result.usage.input + result.usage.output;
    task.messageCount = result.usage.turns;
    fleetState.recentOutput = result.output || result.stderr;

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
    // Permission denied or other error — stop this branch
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
    return {
      agent: { name: "none", description: "", model: "", tools: [], systemPrompt: "", source: "project" },
      task: failedTask,
      preFlight: { totalFiles: 0, totalDirs: 0, techStack: [], languages: [], frameworks: [], buildTools: [], hasTests: false, hasCI: false, configFileCount: 0, entryPoints: [], scanTimestamp: "" },
      output: "",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, contextTokens: 0, turns: 0 },
      elapsedMs: 0,
      errors: ["No analyzer agent configured. Add an 'auditor.md' or 'developer.md' agent to your agents/ directory with a valid model configured."],
      success: false,
    };
  }

  // ── Pre-flight codebase scan ──
  const scan = scanCodebase(ctx.cwd);

  const analysisTask: FleetTask = {
    id: generateId(),
    agentName: analyzer.name,
    description: "Perform a comprehensive codebase analysis: scan directory structure, detect tech stack, identify entry points, list dependencies, assess test coverage, and provide a structured analysis report.",
    status: "running" as const,
    reviewCount: 0,
    maxReviewCount: 3,
    metadata: { preFlight: scan },
  };

  const analysisPrompt = `You are analyzing an existing codebase at ${ctx.cwd}. Perform a thorough analysis:

## What to Analyze

1. **Project Structure**: List top-level directories and key files. Note the overall organization.
2. **Tech Stack**: Identify languages, frameworks, build tools, and dependencies from package files.
3. **Architecture**: Describe the overall pattern (MVC, monorepo, microservices, etc.)
4. **Entry Points**: Find main entry files (index.ts, main.ts, App.tsx, etc.)
5. **Dependencies**: List key packages from package.json, requirements.txt, Cargo.toml, etc.
6. **Test Coverage**: Identify test files, frameworks, and estimate coverage gaps.
7. **Configuration**: Note key config files (tsconfig, webpack, docker-compose, etc.) and their purpose.
8. **Technical Debt**: Identify code smells, outdated patterns, missing tests, and TODOs.
9. **Security**: Note any security concerns (hardcoded secrets, missing input validation, etc.).

## IMPORTANT: File Output
You MUST save your complete analysis report to the file "ANALYSIS.md" in the project root. Write it using the write tool.

## Provide Your Report In This Format:

# Codebase Analysis Report

## Overview
[language, framework, purpose in 2-3 sentences]

## Structure
[brief directory overview with purpose of each major directory]

## Tech Stack
- Languages: [language@version]
- Frameworks: [framework@version]
- Build Tools: [tool@version]
- Package Manager: [npm/pnpm/yarn/etc.]

## Architecture
[Detailed description of architectural patterns, module organization, data flow, layer boundaries]

## Entry Points
- [file path] — [purpose/role]

## Dependencies
### Production
- [package@version] — [purpose]
### Development
- [package@version] — [purpose]

## Test Coverage
- Framework: [name]
- Coverage estimate: [%]
- Key test files: [paths]
- Gaps: [what's missing]

## Technical Debt
- [Issue] → [file/path:line] — [impact]

## Security Findings
- [Issue] → [file/path] — [risk level]

## Recommendations
1. [Priority] Action — why + which files
2. [Priority] Action — why + which files`;

  const startTime = Date.now();

  // Capture output for follow
  const analysisKey = `agent-${analyzer.name}-analysis`;
  agentOutputBuffers.set(analysisKey, { stdout: "", stderr: "", running: true });
  const analysisOutputCb = (chunk: string) => {
    const buf = agentOutputBuffers.get(analysisKey);
    if (buf) buf.stdout += chunk;
    appendToFollowedAgent(analyzer.name, chunk);
  };

  try {
    const result = await runSubagent(analyzer, analysisPrompt, ctx.cwd, undefined, `analysis`, analysisOutputCb as any);
    const elapsed = Date.now() - startTime;

    analysisTask.status = result.exitCode === 0 && result.output?.trim().length > 0 ? "complete" : "failed";
    analysisTask.output = buildTaskOutput(result.output || "", result.stderr || "");
    analysisTask.stderr = result.stderr || "";
    analysisTask.reviewFeedback = result.stderr || "";
    fleetState.recentOutput = result.output || result.stderr || "";

    // Capture stderr
    const analysisBuf = agentOutputBuffers.get(analysisKey);
    if (analysisBuf) {
      analysisBuf.stdout += result.stderr || "";
      analysisBuf.running = false;
    }

    const tokens = {
      input: result.usage?.input || 0,
      output: result.usage?.output || 0,
      cacheRead: result.usage?.cacheRead || 0,
      cacheWrite: result.usage?.cacheWrite || 0,
      total: (result.usage?.input || 0) + (result.usage?.output || 0),
      cost: result.usage?.cost?.total || 0,
      contextTokens: result.usage?.contextTokens || 0,
      turns: result.usage?.turns || 0,
    };

    // Accumulate analysis tokens into fleet total
    fleetState.totalFleetTokens += tokens.total;

    if (result.exitCode === 0 && analysisTask.output) {
      // Persist the full analysis to ANALYSIS.md
      const analysisPath = path.join(ctx.cwd, "ANALYSIS.md");
      try {
        await fs.promises.writeFile(analysisPath, analysisTask.output.trim(), "utf-8");
      } catch {
        // Non-fatal — analysis text is still returned
      }
      return {
        agent: analyzer,
        task: analysisTask,
        preFlight: scan,
        output: analysisTask.output,
        tokens,
        elapsedMs: elapsed,
        errors: [],
        success: true,
      };
    }

    return {
      agent: analyzer,
      task: analysisTask,
      preFlight: scan,
      output: analysisTask.output || "(empty output)",
      tokens,
      elapsedMs: elapsed,
      errors: [
        result.stderr || `Exit code: ${result.exitCode}`,
        ...(result.exitCode !== 0 ? ["Subagent exited with non-zero code"] : []),
        ...(analysisTask.output ? [] : ["Subagent produced no output"]),
      ],
      success: false,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    analysisTask.status = "failed";
    analysisTask.output = "";
    analysisTask.stderr = String(err);
    analysisTask.reviewFeedback = String(err);

    return {
      agent: analyzer,
      task: analysisTask,
      preFlight: scan,
      output: "",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, contextTokens: 0, turns: 0 },
      elapsedMs: elapsed,
      errors: [String(err), `Failed to run ${analyzer.name} agent: ${analyzer.model || "no model configured"}`],
      success: false,
    };
  }
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

  lines.push(`# ${getProjectName(ctx.cwd)} — Design Document`);
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

  lines.push(`# ${planName} — Project Plan`);
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
        lines.push("║    /follow <agent>  — follow agent output             ║");
        lines.push("║    /follow switch   — toggle between running agents   ║");
        lines.push("║    /follow none     — stop following                  ║");
        lines.push("║    /follow list     — show this list                  ║");
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
        // Known agent — start following, buffer is empty until it runs
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

        const phaseResult = await runPhaseInternal(phaseIndex, ctx, undefined);
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
      const sep = th ? th.fg("dim", "─").repeat(52) : "─".repeat(52);
      const section = (title: string) => `${th ? th.fg("accent", `▸ ${title}`) : `▸ ${title}`}
  ${th ? th.fg("dim", sep) : sep}`;
      const metaLine = (label: string, value: string) => `  ${th ? th.fg("dim", "•") : "•"} ${th ? th.fg("dim", label) : label}: ${value}`;
      const scanLine = (label: string, value: string) => `  ${th ? th.fg("muted", "○") : "○"} ${th ? th.fg("dim", label) : label}: ${value}`;

      let response = "";

      // ── Header ──
      if (result.success) {
        response += `${th ? th.fg("success", "✅") : "✅"} Codebase Analysis Complete\n\n`;
      } else {
        response += `${th ? th.fg("warning", "⚠️") : "⚠️"} Analysis Encountered Issues\n\n`;
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
        response += `${result.errors.map((e, i) => `  ${th ? th.fg("error", `✗`) : "✗"} ${e}`).join("\n")}\n\n`;

        // Actionable guidance based on error content
        const guidance = buildErrorGuidance(result.errors);
        if (guidance) {
          response += `${th ? th.fg("accent", "💡 Suggestions"): "💡 Suggestions"}\n`;
          for (const tip of guidance) {
            response += `  ${th ? th.fg("muted", "→") : "→"} ${tip}\n`;
          }
          response += "\n";
        }
      }

      // ── Files produced ──
      if (result.success) {
        response += section("Files Produced");
        response += `  ${th ? th.fg("dim", "○") : "○"} [ANALYSIS.md](./ANALYSIS.md) — Full codebase analysis report\n`;
        response += `  ${th ? th.fg("dim", "○") : "○"} [PROJECT-DESIGN.md](./PROJECT-DESIGN.md) — Architecture & design overview\n`;
        response += "\n";
      }

      // ── Next steps ──
      if (result.success) {
        response += section("Next Steps");
        response += `  ${th ? th.fg("dim", "→") : "→"} Use ${th ? th.fg("accent", "plan_project()") : "plan_project()"} to create an implementation plan\n`;
        response += `  ${th ? th.fg("dim", "→") : "→"} Run ${th ? th.fg("accent", "/go") : "/go"} to execute the fleet\n`;
        response += `  ${th ? th.fg("dim", "→") : "→"} Read ${th ? th.fg("accent", "ANALYSIS.md") : "ANALYSIS.md"} for detailed findings\n\n`;
      }

      // ── Auto-generate PROJECT-DESIGN.md from analysis ──
      const designDoc = generateDesignDocument(result, ctx);
      const designPath = path.join(ctx.cwd, "PROJECT-DESIGN.md");
      try {
        await fs.promises.writeFile(designPath, designDoc, "utf-8");
      } catch {
        // Non-fatal — design doc generation is optional
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

      // ── Auto-generate PROJECT-PLAN.md from planning ──
      const planDoc = generatePlanDocument(params.name, phases, ctx);
      const planPath = path.join(ctx.cwd, "PROJECT-PLAN.md");
      try {
        await fs.promises.writeFile(planPath, planDoc, "utf-8");
      } catch {
        // Non-fatal — plan doc generation is optional
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

        // Track per-agent token usage
        let agentInputTokens = 0;
        let agentOutputTokens = 0;

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
            onUpdate?.({ content: [{ type: "text", text: `  ▸ ${agentDef.name} (${agentDef.model || "unknown"}): ${truncate(chunk.slice(-60), 40)} [${formatTokens(lastTokenCount)} tokens]` }] });
          }
          // Capture agent output for follow
          const buf2 = agentOutputBuffers.get(agentKey2);
          if (buf2) buf2.stdout += chunk;
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

    return { approved, feedback, agentUsed: "tech-lead", error: result.exitCode !== 0 || !feedback ? `Tech-lead agent exited with code ${result.exitCode}${!feedback ? " and produced no output" : ""}` : undefined, usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined };
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

    return { approved, feedback, agentUsed: "designer", error: result.exitCode !== 0 || !feedback ? `Designer agent exited with code ${result.exitCode}${!feedback ? " and produced no output" : ""}` : undefined, usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined };
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

    return { success: fixResult.exitCode === 0, error: fixResult.exitCode !== 0 ? `Developer agent exited with code ${fixResult.exitCode}` : undefined, usage: fixResult.usage ? { input: fixResult.usage.input, output: fixResult.usage.output } : undefined };
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

  // ---- /diagnose: fleet error diagnosis ----

  pi.registerCommand("diagnose", {
    description: "Diagnose fleet errors: missing agents, exit codes, stderr, token limits, and provide actionable fix steps",
    handler: async (_args, ctx) => {
      const diag = diagnoseFleetErrors();
      const th = ctx.ui.theme;
      const sep = th.fg("dim", "─").repeat(52);
      const section = (title: string) => `${th.fg("accent", `▸ ${title}`)}\n  ${th.fg("dim", sep)}`;
      const sevIcon = (s: string) => s === "critical" ? th.fg("error", "✗") : s === "warning" ? th.fg("warning", "⚠") : th.fg("dim", "○");

      let response = ``;

      // ── Header ──
      response += `${th.fg("dim", `CARAVEL FLEET ERROR DIAGNOSIS`)}\n${th.fg("dim", sep)}\n\n`;

      // ── Summary ──
      response += `${th.fg("accent", "📋 Summary")}\n\n`;
      response += `${diag.summary}\n\n`;

      // ── Affected phases ──
      if (diag.affectedPhases.length > 0) {
        response += `${section("Affected Phases")}\n`;
        for (const p of diag.affectedPhases) {
          const failedCount = p.tasks.filter((t) => t.status === "failed").length;
          const total = p.tasks.length;
          response += `  ${th.fg("error", "✗")} P${fleetState.phases.indexOf(p) + 1}: ${p.name} (${failedCount}/${total} failed)\n`;
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
            response += `      ${th.fg("dim", "→")} ${step}\n`;
          }
        }
        response += "\n";
      }

      // ── Overall action ──
      response += `${th.fg("accent", "💡 Overall Action")}\n`;
      response += `  ${th.fg("dim", "→")} ${diag.overallAction}\n\n`;

      // ── Quick commands ──
      response += `${section("Quick Commands")}\n`;
      response += `  ${th.fg("dim", "→")} /fleet — Toggle widget visibility\n`;
      response += `  ${th.fg("dim", "→")} fleet_status — Query current state\n`;
      if (diag.affectedPhases.length > 0) {
        const lastFailedIdx = fleetState.phases.indexOf(diag.affectedPhases[diag.affectedPhases.length - 1]);
        response += `  ${th.fg("dim", "→")} fleet_control(action="reset") — Reset fleet state\n`;
        response += `  ${th.fg("dim", "→")} fleet_control(action="next") — Move past failed phases\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Missing agent") || c.cause.includes("missing"))) {
        response += `  ${th.fg("accent", "→")} Create missing agent files in agents/ directory\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Token") || c.cause.includes("token"))) {
        response += `  ${th.fg("accent", "→")} Reduce task scope or switch to a larger-context model\n`;
      }
      response += "\n";

      return { content: [{ type: "text", text: response }] };
    },
  });

  pi.registerTool({
    name: "fleet_error_diagnosis",
    label: "Fleet Error Diagnosis",
    description: "Analyze fleet errors — missing agents, exit codes, stderr, token limits, rate limits — and provide actionable fix steps for each cause.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const diag = diagnoseFleetErrors();
      const th = ctx.ui.theme;
      const sep = th.fg("dim", "─").repeat(52);
      const section = (title: string) => `${th.fg("accent", `▸ ${title}`)}\n  ${th.fg("dim", sep)}`;
      const sevIcon = (s: string) => s === "critical" ? th.fg("error", "✗") : s === "warning" ? th.fg("warning", "⚠") : th.fg("dim", "○");

      let response = ``;

      response += `${th.fg("dim", `CARAVEL FLEET ERROR DIAGNOSIS`)}\n${th.fg("dim", sep)}\n\n`;
      response += `${th.fg("accent", "📋 Summary")}\n\n`;
      response += `${diag.summary}\n\n`;

      if (diag.affectedPhases.length > 0) {
        response += `${section("Affected Phases")}\n`;
        for (const p of diag.affectedPhases) {
          const failedCount = p.tasks.filter((t) => t.status === "failed").length;
          const total = p.tasks.length;
          response += `  ${th.fg("error", "✗")} P${fleetState.phases.indexOf(p) + 1}: ${p.name} (${failedCount}/${total} failed)\n`;
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
            response += `      ${th.fg("dim", "→")} ${step}\n`;
          }
        }
        response += "\n";
      }

      response += `${th.fg("accent", "💡 Overall Action")}\n`;
      response += `  ${th.fg("dim", "→")} ${diag.overallAction}\n\n`;

      response += `${section("Quick Commands")}\n`;
      response += `  ${th.fg("dim", "→")} /fleet — Toggle widget visibility\n`;
      response += `  ${th.fg("dim", "→")} fleet_status — Query current state\n`;
      if (diag.affectedPhases.length > 0) {
        response += `  ${th.fg("dim", "→")} fleet_control(action="reset") — Reset fleet state\n`;
        response += `  ${th.fg("dim", "→")} fleet_control(action="next") — Move past failed phases\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Missing agent") || c.cause.includes("missing"))) {
        response += `  ${th.fg("accent", "→")} Create missing agent files in agents/ directory\n`;
      }
      if (diag.causes.some(c => c.cause.includes("Token") || c.cause.includes("token"))) {
        response += `  ${th.fg("accent", "→")} Reduce task scope or switch to a larger-context model\n`;
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
        case "go": {
          if (fleetState.phases.length === 0) {
            return { content: [{ type: "text", text: "Fleet is idle. No phases defined. Use plan_project() first." }], details: {} };
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

            const phaseResult = await runPhaseInternal(phaseIndex, ctx, signal, onUpdate as any);
            results.push(phaseResult);

            const hasReviewableTasks = phase.tasks.some(
              (t) => t.status === "complete" || t.status === "needs_fix"
            );

            if (hasReviewableTasks) {
              results.push(`\n🔍 Reviewing Phase ${phaseIndex + 1}...`);
              const reviewResult = await runReviewInternal(phaseIndex, ctx, onUpdate as any);
              results.push(reviewResult);

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
        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
      }
    },

    promptSnippet: "Control fleet execution: pause, resume, skip, next, reset, or go",
  });

  // ============================================================================
  // /zellij-* commands — ZFS fleet session management
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

      // Check if session already exists
      const state = zfs.getFleetState();
      if (state.activePanes > 0 || state.activeProcesses > 0) {
        return {
          content: [{
            type: "text",
            text:
              `ZFS session "${state.sessionName}" is already running.\n` +
              `  Active panes: ${state.activePanes}\n` +
              `  Active processes: ${state.activeProcesses}\n` +
              `  Platform: ${state.platform.platform} (${state.platform.shell})\n\n` +
              `Use /zellij-stop to shut down, or /zellij-panes to list panes.`,
          }],
        };
      }

      // Discover available agents and create session
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
        summaryLines.push(`  ▸ ${agent.name.padEnd(14)} — ${agent.description.slice(0, 40)}`);
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
      lines.push(`║    Phases: ${fleetState.currentPhaseIndex + 1}/${fleetState.phases.length}  │  Progress: ${progress.padEnd(6)}  │  Elapsed: ${elapsed.padEnd(10)}║`);
      lines.push(`║    Tasks: ${completedTasks}/${totalTasks}  │  Reviews: ${fleetState.reviewIterations}  │  Tokens: ${formatTokens(fleetState.totalFleetTokens).padEnd(10)}║`);
      if (fleetState.paused) lines.push(`║    ⚠️  PAUSED                                              ║`);
      lines.push("║");
      lines.push("║  Commands:                                                ║");
      lines.push(`║    /zellij-panes  — This list                            ║`);
      lines.push(`║    /zellij-follow <name>  — Follow an agent              ║`);
      lines.push(`║    /zellij-status   — Fleet overview                     ║`);
      lines.push(`║    /zellij-start    — Start fleet session                ║`);
      lines.push(`║    /zellij-stop     — Stop fleet session                 ║`);
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
        lines.push(`║    /zellij-follow <agent>  — Follow agent output      ║`);
        lines.push(`║    /zellij-follow switch   — Cycle between agents    ║`);
        lines.push(`║    /zellij-follow none     — Stop following           ║`);
        lines.push(`║    /zellij-follow list     — Show this list           ║`);
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
        lines.push(`║    Progress: ${progress.padEnd(6)}  │  Tasks: ${completedTasks}/${totalTasks}  │  Elapsed: ${elapsed.padEnd(10)}║`);
        lines.push(`║    Reviews: ${fleetState.reviewIterations}  │  Tokens: ${formatTokens(fleetState.totalFleetTokens).padEnd(27)}║`);
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
      lines.push(`║    /zellij-start    — ${zfsRunning ? "Fleet already running" : "Start ZFS fleet".padEnd(30)}║`);
      lines.push(`║    /zellij-stop     — ${zfsRunning ? "Stop ZFS fleet" : "No session to stop".padEnd(28)}║`);
      lines.push(`║    /zellij-panes    — List all panes                    ║`);
      lines.push(`║    /zellij-follow   — Follow agent output               ║`);
      lines.push(`║    /zellij-status   — This overview                     ║`);
      lines.push(`║    /follow <agent>  — Follow agent (general)            ║`);
      lines.push(`║    /fleet           — Toggle widget bar                  ║`);
      lines.push(`║    /go              — Auto-orchestrate all phases        ║`);
      lines.push(`║    /diagnose        — Diagnose errors                    ║`);
      if (fleetState.phases.length > 0) {
        lines.push(`║    fleet_status      — Fleet status query               ║`);
        lines.push(`║    fleet_control(action="pause")  — Pause fleet         ║`);
        lines.push(`║    fleet_control(action="resume") — Resume fleet        ║`);
      }
      lines.push("╚═══════════════════════════════════════════════════════════╝");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { state, fleetState, zfs },
      };
    },
  });
}
