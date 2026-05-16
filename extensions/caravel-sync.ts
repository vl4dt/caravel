/**
 * Caravel ↔ Linear / Plane Bidirectional Sync
 *
 * Polls Linear and Plane for issues moved to "To Do" state, creates Caravel
 * projects/phases/tasks from them, and pushes results back as status updates
 * and comments on the external issue.
 *
 * ## Architecture
 *
 * 1. **Polling loop** — runs on a configurable interval (default 60s)
 * 2. **Issue detection** — finds issues moved to "To Do" since last poll
 * 3. **Caravel project creation** — creates a Linear Project or Plane Project
 * 4. **Phase/task mapping** — each issue → one task, grouped into a phase
 * 5. **Result pushback** — on task complete/fail: update Linear/Plane state
 *    + add comment with outcome details
 * 6. **State tracking** — `.caravel/sync-state.json` maps external → internal IDs
 *
 * ## Linear API
 * - GraphQL endpoint: https://api.linear.app/graphql
 * - State types: "todo" | "in_progress" | "done" | "cancelled"
 * - Projects = boards with states (columns)
 * - Issues have `state.type` for filtering
 *
 * ## Plane API
 * - REST endpoint: https://app.plane.so/api/v1/
 * - Issue states: "backlog" | "unstarted" | "started" | "completed" | "cancelled"
 * - Projects have cycles (sprints) and modules (milestones)
 */

import * as https from "https";
import * as http from "http";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Sync state persisted to `.caravel/sync-state.json`. */
export interface SyncState {
  /** Linear issues already processed (keyed by issue ID). */
  processedLinearIssues: Record<string, { phase: string; tasks: string[]; syncedAt: number }>;
  /** Plane issues already processed (keyed by issue ID). */
  processedPlaneIssues: Record<string, { phase: string; tasks: string[]; syncedAt: number }>;
  /** Reverse mapping: Caravel phase → source system. */
  phaseToSource: Record<string, { system: "linear" | "plane"; projectId: string; phase: string }>;
  /** Last poll timestamps. */
  lastPollAt: { linear?: number; plane?: number };
  /** Running pollers to manage lifecycle. */
  pollers: { linear?: { interval: NodeJS.Timeout; running: boolean }; plane?: { interval: NodeJS.Timeout; running: boolean } };
}

/** Configuration for Linear sync. */
export interface LinearSyncConfig {
  enabled: boolean;
  apiKey: string;
  teamIds: string[];          // Teams to poll for "To Do" issues
  teamId?: string;            // Legacy single team (backwards compat)
  projectTemplate?: {
    name: string;             // Name template for auto-created projects (%DATE% will be replaced)
    description: string;
    stateId: string;          // Starting state for new issues
  };
  pollIntervalSec: number;    // How often to poll (default 60)
  createProjectAutomatically: boolean; // Auto-create Linear Project when new issues found
  labelFilter?: string;       // Optional: only sync issues with this label
}

/** Configuration for Plane sync. */
export interface PlaneSyncConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;            // e.g. "https://app.plane.so" or self-hosted URL
  workspaceSlug: string;      // Workspace to poll
  projectSlug?: string;       // Only sync issues from this project (optional)
  stateFilter: string;        // State to watch for "To Do" (default "unstarted")
  pollIntervalSec: number;
  createProjectAutomatically: boolean;
}

/** Combined sync configuration. */
export interface CaravelSyncConfig {
  linear: LinearSyncConfig;
  plane: PlaneSyncConfig;
}

/** Result of creating a Caravel phase from an external issue. */
export interface SyncIssueResult {
  success: boolean;
  caravelPhase?: string;      // Caravel phase name
  caravelTasks?: string[];    // Caravel task IDs
  externalIssueId?: string;   // Issue ID in Linear/Plane
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SYNC_STATE_FILE = ".caravel/sync-state.json";
const DEFAULT_POLL_INTERVAL = 60;

// State mappings for issue-to-caravel-status
const LINEAR_STATE_TO_CARAVEL: Record<string, "pending" | "running" | "complete" | "failed"> = {
  triage: "pending",
  todo: "pending",
  started: "running",
  in_progress: "running",
  done: "complete",
  completed: "complete",
  cancelled: "failed",
  canceled: "failed",
};

const PLANE_STATE_TO_CARAVEL: Record<string, "pending" | "running" | "complete" | "failed"> = {
  backlog: "pending",
  unstarted: "pending",
  started: "running",
  in_progress: "running",
  completed: "complete",
  cancelled: "failed",
  canceled: "failed",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Make an HTTPS request and return parsed JSON. */
async function httpGet<T>(config: { baseUrl: string; path: string }, headers: Record<string, string>): Promise<{ data: T | null; error?: string }> {
  return new Promise((resolve) => {
    const parsed = new URL(config.baseUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.protocol === "https:" ? `/${config.path}` : config.path,
      method: "GET",
      headers,
    };

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ data: null, error: `HTTP ${res.statusCode}: ${data.slice(0, 500)}` });
        } else {
          try {
            resolve({ data: JSON.parse(data) as T });
          } catch {
            resolve({ data: data as unknown as T });
          }
        }
      });
    });
    req.on("error", (err) => resolve({ data: null, error: err.message }));
    req.end();
  });
}

/** Make an HTTPS POST request with JSON body and return parsed JSON. */
async function httpPost<T>(config: { baseUrl: string; path: string; body: string }, headers: Record<string, string>): Promise<{ data: T | null; error?: string }> {
  return new Promise((resolve) => {
    const parsed = new URL(config.baseUrl);
    const bodyBuffer = Buffer.from(config.body);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.protocol === "https:" ? `/${config.path}` : config.path,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": bodyBuffer.length.toString(),
      },
    };

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ data: null, error: `HTTP ${res.statusCode}: ${data.slice(0, 500)}` });
        } else {
          try {
            resolve({ data: JSON.parse(data) as T });
          } catch {
            resolve({ data: data as unknown as T });
          }
        }
      });
    });
    req.on("error", (err) => resolve({ data: null, error: err.message }));
    req.write(bodyBuffer);
    req.end();
  });
}

/** Load sync state from disk. */
export function loadSyncState(cwd?: string): SyncState {
  const filePath = path.join(cwd || process.cwd(), SYNC_STATE_FILE);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as SyncState;
    }
  } catch (err) {
    // Ignore — will be re-initialized
  }

  return {
    processedLinearIssues: {},
    processedPlaneIssues: {},
    phaseToSource: {},
    lastPollAt: {},
    pollers: {},
  };
}

/** Save sync state to disk. */
export function saveSyncState(state: SyncState, cwd?: string): void {
  const filePath = path.join(cwd || process.cwd(), SYNC_STATE_FILE);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[caravel-sync] Failed to save sync state: ${(err as Error).message}`);
  }
}

/** Escape string for GraphQL interpolation. */
function escapeGraphQL(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Generate a human-readable rich description from an issue for the Caravel task. */
export function buildRichDescription(
  issue: { title: string; description: string; id: string; source: string; labels?: string[] },
  phaseName: string,
): string {
  const lines: string[] = [];
  lines.push(`# Caravel Task — Auto-imported from ${issue.source}`);
  lines.push(`\n**Source:** ${issue.source} Issue #[${issue.id}]`);
  lines.push(`**Phase:** ${phaseName}`);
  lines.push(`\n---`);
  lines.push(`\n## Original ${issue.source} Issue`);
  lines.push(`\n**Title:** ${issue.title}`);
  if (issue.description && issue.description.trim().length > 0) {
    lines.push(`\n**Description:**\n\`\`\`\n${issue.description}\n\`\`\``);
  }
  if (issue.labels && issue.labels.length > 0) {
    lines.push(`\n**Labels:** ${issue.labels.join(", ")}`);
  }
  lines.push(`\n---`);
  lines.push(`\n## Implementation Notes`);
  lines.push(`\n- [ ] Analyze the requirements from the original issue above`);
  lines.push(`- [ ] Implement the solution following project conventions`);
  lines.push(`- [ ] Write tests if applicable`);
  lines.push(`- [ ] Verify the implementation`);
  lines.push(`- [ ] Update documentation if needed`);
  lines.push(`\n---`);
  lines.push(`\n*Auto-synced by Caravel from ${issue.source}*`);
  return lines.join("\n");
}

/** Build a result comment to push back to Linear/Plane. */
export function buildResultComment(
  phase: string,
  phaseStatus: string,
  taskCount: number,
  successCount: number,
  failedCount: number,
  details?: string,
): string {
  const lines: string[] = [];
  lines.push(`## Caravel Fleet — ${phaseStatus.toUpperCase()}`);
  lines.push(`\n**Phase:** ${phase}`);
  lines.push(`**Status:** ${phaseStatus}`);
  lines.push(`**Tasks:** ${successCount}/${taskCount} succeeded, ${failedCount} failed`);
  if (details) {
    lines.push(`\n**Details:**\n\`\`\`\n${details}\n\`\`\``);
  }
  lines.push(`\n_Caravel sync — auto-generated_`);
  return lines.join("\n");
}

// ── Linear Sync ────────────────────────────────────────────────────────────────

/** Query Linear for issues in a specific state (type). */
export async function fetchLinearIssuesByState(
  config: LinearSyncConfig,
  stateType: string = "todo",
): Promise<{ issues: Array<{ id: string; title: string; description: string; state: { type: string; name: string } }>; error?: string }> {
  const teamIds = config.teamId ? [config.teamId] : config.teamIds;
  if (!teamIds || teamIds.length === 0) {
    return { issues: [], error: "No teamIds configured" };
  }

  // Build GraphQL query to fetch issues in the target state across teams
  const stateFilters = teamIds.map((tid) => `{ team: { id: { eq: "${tid}" } }, state: { type: { eq: "${stateType}" } } }`).join(", ");

  const query = `
    query {
      issues(filter: { or: [${stateFilters}] }, first: 50) {
        edges {
          node {
            id
            title
            description
            state {
              type
              name
            }
            labels {
              edges {
                node {
                  id
                  name
                }
              }
            }
            projectId
          }
        }
      }
    }
  `;

  const result = await httpPost<{ data?: { issues?: { edges?: Array<{ node: any }> } } }>({
    baseUrl: "https://api.linear.app",
    path: "/graphql",
    body: JSON.stringify({ query }),
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) {
    return { issues: [], error: result.error };
  }

  const edges = result.data?.issues?.edges || [];
  const issues = edges.map((edge) => edge.node).filter((n: any) => n);

  return { issues };
}

/** Get all Linear states for a team to resolve state IDs. */
export async function fetchLinearTeamStates(config: LinearSyncConfig, teamId: string): Promise<{ stateId: string; stateName: string; stateType: string }[] | null> {
  const query = `
    query {
      team(id: "${teamId}") {
        id
        name
        states(first: 50) {
          edges {
            node {
              id
              name
              type
            }
          }
        }
      }
    }
  `;

  const result = await httpPost<{ data?: { team?: { states?: { edges?: Array<{ node: any }> } } } }>({
    baseUrl: "https://api.linear.app",
    path: "/graphql",
    body: JSON.stringify({ query }),
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error || !result.data?.team) return null;

  const edges = result.data.team.states?.edges || [];
  return edges.map((edge: any) => ({
    stateId: edge.node.id,
    stateName: edge.node.name,
    stateType: edge.node.type,
  }));
}

/** Create a Linear Project (board) for a group of issues. */
export async function createLinearProject(
  config: LinearSyncConfig,
  name: string,
  teamId: string,
  description?: string,
): Promise<{ success: boolean; projectId?: string; error?: string }> {
  if (!config.projectTemplate) {
    return { success: false, error: "No projectTemplate configured for Linear sync" };
  }

  const templateName = config.projectTemplate.name.replace("%DATE%", new Date().toISOString().slice(0, 10));
  const templateDesc = (config.projectTemplate.description || "").replace("%PROJECT%", name);

  const mutation = `
    mutation {
      projectCreate(
        input: {
          name: "${escapeGraphQL(templateName)}",
          description: "${escapeGraphQL(description || templateDesc)}",
          teamId: "${teamId}"
        }
      ) {
        success
        project {
          id
        }
      }
    }
  `;

  const result = await httpPost<{ data?: { projectCreate?: { success?: boolean; project?: { id: string } } } }>({
    baseUrl: "https://api.linear.app",
    path: "/graphql",
    body: JSON.stringify({ query: mutation }),
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) return { success: false, error: result.error };

  const created = result.data?.projectCreate;
  if (created?.success && created.project) {
    return { success: true, projectId: created.project.id };
  }

  return { success: false, error: "projectCreate returned success=false" };
}

/** Update an existing Linear issue's state. */
export async function updateLinearIssueState(
  config: LinearSyncConfig,
  issueId: string,
  stateId: string,
): Promise<{ success: boolean; error?: string }> {
  const mutation = `
    mutation {
      issueUpdate(
        id: "${issueId}",
        input: { stateId: "${stateId}" }
      ) {
        success
      }
    }
  `;

  const result = await httpPost<{ data?: { issueUpdate?: { success?: boolean } } }>({
    baseUrl: "https://api.linear.app",
    path: "/graphql",
    body: JSON.stringify({ query: mutation }),
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) return { success: false, error: result.error };
  return { success: !!result.data?.issueUpdate?.success };
}

/** Add a comment to a Linear issue. */
export async function addLinearComment(
  config: LinearSyncConfig,
  issueId: string,
  body: string,
): Promise<{ success: boolean; error?: string }> {
  const mutation = `
    mutation {
      commentCreate(
        input: {
          issueId: "${issueId}",
          body: "${escapeGraphQL(body)}"
        }
      ) {
        success
      }
    }
  `;

  const result = await httpPost<{ data?: { commentCreate?: { success?: boolean } } }>({
    baseUrl: "https://api.linear.app",
    path: "/graphql",
    body: JSON.stringify({ query: mutation }),
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) return { success: false, error: result.error };
  return { success: !!result.data?.commentCreate?.success };
}

// ── Plane Sync ─────────────────────────────────────────────────────────────────

/** Fetch Plane issues in a specific state. */
export async function fetchPlaneIssuesByState(
  config: PlaneSyncConfig,
  state: string = "unstarted",
): Promise<{ issues: Array<{ id: string; name: string; description: string; state: string; sequenceId: number }>; error?: string }> {
  const path = `api/v1/workspaces/${config.workspaceSlug}/issues/?state=${state}&page_size=50`;
  if (config.projectSlug) {
    // Plane issue filter by project might use a different param
    // Fall back to fetching all and filtering, or use project_issues endpoint
  }

  const result = await httpGet<{ results?: Array<{ id: string; name: string; description: string; state: string; sequence_id: number }> }>({
    baseUrl: config.baseUrl,
    path,
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) {
    return { issues: [], error: result.error };
  }

  const results = result.data?.results || [];
  const issues = results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description || "",
    state: r.state || "",
    sequenceId: r.sequence_id || 0,
  }));

  return { issues };
}

/** Create a Plane Project (workspace project). */
export async function createPlaneProject(
  config: PlaneSyncConfig,
  name: string,
  identifier: string,
  description?: string,
): Promise<{ success: boolean; projectId?: string; error?: string }> {
  const body = JSON.stringify({
    name,
    identifier: identifier.toUpperCase().slice(0, 8), // 5-char max usually
    description: description || `Caravel sync project created ${new Date().toISOString()}`,
  });

  const result = await httpPost<{ data?: { results?: Array<{ id: string; identifier: string }> } | { id: string; identifier: string } }>({
    baseUrl: config.baseUrl,
    path: `api/v1/workspaces/${config.workspaceSlug}/projects/`,
    body,
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) return { success: false, error: result.error };

  // Handle both response formats
  const projectId = result.data?.results?.[0]?.id || (result.data as any).id;
  return projectId ? { success: true, projectId } : { success: false, error: "No project ID returned" };
}

/** Update a Plane issue's state. */
export async function updatePlaneIssueState(
  config: PlaneSyncConfig,
  issueId: string,
  state: string,
): Promise<{ success: boolean; error?: string }> {
  const body = JSON.stringify({ state });
  const result = await httpPost<{ data?: { results?: Array<{ id: string }> } | { id: string } }>({
    baseUrl: config.baseUrl,
    path: `api/v1/workspaces/${config.workspaceSlug}/issues/${issueId}/`,
    body,
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) return { success: false, error: result.error };
  return { success: true };
}

/** Add a comment to a Plane issue. */
export async function addPlaneComment(
  config: PlaneSyncConfig,
  issueId: string,
  body: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await httpPost<{ data?: { results?: Array<{ id: string }> } | { id: string } }>({
    baseUrl: config.baseUrl,
    path: `api/v1/workspaces/${config.workspaceSlug}/issues/${issueId}/comments/`,
    body: JSON.stringify({ body }),
  }, {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (result.error) return { success: false, error: result.error };
  return { success: true };
}

// ── Caravel Integration ───────────────────────────────────────────────────────

/**
 * Create a Caravel phase from Linear/Plane issues.
 *
 * This function generates the markdown phase definition that would be passed
 * to the Caravel orchestrator. It returns the phase structure.
 */
export function createPhaseFromIssues(
  source: "linear" | "plane",
  phaseName: string,
  issues: Array<{ id: string; title: string; description: string }>,
  config: LinearSyncConfig | PlaneSyncConfig,
): { phaseDef: string; taskDescriptions: string[]; taskIds: string[] } {
  const taskDescriptions: string[] = [];
  const taskIds: string[] = [];
  const lines: string[] = [];

  lines.push(`# Phase: ${phaseName}`);
  lines.push(`\n_Imported from ${source} (${issues.length} issues)_`);
  lines.push(`\n`);
  lines.push(`---`);
  lines.push(`\n## Tasks`);

  for (let i = 0; i < issues.length; i++) {
    const task = issues[i];
    const taskId = `caravel-${source}-${task.id}`;
    taskIds.push(taskId);

    const richDesc = buildRichDescription(
      { title: task.title, description: task.description, id: task.id, source },
      phaseName,
    );

    taskDescriptions.push(richDesc);

    lines.push(`\n### Task ${i + 1}: ${task.title}`);
    lines.push(`\n\`${taskId}\``);
    lines.push(`\n${richDesc.slice(0, 2000)}...`);
    lines.push(`\n---`);
  }

  return {
    phaseDef: lines.join("\n"),
    taskDescriptions,
    taskIds,
  };
}

/**
 * Create a Caravel phase from a single issue (for one-issue phases).
 */
export function createSingleIssuePhase(
  source: "linear" | "plane",
  phaseName: string,
  issue: { id: string; title: string; description: string; labels?: string[] },
  agentName: string = "developer",
): { phaseDef: string; taskDescription: string; taskId: string } {
  const taskId = `caravel-${source}-${issue.id}`;
  const richDesc = buildRichDescription(issue, phaseName);

  const lines: string[] = [];
  lines.push(`# Phase: ${phaseName}`);
  lines.push(`\n_Imported from ${source} Issue #[${issue.id}]_`);
  lines.push(`\n---`);
  lines.push(`\n## Task`);
  lines.push(`\n**Agent:** ${agentName}`);
  lines.push(`\n**Task ID:** ${taskId}`);
  lines.push(`\n${richDesc}`);

  return {
    phaseDef: lines.join("\n"),
    taskDescription: richDesc,
    taskId,
  };
}

/**
 * Sync the result of a Caravel phase back to Linear/Plane.
 * Updates the issue state and adds a comment with outcome details.
 */
export async function syncResultToLinear(
  linearConfig: LinearSyncConfig,
  state: SyncState,
  phase: string,
  phaseStatus: string,
  taskCount: number,
  successCount: number,
  failedCount: number,
): Promise<{ success: boolean; error?: string }> {
  // Find source mapping
  const source = state.phaseToSource[phase];
  if (!source || source.system !== "linear") {
    return { success: false, error: "No Linear source found for phase" };
  }

  // Get state ID for target state
  const linearState = phaseStatus === "complete" ? "done" : phaseStatus === "failed" ? "cancelled" : "todo";

  // Update all linked issues
  let errors: string[] = [];
  for (const [issueId, issueState] of Object.entries(state.processedLinearIssues)) {
    if (issueState.phase !== source.phase) continue;

    const targetStateId = await resolveLinearStateId(linearConfig, linearState);
    if (targetStateId) {
      const result = await updateLinearIssueState(linearConfig, issueId, targetStateId);
      if (!result.success) errors.push(`Failed to update issue ${issueId}: ${result.error}`);
    }
  }

  // Add comment to first linked issue
  if (Object.keys(state.processedLinearIssues).length > 0) {
    const firstIssueId = Object.keys(state.processedLinearIssues)[0];
    const comment = buildResultComment(phase, phaseStatus, taskCount, successCount, failedCount);
    await addLinearComment(linearConfig, firstIssueId, comment);
  }

  return errors.length > 0
    ? { success: false, error: errors.join("; ") }
    : { success: true };
}

export async function syncResultToPlane(
  planeConfig: PlaneSyncConfig,
  state: SyncState,
  phase: string,
  phaseStatus: string,
  taskCount: number,
  successCount: number,
  failedCount: number,
): Promise<{ success: boolean; error?: string }> {
  const source = state.phaseToSource[phase];
  if (!source || source.system !== "plane") {
    return { success: false, error: "No Plane source found for phase" };
  }

  const planeState = phaseStatus === "complete" ? "completed" : phaseStatus === "failed" ? "cancelled" : "unstarted";

  let errors: string[] = [];
  for (const [issueId, issueState] of Object.entries(state.processedPlaneIssues)) {
    if (issueState.phase !== source.phase) continue;

    const result = await updatePlaneIssueState(planeConfig, issueId, planeState);
    if (!result.success) errors.push(`Failed to update issue ${issueId}`);
  }

  if (Object.keys(state.processedPlaneIssues).length > 0) {
    const firstIssueId = Object.keys(state.processedPlaneIssues)[0];
    const comment = buildResultComment(phase, phaseStatus, taskCount, successCount, failedCount);
    await addPlaneComment(planeConfig, firstIssueId, comment);
  }

  return errors.length > 0
    ? { success: false, error: errors.join("; ") }
    : { success: true };
}

/** Resolve Linear state ID from state type/name. */
async function resolveLinearStateId(config: LinearSyncConfig, targetType: string): Promise<string | null> {
  // Try the project template's stateId first
  if (config.projectTemplate?.stateId) {
    return config.projectTemplate.stateId;
  }

  // Look up states for each team
  const teamIds = config.teamId ? [config.teamId] : config.teamIds;
  for (const teamId of teamIds) {
    const states = await fetchLinearTeamStates(config, teamId);
    if (!states) continue;

    const found = states.find((s) => s.stateType === targetType);
    if (found) return found.stateId;
  }

  return null;
}

// ── Polling Engine ─────────────────────────────────────────────────────────────

/**
 * Poll Linear for issues moved to "Todo" state since last poll.
 */
export async function pollLinearSync(
  config: LinearSyncConfig,
  state: SyncState,
  cwd: string,
): Promise<{ newIssues: Array<{ id: string; title: string; description: string }>; error?: string }> {
  const { issues, error } = await fetchLinearIssuesByState(config, "todo");

  if (error) return { newIssues: [], error };

  // Filter to only new issues
  const newIssues = issues.filter((issue) => {
    return !state.processedLinearIssues[issue.id];
  });

  // Mark as processed
  for (const issue of newIssues) {
    state.processedLinearIssues[issue.id] = {
      phase: "", // Will be set when phase is created
      tasks: [],
      syncedAt: Date.now(),
    };
  }

  state.lastPollAt.linear = Date.now();
  saveSyncState(state, cwd);

  return { newIssues };
}

/**
 * Poll Plane for issues moved to "To Do" state since last poll.
 */
export async function pollPlaneSync(
  config: PlaneSyncConfig,
  state: SyncState,
  cwd: string,
): Promise<{ newIssues: Array<{ id: string; name: string; description: string }>; error?: string }> {
  const { issues, error } = await fetchPlaneIssuesByState(config, "unstarted");

  if (error) return { newIssues: [], error };

  const newIssues = issues.filter((issue) => {
    return !state.processedPlaneIssues[issue.id];
  });

  for (const issue of newIssues) {
    state.processedPlaneIssues[issue.id] = {
      phase: "",
      tasks: [],
      syncedAt: Date.now(),
    };
  }

  state.lastPollAt.plane = Date.now();
  saveSyncState(state, cwd);

  return { newIssues };
}

/**
 * Start the Linear polling loop.
 */
export function startLinearPoller(
  config: LinearSyncConfig,
  state: SyncState,
  cwd: string,
  onNewIssues?: (issues: Array<{ id: string; title: string; description: string }>) => void,
): void {
  if (state.pollers?.linear?.running) return;

  const interval = (config.pollIntervalSec || DEFAULT_POLL_INTERVAL) * 1000;

  state.pollers.linear = {
    interval: setInterval(async () => {
      const result = await pollLinearSync(config, state, cwd);
      if (result.error) {
        console.warn(`[caravel-sync] Linear poll error: ${result.error}`);
      }
      if (result.newIssues.length > 0 && onNewIssues) {
        onNewIssues(result.newIssues);
      }
    }, interval),
    running: true,
  };
}

/**
 * Start the Plane polling loop.
 */
export function startPlanePoller(
  config: PlaneSyncConfig,
  state: SyncState,
  cwd: string,
  onNewIssues?: (issues: Array<{ id: string; name: string; description: string }>) => void,
): void {
  if (state.pollers?.plane?.running) return;

  const interval = (config.pollIntervalSec || DEFAULT_POLL_INTERVAL) * 1000;

  state.pollers.plane = {
    interval: setInterval(async () => {
      const result = await pollPlaneSync(config, state, cwd);
      if (result.error) {
        console.warn(`[caravel-sync] Plane poll error: ${result.error}`);
      }
      if (result.newIssues.length > 0 && onNewIssues) {
        onNewIssues(result.newIssues);
      }
    }, interval),
    running: true,
  };
}

/**
 * Stop a polling loop.
 */
export function stopPoller(system: "linear" | "plane"): void {
  // This would be called by the lifecycle hooks to stop polling
  // Implementation would clear the interval
}

// ── Configuration Loading ──────────────────────────────────────────────────────

/**
 * Load sync configuration from `.caravel/sync-config.json`.
 * Falls back to default values.
 */
export function loadSyncConfig(cwd?: string): CaravelSyncConfig {
  const configPath = path.join(cwd || process.cwd(), ".caravel", "sync-config.json");
  const defaults: CaravelSyncConfig = {
    linear: {
      enabled: false,
      apiKey: "",
      teamIds: [],
      projectTemplate: {
        name: "Caravel-%DATE%",
        description: "Auto-created by Caravel fleet",
        stateId: "",
      },
      pollIntervalSec: DEFAULT_POLL_INTERVAL,
      createProjectAutomatically: true,
    },
    plane: {
      enabled: false,
      apiKey: "",
      baseUrl: "https://app.plane.so",
      workspaceSlug: "",
      stateFilter: "unstarted",
      pollIntervalSec: DEFAULT_POLL_INTERVAL,
      createProjectAutomatically: true,
    },
  };

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CaravelSyncConfig>;

      return {
        linear: { ...defaults.linear, ...parsed.linear },
        plane: { ...defaults.plane, ...parsed.plane },
      };
    }
  } catch (err) {
    console.warn(`[caravel-sync] Failed to load sync config: ${(err as Error).message}`);
  }

  return defaults;
}

/**
 * Create a sync config file in `.caravel/` with template values.
 */
export function createSyncConfigTemplate(cwd?: string): string {
  const configDir = path.join(cwd || process.cwd(), ".caravel");
  const filePath = path.join(configDir, "sync-config.json");

  const template = JSON.stringify({
    linear: {
      enabled: true,
      apiKey: "lin_api_your_key_here",
      teamIds: ["TEAM_ID_HERE"],
      projectTemplate: {
        name: "Caravel-%DATE%",
        description: "Fleet project synced from Linear",
        stateId: "",
      },
      pollIntervalSec: 60,
      createProjectAutomatically: true,
    },
    plane: {
      enabled: false,
      apiKey: "plane_api_key_here",
      baseUrl: "https://app.plane.so",
      workspaceSlug: "your-workspace",
      stateFilter: "unstarted",
      pollIntervalSec: 60,
      createProjectAutomatically: true,
    },
  }, null, 2);

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(filePath, template, "utf-8");
  return filePath;
}

// ── Export ─────────────────────────────────────────────────────────────────────

export default {
  // Linear
  fetchLinearIssuesByState,
  fetchLinearTeamStates,
  createLinearProject,
  updateLinearIssueState,
  addLinearComment,

  // Plane
  fetchPlaneIssuesByState,
  createPlaneProject,
  updatePlaneIssueState,
  addPlaneComment,

  // Sync
  pollLinearSync,
  pollPlaneSync,
  startLinearPoller,
  startPlanePoller,
  stopPoller,

  // State
  loadSyncState,
  saveSyncState,

  // Config
  loadSyncConfig,
  createSyncConfigTemplate,

  // Helpers
  createPhaseFromIssues,
  createSingleIssuePhase,
  buildRichDescription,
  buildResultComment,
  syncResultToLinear,
  syncResultToPlane,
};
