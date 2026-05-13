/**
 * Linear Integration
 *
 * Syncs fleet tasks to Linear issues:
 * - Creates/updates issues from tasks
 * - Syncs task status to Linear issue status
 * - Webhook integration for external updates
 *
 * Configuration:
 *   {
 *     apiKey: "lin_api_xxx",              // Linear API key
 *     teamId: "TEAM_ID",                  // Linear team to sync to
 *     projectId: "PROJECT_ID",            // Optional: project to assign issues to
 *     enabled: true,
 *     labelMapping: {                     // Map Caravel statuses to Linear labels
 *       "pending": "todo",
 *       "running": "in-progress",
 *       "complete": "done",
 *       "failed": "blocked"
 *     },
 *     issueTemplate: {                    // Default issue properties
 *       priority: 2,
 *       estimate: 3                        // Story points
 *     }
 *   }
 */

import * as https from "https";

export interface LinearConfig {
  apiKey: string;
  teamId: string;
  projectId?: string;
  enabled?: boolean;
  labelMapping?: Record<string, string>;
  issueTemplate?: { priority?: number; estimate?: number };
}

export interface LinearIssue {
  id: string;
  title: string;
  description: string;
  state: string;
  teamId: string;
  projectId?: string;
  priority?: number;
  estimate?: number;
  labels?: string[];
}

export interface LinearTaskSync {
  taskId: string;
  phase: string;
  agent: string;
  description: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt?: number;
  completedAt?: number;
  externalIssueId?: string;
}

const DEFAULT_LABELS: Record<string, string> = {
  pending: "todo",
  running: "in-progress",
  complete: "done",
  failed: "blocked",
};

const LINEAR_API = "https://api.linear.app/public/v1";

/**
 * Create a Linear issue from a task.
 * Returns the Linear issue ID.
 */
export async function createLinearIssue(
  config: LinearConfig,
  task: LinearTaskSync
): Promise<{ success: boolean; issueId?: string; error?: string }> {
  if (!config.enabled) return { success: true };

  const mutation = `
    mutation {
      issueCreate(
        input: {
          title: "${escapeGraphQL(task.description.slice(0, 200))}",
          description: "${escapeGraphQL(truncateForGraphQL(task.description, 5000))}",
          teamId: "${config.teamId}",
          stateId: "${getLinearStateId(task.status)}",
          ${config.projectId ? `projectId: "${config.projectId}",` : ""}
          ${config.issueTemplate?.priority ? `priority: ${config.issueTemplate.priority},` : ""}
          ${config.issueTemplate?.estimate ? `estimate: ${config.issueTemplate.estimate},` : ""}
          labelIds: ["${getLabelId(task.status, config)}"]
        }
      ) {
        success
        issue {
          id
        }
      }
    }
  `;

  return linearAPIRequest(config, mutation);
}

/**
 * Update an existing Linear issue's status.
 */
export async function updateLinearIssue(
  config: LinearConfig,
  issueId: string,
  status: LinearTaskSync["status"]
): Promise<{ success: boolean; error?: string }> {
  if (!config.enabled) return { success: true };

  const stateId = getLinearStateId(status);
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

  return linearAPIRequest(config, mutation);
}

/**
 * Sync a task to Linear (create or update).
 */
export async function syncTaskToLinear(
  config: LinearConfig,
  task: LinearTaskSync
): Promise<{ success: boolean; issueId?: string; error?: string }> {
  if (!config.enabled) return { success: true };

  // If we have an existing issue, update it
  if (task.externalIssueId) {
    const result = await updateLinearIssue(config, task.externalIssueId, task.status);
    return result;
  }

  // Otherwise create a new issue
  const result = await createLinearIssue(config, task);
  if (result.success && result.issueId) {
    return { success: true, issueId: result.issueId };
  }

  return result;
}

/**
 * Create a webhook endpoint handler for Linear webhook events.
 * Parses incoming webhook payloads and returns event data.
 */
export function parseLinearWebhook(payload: any): {
  action: string;
  issueId?: string;
  issueTitle?: string;
  state?: string;
} | null {
  const type = payload.type || "";
  const payloadData = payload.payload || {};

  if (type.startsWith("issue.")) {
    const issue = payloadData.issue || {};
    return {
      action: type,
      issueId: issue.id,
      issueTitle: issue.title,
      state: issue.state?.name,
    };
  }

  return null;
}

/**
 * Get the Linear state ID for a Caravel status.
 * Note: In production, this would query Linear's API for the correct state ID.
 * For now, returns a placeholder mapping.
 */
function getLinearStateId(status: LinearTaskSync["status"]): string {
  // In production, fetch these from Linear's API:
  // GET https://api.linear.app/public/v1/query?query=teams{issues{states}}
  const stateMap: Record<string, string> = {
    pending: "todo-state-id",       // Replace with actual Linear state IDs
    running: "in-progress-state-id",
    complete: "done-state-id",
    failed: "blocked-state-id",
  };
  return stateMap[status] || "todo-state-id";
}

function getLabelId(status: LinearTaskSync["status"], config: LinearConfig): string {
  const mapping = config.labelMapping || DEFAULT_LABELS;
  return mapping[status] || mapping["pending"] || "todo";
}

/**
 * Helper: make a request to the Linear API.
 */
async function linearAPIRequest(
  config: LinearConfig,
  mutation: string
): Promise<{ success: boolean; issueId?: string; error?: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: mutation });
    const options = {
      hostname: "api.linear.app",
      port: 443,
      path: "/public/v1",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data?.issueCreate?.success) {
            resolve({ success: true, issueId: parsed.data.issueCreate.issue.id });
          } else if (parsed.data?.issueUpdate?.success) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              error: parsed.errors?.map((e: any) => e.message).join("; ") || "Unknown API error",
            });
          }
        } catch (err) {
          resolve({ success: false, error: `Parse error: ${(err as Error).message}` });
        }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function escapeGraphQL(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function truncateForGraphQL(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + "...";
}
