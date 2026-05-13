/**
 * Plane Integration
 *
 * Syncs fleet tasks to Plane issues:
 * - Creates/updates issues from tasks
 * - Syncs task status to Plane issue status
 * - Webhook integration for external updates
 *
 * Plane API: https://docs.plane.io/api-docs/introduction
 *
 * Configuration:
 *   {
 *     apiKey: "api_key_xxx",              // Plane API token
 *     workspaceSlug: "my-workspace",      // Workspace slug
 *     projectSlug: "my-project",          // Project slug
 *     enabled: true,
 *     issueTypeName: "Story",             // Default issue type to create
 *     stateMapping: {                     // Map Caravel statuses to Plane states
 *       "pending": "backlog",
 *       "running": "started",
 *       "complete": "completed",
 *       "failed": "cancelled"
 *     }
 *   }
 */

import * as https from "https";
import * as http from "http";
import { URL } from "url";

export interface PlaneConfig {
  apiKey: string;
  workspaceSlug: string;
  projectSlug?: string;
  enabled?: boolean;
  issueTypeName?: string;
  stateMapping?: Record<string, string>;
  baseUrl?: string;
}

export interface PlaneIssue {
  id: string;
  name: string;
  description: string;
  state: string;
  workspaceSlug: string;
  projectSlug?: string;
  issueType?: string;
  sequenceId?: number;
}

export interface PlaneTaskSync {
  taskId: string;
  phase: string;
  agent: string;
  description: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt?: number;
  completedAt?: number;
  externalIssueId?: string;
}

const DEFAULT_STATE_MAPPING: Record<string, string> = {
  pending: "backlog",
  running: "started",
  complete: "completed",
  failed: "cancelled",
};

const DEFAULT_ISSUE_TYPE = "Story";

/**
 * Create a Plane issue from a task.
 * Returns the Plane issue ID.
 */
export async function createPlaneIssue(
  config: PlaneConfig,
  task: PlaneTaskSync
): Promise<{ success: boolean; issueId?: string; error?: string }> {
  if (!config.enabled) return { success: true };

  const baseUrl = config.baseUrl || "https://app.plane.so";
  const state = config.stateMapping?.[task.status] || "backlog";

  const body = JSON.stringify({
    name: task.description.slice(0, 200),
    description: truncateForMarkdown(task.description, 10000),
    description_html: `<p>${escapeHTML(truncateForMarkdown(task.description, 10000))}</p>`,
    state: state,
    workspace_slug: config.workspaceSlug,
    ...(config.projectSlug ? { project: config.projectSlug } : {}),
    ...(config.issueTypeName ? { issue_type: config.issueTypeName } : {}),
  });

  return planeAPIRequest(config, `api/workspaces/${config.workspaceSlug}/issues/`, body);
}

/**
 * Update an existing Plane issue's status.
 */
export async function updatePlaneIssue(
  config: PlaneConfig,
  issueId: string,
  status: PlaneTaskSync["status"]
): Promise<{ success: boolean; error?: string }> {
  if (!config.enabled) return { success: true };

  const baseUrl = config.baseUrl || "https://app.plane.so";
  const state = config.stateMapping?.[status] || "backlog";

  const body = JSON.stringify({
    state: state,
  });

  return planeAPIRequest(
    config,
    `api/workspaces/${config.workspaceSlug}/issues/${issueId}/`,
    body,
    "PATCH"
  );
}

/**
 * Sync a task to Plane (create or update).
 */
export async function syncTaskToPlane(
  config: PlaneConfig,
  task: PlaneTaskSync
): Promise<{ success: boolean; issueId?: string; error?: string }> {
  if (!config.enabled) return { success: true };

  // If we have an existing issue, update it
  if (task.externalIssueId) {
    return await updatePlaneIssue(config, task.externalIssueId, task.status);
  }

  // Otherwise create a new issue
  return await createPlaneIssue(config, task);
}

/**
 * Get issues from Plane workspace matching task patterns.
 * Used to find existing issues to sync with.
 */
export async function getPlaneIssues(
  config: PlaneConfig,
  filters?: {
    state?: string;
    project?: string;
    search?: string;
  }
): Promise<{ issues: PlaneIssue[]; total: number; next?: string } | null> {
  if (!config.enabled) return null;

  const baseUrl = config.baseUrl || "https://app.plane.so";
  let path = `api/workspaces/${config.workspaceSlug}/issues/`;

  const params = new URLSearchParams();
  if (filters?.state) params.set("state", filters.state);
  if (filters?.project) params.set("project", filters.project);
  if (filters?.search) params.set("search", filters.search);

  if (params.toString()) {
    path += `?${params.toString()}`;
  }

  return planeAPIRequest(config, path);
}

/**
 * Create a webhook endpoint handler for Plane webhook events.
 * Parses incoming webhook payloads and returns event data.
 */
export function parsePlaneWebhook(payload: any): {
  action: string;
  issueId?: string;
  issueName?: string;
  state?: string;
} | null {
  const action = payload.action || "";
  const data = payload.data || {};

  if (data.id && data.name) {
    return {
      action,
      issueId: data.id,
      issueName: data.name,
      state: data.state,
    };
  }

  return null;
}

/**
 * Helper: make a request to the Plane API.
 */
async function planeAPIRequest(
  config: PlaneConfig,
  path: string,
  body?: string,
  method: string = "GET"
): Promise<{ success: boolean; data?: any; error?: string }> {
  const baseUrl = config.baseUrl || "https://app.plane.so";
  const parsed = new URL(baseUrl);

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  if (body) {
    headers["Content-Length"] = Buffer.byteLength(body).toString();
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.protocol === "https:"
      ? `/${path}`
      : path,
    method,
    headers,
  };

  return new Promise((resolve) => {
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === undefined || res.statusCode >= 400) {
          resolve({
            success: false,
            error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
          });
          return;
        }
        try {
          resolve({ success: true, data: JSON.parse(data) });
        } catch {
          resolve({ success: true, data });
        }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

function truncateForMarkdown(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + "...";
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
