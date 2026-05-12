/**
 * Caravel Fleet — Zellij Process Manager
 *
 * Manages Zellij sessions and panes for fleet sub-agent execution.
 * Generates fleet layouts, spawns agent tasks in dedicated panes with
 * real-time stdout streaming, manages pane lifecycle, and routes
 * process signals for pause/resume/skip operations.
 *
 * Cross-platform: Windows (PowerShell/CMD) and Linux/macOS (bash/zsh).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, ChildProcess, SpawnOptions } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ZFSStatusBarManager,
  buildFleetSnapshot,
  type StatusBarFleetSnapshot,
} from "./zfs_status_bar";

// ============================================================================
// Constants
// ============================================================================

const FLEET_SESSION = "caravel";
const FLEET_LAYOUT_FILE = "zellij-layout.kdl";
const DEFAULT_PANE_WIDTH = 30;
const DEFAULT_PANE_HEIGHT = 20;
const PANE_ID_PREFIX = "caravel-pid-";

// ============================================================================
// Platform detection & shell resolution
// ============================================================================

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
    if (ps) {
      shell = "bash"; // WSL — use bash
    } else {
      const pwsh = process.env["PROMPT_COMMAND"] ?? process.env["COMSPEC"] ?? "";
      if (/powershell/i.test(pwsh)) {
        shell = "powershell";
      } else if (/cmd/i.test(pwsh) || process.env["COMSPEC"]) {
        shell = "cmd";
      } else {
        shell = "powershell";
      }
    }
  } else {
    const sh = process.env["SHELL"] ?? "";
    if (sh.includes("zsh")) shell = "zsh";
    else if (sh.includes("fish")) shell = "fish";
    else if (sh.includes("bash")) shell = "bash";
    else shell = "sh";
  }

  const shellMap: Record<string, { flag: string; arg: string }> = {
    bash: { flag: "-c", arg: "bash" },
    zsh: { flag: "-c", arg: "zsh" },
    fish: { flag: "-c", arg: "fish" },
    sh: { flag: "-c", arg: "sh" },
    cmd: { flag: "/c", arg: "cmd" },
    powershell: { flag: "-NoProfile", arg: "powershell" },
  };

  const config = shellMap[shell] ?? shellMap["bash"];

  return {
    platform: isWindows ? "windows" : (platform as "linux" | "macos" | "unix"),
    shell,
    shellArg: config.arg,
    shellFlag: config.flag,
    isWindows,
  };
}

function detectZellij(): boolean {
  return (
    checkCommand("zellij") ||
    checkCommand("zellij.exe")
  );
}

function checkCommand(cmd: string): boolean {
  try {
    if (os.platform() === "win32") {
      const proc = spawn("where", [cmd], { stdio: "ignore", shell: true });
      return new Promise<boolean>((resolve) => {
        proc.on("exit", (code) => resolve(code === 0));
      }) as unknown as boolean;
    } else {
      const proc = spawn("which", [cmd], { stdio: "ignore", shell: true });
      return new Promise<boolean>((resolve) => {
        proc.on("exit", (code) => resolve(code === 0));
      }) as unknown as boolean;
    }
  } catch {
    return false;
  }
}

// ============================================================================
// ZFS — ZFS pane state
// ============================================================================

interface ZFSPaneState {
  paneId: string;
  name: string;
  agent?: string;
  command: string;
  cwd?: string;
  running: boolean;
  exited: boolean;
  exitCode: number | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  partialLine: string;
  stdoutCallback: ((chunk: string) => void) | null;
  stderrCallback: ((chunk: string) => void) | null;
  process?: ChildProcess;
  abortController?: AbortController;
  startTime?: number;
  endTime?: number;
  pid?: number;
}

// ============================================================================
// ZFSLayout — KDL layout management
// ============================================================================

interface ZFSLayoutConfig {
  name: string;
  windowWidth: number; // percentage for left column
  rightWidth: number; // percentage for right column
  panes: Array<{
    name: string;
    type?: "main" | "agent" | "floating";
    align?: "left" | "right" | "floating";
    focus?: boolean;
    command?: string;
    args?: string[];
  }>;
}

function loadFleetLayout(projectRoot: string): ZFSLayoutConfig | null {
  const kdlPath = path.join(projectRoot, FLEET_LAYOUT_FILE);
  if (!fs.existsSync(kdlPath)) return null;

  const content = fs.readFileSync(kdlPath, "utf-8");
  const parsed = parseKDLLayout(content);
  return parsed;
}

/**
 * Parse a simplified subset of KDL layout for fleet panes.
 * Only extracts pane definitions from the primary window block.
 */
function parseKDLLayout(content: string): ZFSLayoutConfig | null {
  const result: ZFSLayoutConfig = {
    name: "fleet",
    windowWidth: 60,
    rightWidth: 40,
    panes: [],
  };

  // Extract layout name
  const nameMatch = content.match(/layout\s*\{\s*name:\s*"([^"]+)"/);
  if (nameMatch) result.name = nameMatch[1];

  // Extract window pane definitions
  const windowMatch = content.match(/window\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
  if (!windowMatch) return result;

  const windowBody = windowMatch[1];

  // Extract all pane blocks
  const paneRegex = /pane\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
  let paneMatch;
  while ((paneMatch = paneRegex.exec(windowBody)) !== null) {
    const block = paneMatch[1];
    const pane: ZFSLayoutConfig["panes"][number] = { name: "unnamed" };

    const nameM = block.match(/name:\s*"([^"]+)"/);
    if (nameM) pane.name = nameM[1];

    const typeM = block.match(/type:\s*"(\w+)"/);
    if (typeM) pane.type = typeM[1] as typeof pane.type;

    const alignM = block.match(/align:\s*"(\w+)"/);
    if (alignM) pane.align = alignM[1] as typeof pane.align;

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

/**
 * Generate a KDL layout string for the fleet session.
 * Optionally takes a custom layout config; falls back to defaults.
 */
function generateFleetLayout(
  agents: Array<{ name: string; description: string }>,
  customWidth?: number,
): string {
  const leftWidth = customWidth ?? 60;
  const rightWidth = 100 - leftWidth;

  const lines: string[] = [];
  lines.push("// ════════════════════════════════════════════════════════════");
  lines.push("// Caravel Fleet — Auto-generated Zellij Layout");
  lines.push("// ════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("window {");
  lines.push("");

  // Orchestrator pane (left)
  lines.push(`    pane {`);
  lines.push(`        type: "main"`);
  lines.push(`        align: "left"`);
  lines.push(`        size: ${leftWidth}`);
  lines.push(`        name: "orchestrator"`);
  lines.push(`        focus: true`);
  lines.push(`    }`);
  lines.push("");

  // Agent panes (right) — use max 5
  const agentPanes = agents.slice(0, 5);
  for (const agent of agentPanes) {
    lines.push(`    pane {`);
    lines.push(`        align: "right"`);
    lines.push(`        size: ${rightWidth}`);
    lines.push(`        name: "${agent.name}"`);
    lines.push(`    }`);
    lines.push("");
  }

  // Floating status bar
  lines.push(`    floating {`);
  lines.push(`        name: "status-bar"`);
  lines.push(`        y: "bottom"`);
  lines.push(`        x: "right"`);
  lines.push(`        max_width: 80`);
  lines.push(`        height: 10`);
  lines.push(`    }`);
  lines.push("");
  lines.push("}");

  return lines.join("\n");
}

// ============================================================================
// ZFSCommandBuilder — cross-platform command construction
// ============================================================================

interface CommandResult {
  cmd: string;
  args: string[];
  platform: PlatformInfo;
}

function buildZellijAction(action: string, args: string[]): CommandResult {
  const platform = detectPlatform();

  if (platform.isWindows) {
    // On Windows, use `zellij action` for remote control
    // Or `zellij` directly for session creation
    return {
      cmd: "zellij",
      args: [action, ...args],
      platform,
    };
  }

  return {
    cmd: "zellij",
    args: [action, ...args],
    platform,
  };
}

function buildPaneCommand(
  cwd: string,
  taskDescription: string,
  agentName: string,
  agentModel?: string,
): string {
  const platform = detectPlatform();
  const escapedDesc = taskDescription.replace(/"/g, '\\"').replace(/\$/g, "\\$");

  // The agent runs via the `pi` CLI (caravel subagent invocation)
  // We construct the command that spawns pi in this pane
  const piArgs = [
    "--mode", "json",
    "-p",
    "--no-session",
  ];
  if (agentModel) piArgs.push("--model", agentModel);

  const taskArg = `"${taskDescription}"`;

  if (platform.shell === "cmd") {
    return `chcp 65001 >nul & ${process.execPath} ${process.argv[1]} ${piArgs.join(" ")} ${taskArg}`;
  }

  if (platform.shell === "powershell") {
    return `${process.execPath} ${process.argv[1]} ${piArgs.join(" ")} ${taskArg}`;
  }

  // Unix: bash/zsh/sh/fish
  return `${process.execPath} ${process.argv[1]} ${piArgs.join(" ")} ${taskArg}`;
}

// ============================================================================
// ZFSProcess — wraps a child process with signal support
// ============================================================================

interface ZFSProcessState {
  running: boolean;
  exited: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  pid?: number;
  startTime: number;
  endTime?: number;
  abortController?: AbortController;
}

/**
 * Spawn a process with stdout/stderr streaming and signal support.
 * Returns a promise that resolves when the process exits.
 */
function spawnFleetProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    signal?: AbortSignal;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CARRAVEL_FLEET: "true",
        TERM: "xterm-256color",
      },
    });

    const state: ZFSProcessState = {
      running: true,
      exited: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      pid: proc.pid,
      startTime: Date.now(),
    };

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      state.stdout += text;
      stdoutBuf.push(text);
      if (options.onStdout) options.onStdout(text);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      state.stderr += text;
      stderrBuf.push(text);
      if (options.onStderr) options.onStderr(text);
    });

    proc.on("close", (code) => {
      state.exited = true;
      state.exitCode = code;
      state.endTime = Date.now();
      state.running = false;
      resolve({
        exitCode: code ?? 1,
        stdout: state.stdout,
        stderr: state.stderr,
      });
    });

    proc.on("error", (err) => {
      state.exited = true;
      state.running = false;
      resolve({
        exitCode: -1,
        stdout: state.stdout,
        stderr: state.stderr + "\n" + err.message,
      });
    });

    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          killProcessTree(proc.pid);
          state.running = false;
          state.exited = true;
        },
        { once: true },
      );
    }
  });
}

/**
 * Kill a process and its children (cross-platform).
 */
function killProcessTree(pid?: number): void {
  if (pid == null) return;
  if (os.platform() === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", shell: true });
    } catch { /* ignore */ }
  } else {
    try {
      // Kill the whole process group
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch { /* already dead */ }
    }
  }
}

// ============================================================================
// ZFS — Main Zellij Fleet Manager
// ============================================================================

class ZFS {
  private api: ExtensionAPI | null = null;
  private platform: PlatformInfo;
  private zellijAvailable: boolean;
  private cwd: string;
  private sessionName: string;
  private layoutConfig: ZFSLayoutConfig | null;
  private layoutPath: string;

  // Pane state management
  private panes: Map<string, ZFSPaneState> = new Map();
  private activeProcesses: Map<string, ZFSProcessState> = new Map();

  // Fleet coordination
  private paused: boolean = false;
  private skipAgent: string | null = null;

  // ── Status bar (ZFS mode overlay) ──
  private statusBarManager: ZFSStatusBarManager | null = null;
  private fleetStateGetter: (() => any) | null = null;
  private statusBarActive: boolean = false;

  constructor() {
    this.platform = detectPlatform();
    this.zellijAvailable = false;
    this.cwd = process.cwd();
    this.sessionName = FLEET_SESSION;
    this.layoutConfig = null;
    this.layoutPath = "";
    this.fleetStateGetter = null;

    // Initialize layout path
    this.layoutPath = path.join(this.cwd, FLEET_LAYOUT_FILE);
    if (fs.existsSync(this.layoutPath)) {
      const content = fs.readFileSync(this.layoutPath, "utf-8");
      this.layoutConfig = parseKDLLayout(content);
    }
  }

  // ── Initialization ──

  /**
   * Check if zellij is available and install if possible.
   */
  async checkAndInitZellij(): Promise<{ available: boolean; message: string }> {
    this.zellijAvailable = await this.checkZellij();
    if (this.zellijAvailable) {
      return { available: true, message: "Zellij detected — fleet process manager ready." };
    }
    return {
      available: false,
      message: "Zellij not found. Install from https://zellij.dev/tutorials/installation/ " +
        "or fleet execution will fall back to background processes.",
    };
  }

  private async checkZellij(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn(
        this.platform.isWindows ? "where" : "which",
        ["zellij"],
        { stdio: "pipe", shell: true },
      );
      let output = "";
      proc.stdout.on("data", (d) => { output += d.toString(); });
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => {
        // On Windows, 'where' returns 0 if found, 1 if not
        // On Unix, 'which' returns 0 if found, 1 if not
        // Also check if output is non-empty
        resolve(code === 0 && output.trim().length > 0);
      });
      proc.on("error", () => resolve(false));
      // Timeout after 2s
      setTimeout(() => resolve(false), 2000);
    });
  }

  /**
   * Set the working directory and load layout.
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.layoutPath = path.join(cwd, FLEET_LAYOUT_FILE);
    if (fs.existsSync(this.layoutPath)) {
      const content = fs.readFileSync(this.layoutPath, "utf-8");
      this.layoutConfig = parseKDLLayout(content);
    }
  }

  /**
   * Get the layout configuration.
   */
  getLayoutConfig(): ZFSLayoutConfig | null {
    return this.layoutConfig;
  }

  // ── Session Management ──

  /**
   * Create a new Zellij session with the fleet layout.
   * Returns the session name if successful.
   */
  async createSession(
    agentDefs: Array<{ name: string; description: string }>,
    cwd?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.zellijAvailable) {
      return {
        success: false,
        message: "Zellij is not installed. Cannot create session.",
      };
    }

    // Use layout from config or generate default
    let kdlContent: string;
    if (this.layoutConfig) {
      kdlContent = this.generateKDLFromConfig(agentDefs);
    } else {
      kdlContent = generateFleetLayout(agentDefs);
    }

    // Save layout to temp file for zellij to load
    const tmpLayout = path.join(os.tmpdir(), `caravel-fleet-${Date.now()}.kdl`);
    try {
      fs.writeFileSync(tmpLayout, kdlContent, "utf-8");
    } catch {
      return { success: false, message: "Failed to write layout file." };
    }

    // Kill existing session if any
    await this.killSession(this.sessionName);

    // Create new session — zellij will load the layout
    const cmd = this.platform.isWindows
      ? `zellij session create -s ${this.sessionName} --layout "${tmpLayout}"`
      : `zellij session create -s ${this.sessionName} --layout "${tmpLayout}"`;

    return new Promise((resolve) => {
      const proc = spawn(this.platform.shell, [this.platform.shellArg, cmd], {
        cwd: cwd ?? this.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        // Clean up temp file
        try { fs.unlinkSync(tmpLayout); } catch { /* ignore */ }

        if (code === 0) {
          // Initialize the floating pane status bar
          self.initStatusBar();
          resolve({
            success: true,
            message: `Zellij session "${this.sessionName}" created. Layout: ${kdlContent.includes("floating") ? "with status bar" : "without status bar"}`,
          });
        } else {
          resolve({
            success: false,
            message: `Failed to create session (exit ${code}): ${stderr.slice(0, 200)}`,
          });
        }
      });

      proc.on("error", () => {
        try { fs.unlinkSync(tmpLayout); } catch { /* ignore */ }
        // Clean up status bar on failure
        self.destroyStatusBar();
        resolve({ success: false, message: "Failed to spawn zellij." });
      });
    });
  }

  /**
   * Generate KDL from the loaded layout config.
   */
  private generateKDLFromConfig(
    agents: Array<{ name: string; description: string }>,
  ): string {
    if (!this.layoutConfig) {
      return generateFleetLayout(agents);
    }

    const lines: string[] = [];
    const cfg = this.layoutConfig;
    lines.push("// Caravel Fleet — Auto-generated from layout config");
    lines.push("window {");
    lines.push("");

    for (const pane of cfg.panes) {
      lines.push("    pane {");
      if (pane.type) lines.push(`        type: "${pane.type}"`);
      if (pane.align) lines.push(`        align: "${pane.align}"`);
      if (pane.focus) lines.push(`        focus: true`);
      lines.push(`        name: "${pane.name}"`);
      lines.push("    }");
      lines.push("");
    }

    lines.push("}");
    return lines.join("\n");
  }

  /**
   * Kill an existing Zellij session by name.
   */
  async killSession(sessionName: string): Promise<boolean> {
    if (!this.zellijAvailable) return false;

    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", ["kill-session", sessionName], {
        shell: true,
        stdio: "ignore",
      });
      proc.on("close", (code) => {
        resolve(code === 0 || code === null);
      });
      proc.on("error", () => resolve(false));
      setTimeout(() => {
        resolve(false);
      }, 3000);
    });
  }

  /**
   * Switch to the fleet session.
   */
  async switchToSession(): Promise<boolean> {
    if (!this.zellijAvailable) return false;

    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", ["switch-to-session", this.sessionName], {
        shell: true,
        stdio: "ignore",
      });
      proc.on("close", (code) => resolve(code === 0 || code === null));
      proc.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
  }

  /**
   * Detach from the fleet session (keeps it running).
   */
  async detachSession(): Promise<boolean> {
    if (!this.zellijAvailable) return false;

    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", ["detach"], {
        shell: true,
        stdio: "ignore",
      });
      proc.on("close", (code) => resolve(code === 0 || code === null));
      proc.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
  }

  // ── Pane Lifecycle ──

  /**
   * Spawn a sub-agent task in its own Zellij pane.
   * Returns the pane ID for lifecycle management.
   */
  async spawnPane(
    agentName: string,
    taskDescription: string,
    agentModel?: string,
    cwd?: string,
    onStdout?: (chunk: string, agentName: string) => void,
    onStderr?: (chunk: string, agentName: string) => void,
  ): Promise<{ success: boolean; paneId: string; message?: string }> {
    if (!this.zellijAvailable) {
      // Fall back: spawn as background process
      return this.spawnBackgroundProcess(agentName, taskDescription, agentModel, cwd, onStdout, onStderr);
    }

    const paneId = `${PANE_ID_PREFIX}${agentName}-${Date.now()}`;
    const paneCwd = (cwd ?? this.cwd) as string;
    const pane: ZFSPaneState = {
      paneId,
      name: agentName,
      agent: agentName,
      command: buildPaneCommand(paneCwd, taskDescription, agentName, agentModel ?? ""),
      cwd: paneCwd,
      running: true,
      exited: false,
      exitCode: null,
      stdoutBuffer: "",
      stderrBuffer: "",
      partialLine: "",
      stdoutCallback: onStderr ? null : null,
      stderrCallback: null,
      startTime: Date.now(),
    };

    if (onStdout) pane.stdoutCallback = (chunk: string) => onStdout(chunk, agentName);
    if (onStderr) pane.stderrCallback = (chunk: string) => onStderr(chunk, agentName);

    this.panes.set(paneId, pane);

    // Send zellij action to create the pane
    const result = await this.sendZellijAction("action", [
      "new-pane",
      "-s", this.sessionName,
      "-n", agentName,
      "-d", "floating", // floating pane for isolation
    ]);

    if (!result) {
      pane.running = false;
      pane.exited = true;
      this.panes.delete(paneId);
      return {
        success: false,
        paneId,
        message: `Failed to create pane in session "${this.sessionName}".`,
      };
    }

    return { success: true, paneId };
  }

  /**
   * Spawn a background process when Zellij is unavailable.
   */
  private async spawnBackgroundProcess(
    agentName: string,
    taskDescription: string,
    agentModel?: string,
    cwd?: string,
    onStdout?: (chunk: string, agentName: string) => void,
    onStderr?: (chunk: string, agentName: string) => void,
  ): Promise<{ success: boolean; paneId: string }> {
    const paneId = `${PANE_ID_PREFIX}${agentName}-bg-${Date.now()}`;
    const bgCwd = (cwd ?? this.cwd) as string;
    const processCommand = buildPaneCommand(bgCwd, taskDescription, agentName, agentModel ?? "");

    const state: ZFSProcessState = {
      running: true,
      exited: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      startTime: Date.now(),
    };

    this.activeProcesses.set(paneId, state);

    const args = this.platform.shell === "cmd"
      ? ["/c", processCommand]
      : [this.platform.shellArg, processCommand];

    spawn(this.platform.shell, args, {
      cwd: cwd ?? this.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CARRAVEL_FLEET: "true",
        CARRAVEL_PANE_ID: paneId,
        TERM: "xterm-256color",
      },
    }).on("close", (code) => {
      state.exited = true;
      state.exitCode = code;
      state.running = false;
      state.endTime = Date.now();
      this.activeProcesses.delete(paneId);
    }).on("error", () => {
      state.exited = true;
      state.running = false;
      this.activeProcesses.delete(paneId);
    });

    return { success: true, paneId };
  }

  /**
   * Send a zellij action command.
   */
  private async sendZellijAction(
    action: string,
    extraArgs: string[] = [],
  ): Promise<boolean> {
    if (!this.zellijAvailable) return false;

    return new Promise<boolean>((resolve) => {
      const proc = spawn("zellij", [action, ...extraArgs], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        resolve(code === 0 || code === null);
      });
      proc.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });
  }

  /**
   * Stop a pane by killing its process.
   */
  async stopPane(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (pane) {
      if (pane.process) {
        try {
          killProcessTree(pane.process.pid);
        } catch { /* ignore */ }
        pane.running = false;
        pane.exited = true;
        pane.endTime = Date.now();
      }
      this.panes.delete(paneId);
    }

    const proc = this.activeProcesses.get(paneId);
    if (proc) {
      proc.abortController?.abort();
      if (proc.pid) killProcessTree(proc.pid);
      proc.exited = true;
      this.activeProcesses.delete(paneId);
    }

    // Try zellij kill-pane
    return this.sendZellijAction("action", ["close-pane", "-s", this.sessionName]);
  }

  /**
   * Follow a pane's output (subscribe to real-time stdout).
   */
  followPane(paneId: string, onOutput: (chunk: string, paneName: string) => void): boolean {
    const pane = this.panes.get(paneId);
    if (!pane || !pane.running) return false;

    pane.stdoutCallback = (chunk: string) => {
      onOutput(chunk, pane.name);
    };
    return true;
  }

  /**
   * Unfollow a pane (unsubscribe from stdout).
   */
  unfollowPane(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;

    pane.stdoutCallback = null;
    return true;
  }

  /**
   * Resize a pane to specific dimensions.
   */
  async resizePane(paneId: string, width: number, height: number): Promise<boolean> {
    if (!this.zellijAvailable) return false;

    // Zellij doesn't have a direct resize-pane action.
    // We simulate by sending the resize through the action API.
    return this.sendZellijAction("action", [
      "resize",
      "increase",
      "-s", this.sessionName,
      "-n", paneId,
    ]);
  }

  /**
   * Get the status of a pane.
   */
  getPaneStatus(paneId: string): ZFSPaneState | null {
    return this.panes.get(paneId) ?? null;
  }

  /**
   * List all active panes.
   */
  listPanes(): Array<{
    paneId: string;
    name: string;
    agent?: string;
    running: boolean;
    exited: boolean;
    exitCode: number | null;
  }> {
    return Array.from(this.panes.values()).map((p) => ({
      paneId: p.paneId,
      name: p.name,
      agent: p.agent,
      running: p.running,
      exited: p.exited,
      exitCode: p.exitCode,
    }));
  }

  // ── Status Bar Management (ZFS mode) ──

  /**
   * Set the fleet state getter callback for status bar rendering.
   * Called by caravel.ts to inject the fleet state.
   */
  setFleetStateGetter(getter: () => any): void {
    this.fleetStateGetter = getter;
  }

  /**
   * Get the current platform info.
   */
  getPlatformInfo(): PlatformInfo {
    return this.platform;
  }

  /**
   * Initialize the status bar manager.
   * Creates the floating pane status bar for monitoring.
   */
  initStatusBar(): void {
    if (!this.zellijAvailable || this.statusBarManager) return;

    const floatingPaneName = "status-bar";
    const sessionName = this.sessionName;
    const cwd = this.cwd;

    this.statusBarManager = new ZFSStatusBarManager({
      floatingPaneName,
      sessionName,
      cwd,
      getFleetState: () => {
        if (!this.fleetStateGetter) return null;
        const fleetState = this.fleetStateGetter();
        if (!fleetState) return null;

        // Build snapshot from caravel.ts fleet state
        const hasPhases = (fleetState as any).phases && Array.isArray((fleetState as any).phases);
        const hasActiveAgents = (fleetState as any).activeAgents && Array.isArray((fleetState as any).activeAgents);
        const hasCurrentPhaseIndex = (fleetState as any).currentPhaseIndex != null;
        const hasPaused = (fleetState as any).paused != null;
        const hasStartTime = (fleetState as any).startTime != null;
        const hasReviewIterations = (fleetState as any).reviewIterations != null;
        const hasTotalFleetTokens = (fleetState as any).totalFleetTokens != null;
        const hasMainAgentActivity = (fleetState as any).mainAgentActivity != null;

        if (!hasPhases || !hasActiveAgents || !hasCurrentPhaseIndex ||
            !hasPaused || !hasStartTime || !hasReviewIterations ||
            !hasTotalFleetTokens) {
          return null;
        }

        const fsState = fleetState as any;
        const now = Date.now();

        // Get last action info
        const lastAction = (fsState.mainAgentActivity && fsState.mainAgentActivity.action !== "idle")
          ? fsState.mainAgentActivity.action
          : "idle";

        let lastActionAgo = "";
        if (fsState.mainAgentActivity && fsState.mainAgentActivity.timestamp) {
          const age = now - fsState.mainAgentActivity.timestamp;
          const secs = Math.floor(age / 1000);
          const mins = Math.floor(secs / 60);
          if (mins > 0) {
            lastActionAgo = `${mins}m ago`;
          } else {
            lastActionAgo = `${secs}s ago`;
          }
        }

        return buildFleetSnapshot({
          phases: fsState.phases,
          currentPhaseIndex: fsState.currentPhaseIndex,
          activeAgents: fsState.activeAgents,
          paused: fsState.paused,
          startTime: fsState.startTime || now,
          reviewIterations: fsState.reviewIterations,
          totalFleetTokens: fsState.totalFleetTokens,
          mainAgentActivity: fsState.mainAgentActivity,
          zfsActive: true,
          zfsSessionActive: this.zellijAvailable,
          lastAction,
          lastActionAgo,
        });
      },
      getPlatformInfo: () => {
        return {
          shell: this.platform.shell,
          isWindows: this.platform.isWindows,
          platform: this.platform.platform,
        };
      },
    });

    this.statusBarActive = true;
  }

  /**
   * Destroy the status bar.
   */
  destroyStatusBar(): void {
    if (this.statusBarManager) {
      this.statusBarManager.stop();
      this.statusBarManager = null;
    }
    this.statusBarActive = false;
  }

  /**
   * Refresh the floating pane status bar.
   */
  refreshStatusBar(): void {
    if (this.statusBarManager && this.statusBarActive) {
      this.statusBarManager.update();
    }
  }

  /**
   * Get status bar info for tools.
   */
  getStatusBarInfo(): {
    active: boolean;
    available: boolean;
    session: string;
    pane: string;
  } {
    return {
      active: this.statusBarActive && this.zellijAvailable,
      available: this.zellijAvailable,
      session: this.sessionName,
      pane: "status-bar",
    };
  }

  // ── Process Signal Management (pause/resume/skip) ──

  /**
   * Pause all running panes (SIGSTOP).
   */
  async pauseAll(): Promise<boolean> {
    this.paused = true;

    for (const [, pane] of this.panes) {
      if (pane.process && pane.running) {
        try {
          if (os.platform() === "win32") {
            // Windows doesn't support SIGSTOP directly
            // Pause by pausing the process on Windows
            spawn("wmic", ["process", "where", `processid=${pane.process.pid}`, "call", "suspend"], {
              stdio: "ignore",
              shell: true,
            });
          } else {
            process.kill(pane.process.pid, "SIGSTOP");
          }
        } catch { /* ignore */ }
      }
    }

    // Also pause background processes
    for (const [, proc] of this.activeProcesses) {
      proc.abortController?.abort();
    }

    return true;
  }

  /**
   * Resume all paused panes (SIGCONT).
   */
  async resumeAll(): Promise<boolean> {
    this.paused = false;
    this.skipAgent = null;

    for (const [, pane] of this.panes) {
      if (pane.process && !pane.running) {
        // Pane was paused — need to restart it
        // For SIGSTOP'd processes, we can resume if still alive
        try {
          process.kill(pane.process.pid, "SIGCONT");
        } catch {
          // Process already dead — would need to be re-spawned
          pane.exited = true;
        }
      }
    }

    // Resume background processes
    for (const [, proc] of this.activeProcesses) {
      // Can't resume an aborted signal — processes need to be re-spawned
    }

    return true;
  }

  /**
   * Skip (terminate) a specific agent's pane.
   */
  skipPane(agentName: string): boolean {
    this.skipAgent = agentName;

    // Find and stop the pane for this agent
    for (const [paneId, pane] of this.panes) {
      if (pane.agent === agentName && pane.running) {
        pane.exited = true;
        pane.running = false;
        pane.endTime = Date.now();
        if (pane.process) {
          killProcessTree(pane.process.pid);
        }
      }
    }

    // Also kill background processes for this agent
    for (const [paneId, proc] of this.activeProcesses) {
      if (paneId.includes(agentName)) {
        proc.abortController?.abort();
        if (proc.pid) killProcessTree(proc.pid);
      }
    }

    return true;
  }

  /**
   * Send a signal to a specific pane.
   */
  async sendSignalToPane(paneId: string, signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGSTOP" | "SIGCONT"): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane) return false;

    const sigNum = {
      SIGTERM: 15,
      SIGKILL: 9,
      SIGINT: 2,
      SIGSTOP: 19,
      SIGCONT: 18,
    }[signal];

    if (pane.process && pane.running) {
      try {
        process.kill(pane.process.pid, signal as "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGSTOP" | "SIGCONT");
      } catch {
        return false;
      }
    }

    // Also try via zellij
    return this.sendZellijAction("action", [
      "send-key",
      "-s", this.sessionName,
      "-n", pane.name,
      `${signal}`,
    ]);
  }

  /**
   * Get fleet state summary.
   */
  getFleetState(): {
    zellijAvailable: boolean;
    paused: boolean;
    sessionName: string;
    activePanes: number;
    exitedPanes: number;
    activeProcesses: number;
    platform: PlatformInfo;
  } {
    return {
      zellijAvailable: this.zellijAvailable,
      paused: this.paused,
      sessionName: this.sessionName,
      activePanes: Array.from(this.panes.values()).filter((p) => p.running).length,
      exitedPanes: Array.from(this.panes.values()).filter((p) => p.exited).length,
      activeProcesses: this.activeProcesses.size,
      platform: this.platform,
    };
  }

  // ── Cleanup ──

  /**
   * Clean up all panes and processes.
   */
  async cleanup(): Promise<void> {
    // Stop all active panes
    for (const paneId of Array.from(this.panes.keys())) {
      const pane = this.panes.get(paneId);
      if (pane && pane.running) {
        if (pane.process) {
          try {
            killProcessTree(pane.process.pid);
          } catch { /* ignore */ }
        }
        pane.running = false;
        pane.exited = true;
        pane.endTime = Date.now();
      }
    }
    this.panes.clear();

    // Abort all background processes
    for (const [, proc] of this.activeProcesses) {
      proc.abortController?.abort();
      if (proc.pid) killProcessTree(proc.pid);
    }
    this.activeProcesses.clear();

    // Kill the session
    await this.killSession(this.sessionName);

    // Clean up status bar
    this.destroyStatusBar();
  }

  // ── Extension integration ──

  /**
   * Register extension hooks with the pi API.
   * This is called after the instance is created.
   */
  registerExtension(pi: ExtensionAPI): void {
    this.api = pi;
  }

  /**
   * Register all tools, commands, and event hooks.
   * Called after registerExtension to capture `this` properly.
   */
  registerHook(pi: ExtensionAPI): void {
    const self = this;

    pi.on("session_start", async (_event, ctx) => {
      self.setCwd(ctx.cwd);
      const init = await self.checkAndInitZellij();
      if (init.available) {
        ctx.ui.notify("ZFS: Zellij detected — fleet process manager ready", "info");
        // Try to initialize status bar if a session already exists
        self.initStatusBar();
      } else {
        ctx.ui.notify(`ZFS: ${init.message}`, "warning");
      }
    });

    pi.on("session_shutdown", async () => {
      await self.cleanup();
    });

    // ── zfs_create_session ──
    pi.registerTool({
      name: "zfs_create_session",
      label: "ZFS Create Session",
      description: "Create a Zellij session with the fleet layout for sub-agent execution.",
      parameters: Type.Object({
        agents: Type.Array(Type.Object({
          name: Type.String({ description: "Agent name" }),
          description: Type.String({ description: "Agent description" }),
        })),
      }),
      execute: async (_toolCallId, params: any, _signal, onUpdate, ctx) => {
        self.setCwd(ctx.cwd);
        const result = await self.createSession(params.agents);
        onUpdate?.({ content: [{ type: "text", text: result.message }] });
        return {
          content: [{ type: "text", text: result.message }],
          details: { success: result.success },
        };
      },
      promptSnippet: "Create a ZFS fleet session with the given agents",
    });

    // ── zfs_spawn_pane ──
    pi.registerTool({
      name: "zfs_spawn_pane",
      label: "ZFS Spawn Pane",
      description: "Spawn a sub-agent task in a dedicated Zellij pane with real-time stdout streaming.",
      parameters: Type.Object({
        agentName: Type.String({ description: "Agent name for the pane" }),
        taskDescription: Type.String({ description: "Task to execute in the pane" }),
        agentModel: Type.Optional(Type.String({ description: "Model to use for this agent" })),
        cwd: Type.Optional(Type.String({ description: "Working directory" })),
      }),
      execute: async (_toolCallId, params: any, _signal, onUpdate, ctx) => {
        self.setCwd(ctx.cwd);
        const result = await self.spawnPane(
          params.agentName,
          params.taskDescription,
          params.agentModel,
          params.cwd,
          (chunk: string, agentName: string) => {
            onUpdate?.({ content: [{ type: "text", text: `  [${agentName}] ${chunk.slice(0, 120)}` }] });
          },
        );
        return {
          content: [{ type: "text", text: result.success
            ? `Pane "${result.paneId}" spawned for agent "${params.agentName}"`
            : `Failed to spawn pane: ${result.message}` }],
          details: { paneId: result.paneId, success: result.success },
        };
      },
      promptSnippet: "Spawn a sub-agent in a dedicated ZFS pane",
    });

    // ── zfs_stop_pane ──
    pi.registerTool({
      name: "zfs_stop_pane",
      label: "ZFS Stop Pane",
      description: "Stop (terminate) a sub-agent pane by its ID.",
      parameters: Type.Object({
        paneId: Type.String({ description: "Pane ID to stop" }),
      }),
      execute: async (_toolCallId, params: any, _signal, _onUpdate, ctx) => {
        const result = await self.stopPane(params.paneId);
        return {
          content: [{ type: "text", text: result
            ? `Pane "${params.paneId}" stopped.`
            : `Pane "${params.paneId}" not found or already stopped.` }],
          details: { paneId: params.paneId, success: result },
        };
      },
      promptSnippet: "Stop a ZFS pane",
    });

    // ── zfs_fleet_state ──
    pi.registerTool({
      name: "zfs_fleet_state",
      label: "ZFS Fleet State",
      description: "Get the current fleet state: ZFS availability, pane counts, session info, platform.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const state = self.getFleetState();
        return {
          content: [{
            type: "text",
            text: `ZFS Fleet State:\n` +
              `  Zellij: ${state.zellijAvailable ? "✓ available" : "✗ unavailable"}\n` +
              `  Session: ${state.sessionName}\n` +
              `  Paused: ${state.paused}\n` +
              `  Active panes: ${state.activePanes}\n` +
              `  Exited panes: ${state.exitedPanes}\n` +
              `  Active processes: ${state.activeProcesses}\n` +
              `  Platform: ${state.platform.platform} (${state.platform.shell})\n` +
              `  Shell: ${state.platform.shellArg} (${state.platform.shellFlag})`,
          }],
          details: { state },
        };
      },
      promptSnippet: "Query ZFS fleet state",
    });

    // ── zfs_pause ──
    pi.registerTool({
      name: "zfs_pause",
      label: "ZFS Pause",
      description: "Pause all running panes (SIGSTOP / Windows equivalent).",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const result = await self.pauseAll();
        return {
          content: [{ type: "text", text: result ? "All panes paused." : "Failed to pause panes." }],
          details: { paused: result },
        };
      },
      promptSnippet: "Pause all fleet panes",
    });

    // ── zfs_resume ──
    pi.registerTool({
      name: "zfs_resume",
      label: "ZFS Resume",
      description: "Resume all paused panes (SIGCONT).",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const result = await self.resumeAll();
        return {
          content: [{ type: "text", text: result ? "All panes resumed." : "Failed to resume panes." }],
          details: { resumed: result },
        };
      },
      promptSnippet: "Resume all fleet panes",
    });

    // ── zfs_skip_agent ──
    pi.registerTool({
      name: "zfs_skip_agent",
      label: "ZFS Skip Agent",
      description: "Skip (terminate) a specific agent's pane.",
      parameters: Type.Object({
        agentName: Type.String({ description: "Agent name to skip" }),
      }),
      execute: async (_toolCallId, params: any, _signal, _onUpdate, ctx) => {
        const result = self.skipPane(params.agentName);
        return {
          content: [{
            type: "text",
            text: result
              ? `Agent "${params.agentName}" skipped — pane terminated.`
              : `Agent "${params.agentName}" not found running.`,
          }],
          details: { agent: params.agentName, skipped: result },
        };
      },
      promptSnippet: "Skip a specific agent",
    });

    // ── zfs_list_panes ──
    pi.registerTool({
      name: "zfs_list_panes",
      label: "ZFS List Panes",
      description: "List all active and exited panes in the fleet session.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const panes = self.listPanes();
        const lines = panes.map((p) =>
          `  ${p.running ? "▸" : "✗"} ${p.name} (${p.paneId}) ${p.running ? "[running]" : `[exited:${p.exitCode ?? "?"}]`}`,
        );
        return {
          content: [{
            type: "text",
            text: lines.length > 0
              ? `Active panes:\n${lines.join("\n")}`
              : "No panes registered.",
          }],
          details: { panes },
        };
      },
      promptSnippet: "List all fleet panes",
    });

    // ── zfs_status_bar_info ──
    pi.registerTool({
      name: "zfs_status_bar_info",
      label: "ZFS Status Bar Info",
      description: "Get the current status bar state: whether it's active, available, session info, and pane name.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        self.initStatusBar();
        const info = self.getStatusBarInfo();
        return {
          content: [{
            type: "text",
            text: `ZFS Status Bar:\n` +
              `  Active: ${info.active ? "✓ yes" : "○ no"}\n` +
              `  Available: ${info.available ? "✓ yes" : "○ no"}\n` +
              `  Session: ${info.session}\n` +
              `  Pane: ${info.pane}`,
          }],
          details: { statusbar: info },
        };
      },
      promptSnippet: "Query ZFS status bar state",
    });

    // ── zfs_status_bar_update ──
    pi.registerTool({
      name: "zfs_status_bar_update",
      label: "ZFS Status Bar Update",
      description: "Force an immediate update of the floating pane status bar. Use after fleet state changes to refresh the display.",
      parameters: Type.Object({
        refresh: Type.Optional(Type.Boolean({ description: "Whether to refresh the status bar (default: true)" })),
      }),
      execute: async (_toolCallId, params: any, _signal, onUpdate, ctx) => {
        self.setCwd(ctx.cwd);
        const doRefresh = params.refresh ?? true;

        if (!self.zellijAvailable) {
          return {
            content: [{
              type: "text",
              text: "ZFS not available. Status bar cannot be updated.\nInstall Zellij: https://zellij.dev/tutorials/installation/",
            }],
            details: { updated: false, reason: "zfs_unavailable" },
          };
        }

        // Ensure status bar is initialized
        self.initStatusBar();

        if (doRefresh) {
          self.refreshStatusBar();
        }

        return {
          content: [{
            type: "text",
            text: doRefresh
              ? "Status bar updated and sent to floating pane."
              : "Status bar initialized. Call zfs_status_bar_update with refresh=true to update.",
          }],
          details: { updated: true, refreshed: doRefresh },
        };
      },
      promptSnippet: "Update the ZFS floating pane status bar",
    });

    // ── zfs_status_bar_render ──
    pi.registerTool({
      name: "zfs_status_bar_render",
      label: "ZFS Status Bar Render",
      description: "Render the status bar as text (for debugging or logging). Shows current fleet state in the status bar format.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, onUpdate, ctx) => {
        self.setCwd(ctx.cwd);

        if (!self.zellijAvailable) {
          return {
            content: [{
              type: "text",
              text: "ZFS not available. Cannot render status bar.",
            }],
            details: { rendered: false, reason: "zfs_unavailable" },
          };
        }

        self.initStatusBar();
        const rendered = self.statusBarManager?.getLastRendered() || "[status bar not yet rendered]";

        return {
          content: [{
            type: "text",
            text: `--- ZFS Status Bar ---\n\n${rendered}\n\n---\nRendered at: ${new Date().toISOString()}`,
          }],
          details: { rendered: true },
        };
      },
      promptSnippet: "Render the ZFS status bar as text",
    });

    // ── zfs_status_bar_toggle ──
    pi.registerTool({
      name: "zfs_status_bar_toggle",
      label: "ZFS Status Bar Toggle",
      description: "Toggle the floating pane status bar on/off. When ZFS is active, the status bar shows fleet-wide agent status, progress, and token usage.",
      parameters: Type.Object({
        enabled: Type.Optional(Type.Boolean({ description: "True to enable, false to disable, or omit to toggle" })),
      }),
      execute: async (_toolCallId, params: any, _signal, onUpdate, ctx) => {
        self.setCwd(ctx.cwd);
        const info = self.getStatusBarInfo();
        if (!info.available) {
          return {
            content: [{
              type: "text",
              text: "ZFS not available — status bar requires Zellij installed.\nInstall from: https://zellij.dev/tutorials/installation/",
            }],
            details: { toggled: false, reason: "zfs_unavailable" },
          };
        }

        self.initStatusBar();

        // Toggle or set
        const targetOn = params.enabled ?? !info.active;
        if (targetOn) {
          self.initStatusBar();
          self.refreshStatusBar();
          return {
            content: [{
              type: "text",
              text: "Status bar enabled — showing fleet status in floating pane.",
            }],
            details: { toggled: true, enabled: true },
          };
        } else {
          self.destroyStatusBar();
          return {
            content: [{
              type: "text",
              text: "Status bar disabled — floating pane closed.",
            }],
            details: { toggled: true, enabled: false },
          };
        }
      },
      promptSnippet: "Toggle the ZFS floating pane status bar",
    });

    // ── zfs_layout ──
    pi.registerTool({
      name: "zfs_layout",
      label: "ZFS Layout",
      description: "Generate or view the fleet Zellij layout configuration.",
      parameters: Type.Object({
        agents: Type.Array(Type.Object({
          name: Type.String({ description: "Agent name" }),
          description: Type.String({ description: "Agent description" }),
        })),
        customWidth: Type.Optional(Type.Number({ description: "Left column width percentage" })),
        preview: Type.Optional(Type.Boolean({ description: "Preview the KDL layout string" })),
      }),
      execute: async (_toolCallId, params: any, _signal, onUpdate, ctx) => {
        self.setCwd(ctx.cwd);
        const kdl = generateFleetLayout(params.agents, params.customWidth);

        if (params.preview) {
          onUpdate?.({ content: [{ type: "text", text: `--- KDL Layout ---\n${kdl}` }] });
        }

        // Save to project root
        const layoutPath = path.join(ctx.cwd, FLEET_LAYOUT_FILE);
        try {
          await fs.promises.writeFile(layoutPath, kdl, "utf-8");
        } catch { /* ignore */ }

        return {
          content: [{
            type: "text",
            text: `Fleet layout generated (${params.agents.length} agents, left:${params.customWidth ?? 60}%)\n` +
              `Saved to: ${layoutPath}\n\n` +
              `Run: zellij session create -s caravel --layout ${layoutPath}`,
          }],
          details: { layout: kdl, savedPath: layoutPath },
        };
      },
      promptSnippet: "Generate fleet Zellij layout",
    });
  }
}

// ============================================================================
// Export ZFS class for use by other extensions (e.g. caravel.ts)
// ============================================================================

export { ZFS, ZFSPaneState, ZFSLayoutConfig, PlatformInfo };

// ============================================================================
// Extension entry point
// ============================================================================

export default function zellijFleet(pi: ExtensionAPI) {
  const zfs = new ZFS();
  zfs.registerExtension(pi);
  zfs.registerHook(pi);
}
