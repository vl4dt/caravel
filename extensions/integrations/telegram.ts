/**
 * Telegram Notification Integration
 *
 * Sends fleet status updates to a Telegram chat:
 * - Task start/completion/failure notifications
 * - Review results (approved/needs_revision)
 * - Phase completion summaries
 * - User input relay from Telegram messages
 *
 * Configuration:
 *   {
 *     botToken: "123456:ABCdef...",     // Bot token from @BotFather
 *     chatId: "-1001234567890",         // Chat/channel ID to send to
 *     enabled: true,
 *     monitorMode: false,               // If true, only sends; doesn't accept input
 *     batchSize: 3                        // Group notifications (0 = send immediately)
 *   }
 */

import * as https from "https";
import * as http from "http";
import { URL } from "url";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled?: boolean;
  monitorMode?: boolean;
  batchSize?: number;
  format?: "html" | "markdown" | "markdownV2";
}

export interface TelegramNotification {
  type: "task_start" | "task_complete" | "task_fail" | "review_result" | "phase_complete" | "fleet_status";
  content: string;
  data?: Record<string, any>;
}

const DEFAULT_FORMAT: TelegramConfig["format"] = "html";

/**
 * Send a notification to Telegram.
 * Uses the Telegram Bot API: https://core.telegram.org/bots/api
 */
export async function sendTelegramNotification(
  config: TelegramConfig,
  notification: TelegramNotification
): Promise<{ success: boolean; error?: string }> {
  if (!config.enabled) return { success: true };

  const parseFormat = config.format || DEFAULT_FORMAT;
  const text = formatMessage(notification, parseFormat);

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  const payload = JSON.stringify({
    chat_id: config.chatId,
    text,
    parse_mode: parseFormat === "markdownV2" ? "MarkdownV2" : parseFormat === "markdown" ? "Markdown" : "HTML",
    disable_web_page_preview: true,
  });

  const parsed = new URL(url);
  const requestOptions: https.RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve) => {
    const req = (parsed.protocol === "https:" ? https : http).request(requestOptions, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${body}` });
        }
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * Send a batch of notifications. Used for batching task results.
 */
export async function sendTelegramBatch(
  config: TelegramConfig,
  notifications: TelegramNotification[]
): Promise<{ success: boolean; error?: string }> {
  if (notifications.length === 0) return { success: true };

  const summary = batchSummary(notifications);
  return sendTelegramNotification(config, {
    type: "fleet_status",
    content: summary,
    data: { batchSize: notifications.length, details: notifications },
  });
}

/**
 * Get the latest updates from Telegram (for user input relay).
 * Returns null if no updates or on error.
 */
export async function getTelegramUpdates(
  config: TelegramConfig,
  lastUpdateId: number = 0
): Promise<{ updates: Array<any>; nextOffset: number } | null> {
  if (!config.enabled) return null;

  const url = `https://api.telegram.org/bot${config.botToken}/getUpdates`;
  const query = lastUpdateId > 0 ? `?offset=${lastUpdateId + 1}` : "";

  return fetchTelegramAPI(url + query);
}

/**
 * Format a message for Telegram based on notification type.
 */
function formatMessage(notification: TelegramNotification, format: string): string {
  const typeEmoji: Record<string, string> = {
    task_start: "▶️",
    task_complete: "✅",
    task_fail: "❌",
    review_result: "🧐",
    phase_complete: "🏁",
    fleet_status: "📊",
  };
  const emoji = typeEmoji[notification.type] || "📌";

  switch (notification.type) {
    case "task_start":
      return `<b>${emoji} Task started</b>\n` +
        `  <b>Task:</b> ${notification.data?.task || "N/A"}\n` +
        `  <b>Agent:</b> ${notification.data?.agent || "N/A"}\n` +
        `  <b>Phase:</b> ${notification.data?.phase || "N/A"}`;

    case "task_complete":
      return `<b>${emoji} Task completed</b>\n` +
        `  <b>Task:</b> ${notification.data?.task || "N/A"}\n` +
        `  <b>Agent:</b> ${notification.data?.agent || "N/A"}\n` +
        `  <b>Duration:</b> ${formatDuration(notification.data?.durationMs || 0)}\n` +
        `  <b>Phase:</b> ${notification.data?.phase || "N/A"}`;

    case "task_fail":
      return `<b>${emoji} Task failed</b>\n` +
        `  <b>Task:</b> ${notification.data?.task || "N/A"}\n` +
        `  <b>Agent:</b> ${notification.data?.agent || "N/A"}\n` +
        `  <b>Error:</b> ${notification.data?.error || "Unknown"}`;

    case "review_result":
      return `<b>${emoji} Review ${notification.data?.status === "approved" ? "approved" : "needs revision"}</b>\n` +
        `  <b>Task:</b> ${notification.data?.task || "N/A"}\n` +
        `  <b>Reviewer:</b> ${notification.data?.reviewer || "N/A"}\n` +
        `  ${notification.data?.feedback ? `  <b>Feedback:</b> ${notification.data.feedback}\n` : ""}`;

    case "phase_complete":
      return `<b>${emoji} Phase completed</b>\n` +
        `  <b>Phase:</b> ${notification.data?.phase || "N/A"}\n` +
        `  <b>Tasks:</b> ${notification.data?.completedTasks || 0}/${notification.data?.totalTasks || 0} succeeded\n` +
        `  <b>Duration:</b> ${formatDuration(notification.data?.durationMs || 0)}`;

    case "fleet_status":
      return `<b>${emoji} Fleet Status</b>\n` +
        `  <b>Overview:</b> ${notification.content}`;

    default:
      return `${emoji} ${notification.content}`;
  }
}

/**
 * Create a batch summary from notifications.
 */
function batchSummary(notifications: TelegramNotification[]): string {
  const tasksStarted = notifications.filter((n) => n.type === "task_start").length;
  const tasksComplete = notifications.filter((n) => n.type === "task_complete").length;
  const tasksFailed = notifications.filter((n) => n.type === "task_fail").length;
  const reviewsApproved = notifications.filter(
    (n) => n.type === "review_result" && n.data?.status === "approved"
  ).length;

  const lines = [
    `Batch: ${notifications.length} notifications`,
    `▶ ${tasksStarted} started | ✅ ${tasksComplete} done | ❌ ${tasksFailed} failed | 🧐 ${reviewsApproved} approved`,
  ];

  // Add latest task completions
  const latestCompletes = notifications
    .filter((n) => n.type === "task_complete")
    .slice(-3)
    .map((n) => `  ✅ ${n.data?.task || "unknown"}`);
  if (latestCompletes.length > 0) lines.push(...latestCompletes);

  // Add latest failures
  const latestFails = notifications
    .filter((n) => n.type === "task_fail")
    .slice(-3)
    .map((n) => `  ❌ ${n.data?.task || "unknown"}`);
  if (latestFails.length > 0) lines.push(...latestFails);

  return lines.join("\n");
}

/**
 * Helper: fetch from Telegram API.
 */
async function fetchTelegramAPI(url: string): Promise<{ updates: Array<any>; nextOffset: number } | null> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = https.get(url, {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) {
            resolve({
              updates: parsed.result || [],
              nextOffset: parsed.result?.length ? parsed.result[parsed.result.length - 1].update_id + 1 : 0,
            });
          } else {
            console.warn(`[telegram] API error: ${parsed.description}`);
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}
