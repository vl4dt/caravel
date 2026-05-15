/**
 * Caravel Agent Messaging
 *
 * Provides inter-agent message passing with persistence to `.caravel/messages.json`.
 * Messages are organized by channel and support priority levels, read/unread state,
 * and agent identity addressing.
 *
 * Persistence schema: { nextId, channels: { [channelName]: Message[] } }
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

export type MessagePriority = "low" | "normal" | "high" | "urgent" | "escalation";

/** An inter-agent message within the Caravel fleet. */
export interface Message {
  /** Unique message identifier (monotonically increasing). */
  id: number;
  /** The agent identity that sent this message. */
  from: string;
  /** The recipient agent identity. */
  to: string;
  /** Brief subject line of the message. */
  subject: string;
  /** Body content of the message (may contain formatting). */
  body: string;
  /** Priority level. Defaults to "normal". */
  priority: MessagePriority;
  /** Timestamp when the message was created. */
  createdAt: number;
  /** Timestamp when the message was last modified (for replies/updates). */
  updatedAt: number;
  /** Whether the recipient has marked this message as read. */
  isRead: boolean;
  /** The channel this message belongs to. */
  channel: string;
  /** For nudges: expiration timestamp. Null for non-nudge messages. */
  expiryAt: number | null;
  /** For escalations: whether the escalation has been resolved. */
  resolved: boolean;
}

/** Schema for the persisted messages.json file. */
interface MessagesFile {
  /** Version number for schema compatibility. */
  version: number;
  /** Next message ID to assign (monotonically increasing). */
  nextId: number;
  /** Map of channel name -> array of Message objects. */
  channels: Record<string, Message[]>;
  /** Timestamp of last write to the file. */
  updatedAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MESSAGES_FILE_NAME = "messages.json";
const CURRENT_VERSION = 1;
export const DEFAULT_CHANNELS = ["general", "review", "escalation"] as const;
const DEFAULT_PRIORITY: MessagePriority = "normal";
const VALID_PRIORITIES: ReadonlySet<MessagePriority> = new Set(["low", "normal", "high", "urgent", "escalation"]);

/** Nudge expiry duration in milliseconds (5 minutes). */
export const NUDGE_EXPIRY_MS = 5 * 60 * 1000;

/** Default channel for nudge messages. */
const NUDGE_CHANNEL = "general";

/** Default channel for escalation messages. */
const ESCALATION_CHANNEL = "escalation";

/** Agent identities that receive auto-routed escalations. */
export const ESCALATION_RECIPIENTS = ["tech-lead", "orchestrator"] as const;

/** Default channel name for direct messages when none is specified. */
const DEFAULT_CHANNEL = "general";

// ── Persistence helpers ────────────────────────────────────────────────────────

/** Resolve the path to `.caravel/messages.json` relative to a given base directory. */
function messagesFilePath(cwd: string): string {
  return path.join(cwd, ".caravel", MESSAGES_FILE_NAME);
}

/**
 * Load the persisted messages file.
 * Returns the parsed MessagesFile or null if it doesn't exist / is corrupt.
 */
function loadMessagesFile(cwd: string): MessagesFile | null {
  const filePath = messagesFilePath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Validate schema
  if (parsed.version == null || parsed.nextId == null || typeof parsed.channels !== "object" || parsed.channels === null || Array.isArray(parsed.channels)) {
    return null;
  }

  return {
    version: parsed.version,
    nextId: parsed.nextId,
    channels: parsed.channels,
    updatedAt: parsed.updatedAt || Date.now(),
  };
}

/**
 * Save the messages file to disk.
 * Writes atomically via a temp file + rename.
 */
function saveMessagesFile(cwd: string, data: MessagesFile): void {
  const filePath = messagesFilePath(cwd);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fileData: Record<string, unknown> = {
    version: data.version,
    nextId: data.nextId,
    channels: data.channels,
    updatedAt: data.updatedAt,
  };

  const tmpPath = filePath + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(fileData, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Ensure a channel exists in the loaded file.
 * Creates an empty channel array if it doesn't exist.
 */
function ensureChannel(file: MessagesFile, channel: string): void {
  if (!file.channels[channel]) {
    file.channels[channel] = [];
  }
}

// ── Validation ─────────────────────────────────────────────────────────────────

function validateAgentIdentity(identity: string, label: string): void {
  if (!identity || typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error(`sendMessage: ${label} must be a non-empty string`);
  }
}

function validateString(value: unknown, fieldName: string): void {
  if (!value || typeof value !== "string" || value.toString().trim().length === 0) {
    throw new Error(`sendMessage: ${fieldName} must be a non-empty string`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Send a message from one agent to another.
 *
 * Creates a new Message object, assigns it a unique ID, persists it to
 * `.caravel/messages.json` under the specified channel, and returns the Message.
 *
 * @param from  - Sender agent identity (e.g. "caravel/dev/primary")
 * @param to    - Recipient agent identity
 * @param subject  - Message subject line
 * @param body     - Message body content
 * @param priority? - Message priority (low, normal, high, urgent). Defaults to "normal"
 * @param channel?  - Channel name. Defaults to "general"
 * @param cwd?      - Base directory for persistence (defaults to process.cwd())
 */
export function sendMessage(
  from: string,
  to: string,
  subject: string,
  body: string,
  priority?: MessagePriority,
  channel?: string,
  cwd?: string,
): Message {
  // Validate inputs
  validateAgentIdentity(from, "from");
  validateAgentIdentity(to, "to");
  validateString(subject, "subject");
  validateString(body, "body");

  const resolvedPriority = priority ?? DEFAULT_PRIORITY;
  if (!VALID_PRIORITIES.has(resolvedPriority)) {
    throw new Error(`sendMessage: priority must be one of: low, normal, high, urgent (got: ${resolvedPriority})`);
  }

  const resolvedChannel = channel ?? DEFAULT_CHANNEL;
  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadMessagesFile(base);
  if (!file) {
    file = { version: CURRENT_VERSION, nextId: 1, channels: {}, updatedAt: now };
  }

  ensureChannel(file, resolvedChannel);

  // Auto-create agent-specific channel <from>→<to> on first message
  const agentChannel = `${from}→${to}`;
  ensureChannel(file, agentChannel);

  const message: Message = {
    id: file.nextId++,
    from,
    to,
    subject,
    body,
    priority: resolvedPriority,
    createdAt: now,
    updatedAt: now,
    isRead: false,
    channel: resolvedChannel,
  };

  file.channels[resolvedChannel].push(message);
  file.updatedAt = now;
  saveMessagesFile(base, file);

  return message;
}

/**
 * Get messages for a specific agent identity.
 *
 * Returns messages where the agent is either the sender or the recipient.
 * When unreadOnly is true, only messages where isRead is false are returned.
 *
 * @param agentIdentity - The agent identity to filter by
 * @param unreadOnly?   - If true, only return unread messages
 * @param cwd?          - Base directory for persistence
 */
export function getMessages(
  agentIdentity: string,
  unreadOnly?: boolean,
  cwd?: string,
): Message[] {
  validateAgentIdentity(agentIdentity, "agentIdentity");

  const base = cwd ?? process.cwd();
  const file = loadMessagesFile(base);
  if (!file) {
    return [];
  }

  const results: Message[] = [];

  for (const channelMessages of Object.values(file.channels)) {
    for (const message of channelMessages) {
      // Match if the agent is sender or recipient
      const isSender = message.from === agentIdentity;
      const isRecipient = message.to === agentIdentity;

      if (!isSender && !isRecipient) {
        continue;
      }

      // Apply unread filter if requested
      if (unreadOnly && message.isRead) {
        continue;
      }

      results.push(message);
    }
  }

  // Sort by createdAt ascending (oldest first)
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Mark a message as read.
 *
 * @param messageId   - The ID of the message to mark as read
 * @param agentIdentity - The agent identity performing the action (must be the recipient)
 * @param cwd?        - Base directory for persistence
 * @returns true if the message was found and marked as read, false otherwise
 */
export function markAsRead(
  messageId: number,
  agentIdentity: string,
  cwd?: string,
): boolean {
  validateAgentIdentity(agentIdentity, "agentIdentity");

  const base = cwd ?? process.cwd();
  const file = loadMessagesFile(base);
  if (!file) {
    return false;
  }

  for (const messages of Object.values(file.channels)) {
    const message = messages.find((m) => m.id === messageId);
    if (message) {
      // Verify the agent is the recipient
      if (message.to !== agentIdentity) {
        return false;
      }

      if (!message.isRead) {
        message.isRead = true;
        message.updatedAt = Date.now();
        file.updatedAt = Date.now();
        saveMessagesFile(base, file);
      }
      return true;
    }
  }

  return false;
}

/**
 * Get all messages for a specific channel.
 *
 * @param channel - The channel name to retrieve messages from
 * @param cwd?    - Base directory for persistence
 */
export function getMessagesByChannel(
  channel: string,
  cwd?: string,
): Message[] {
  if (!channel || typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error("getMessagesByChannel: channel must be a non-empty string");
  }

  const base = cwd ?? process.cwd();
  const file = loadMessagesFile(base);
  if (!file || !file.channels[channel]) {
    return [];
  }

  // Return a copy sorted by createdAt ascending
  return [...file.channels[channel]].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Get the list of available (configured) default channel names.
 *
 * @returns The array of default channel names: ['general', 'review', 'escalation']
 */
export function getAvailableChannels(): string[] {
  return [...DEFAULT_CHANNELS];
}

// ── Nudge & Escalation helpers ─────────────────────────────────────────────────

/**
 * Create a nudge: a high-priority message that expires after 5 minutes.
 *
 * A nudge is a quick, attention-grabbing message. It carries priority 'high'
 * and carries an expiryAt timestamp. Expired nudges are invisible to
 * getUnresolvedNudges() but remain in the message store for audit.
 *
 * @param from  - Sender agent identity
 * @param to    - Recipient agent identity
 * @param message - Brief nudge text (used as both subject and body)
 * @param cwd?  - Base directory for persistence
 */
export function sendNudge(
  from: string,
  to: string,
  message: string,
  cwd?: string,
): Message {
  validateAgentIdentity(from, "from");
  validateAgentIdentity(to, "to");
  validateString(message, "message");

  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadMessagesFile(base);
  if (!file) {
    file = { version: CURRENT_VERSION, nextId: 1, channels: {}, updatedAt: now };
  }

  ensureChannel(file, NUDGE_CHANNEL);
  ensureChannel(file, ESCALATION_CHANNEL);

  const messageObj: Message = {
    id: file.nextId++,
    from,
    to,
    subject: message,
    body: message,
    priority: "high",
    createdAt: now,
    updatedAt: now,
    isRead: false,
    channel: NUDGE_CHANNEL,
    expiryAt: now + NUDGE_EXPIRY_MS,
    resolved: false,
  };

  file.channels[NUDGE_CHANNEL].push(messageObj);
  file.updatedAt = now;
  saveMessagesFile(base, file);

  return messageObj;
}

/**
 * Escalate an issue: create an escalation message with priority 'escalation'
 * that is auto-routed to all ESCALATION_RECIPIENTS.
 *
 * Each recipient gets a separate Message with the same escalationId (the
 * originating message's id) so that resolveEscalation() can resolve for all.
 *
 * @param from   - Sender agent identity
 * @param to     - Original recipient / originator being escalated about
 * @param subject - Escalation subject line
 * @param body    - Escalation body content
 * @param cwd?    - Base directory for persistence
 */
export function escalate(
  from: string,
  to: string,
  subject: string,
  body: string,
  cwd?: string,
): Message[] {
  validateAgentIdentity(from, "from");
  validateAgentIdentity(to, "to");
  validateString(subject, "subject");
  validateString(body, "body");

  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadMessagesFile(base);
  if (!file) {
    file = { version: CURRENT_VERSION, nextId: 1, channels: {}, updatedAt: now };
  }

  ensureChannel(file, NUDGE_CHANNEL);
  ensureChannel(file, ESCALATION_CHANNEL);

  const results: Message[] = [];

  for (const recipient of ESCALATION_RECIPIENTS) {
    // Create a message to each escalation recipient
    const escalationId = file.nextId;

    const msg: Message = {
      id: escalationId,
      from,
      to: recipient,
      subject: `[escalation:${escalationId}] ${subject}`,
      body: `Escalation #${escalationId}\nFrom: ${from}\nTo: ${to}\n${body}`,
      priority: "escalation",
      createdAt: now,
      updatedAt: now,
      isRead: false,
      channel: ESCALATION_CHANNEL,
      expiryAt: null,
      resolved: false,
    };

    file.channels[ESCALATION_CHANNEL].push(msg);
    results.push(msg);
  }

  file.updatedAt = now;
  saveMessagesFile(base, file);

  return results;
}

/**
 * Get all unresolved nudges — messages with priority 'high' and expiryAt
 * in the future.
 *
 * @param cwd? - Base directory for persistence
 */
export function getUnresolvedNudges(cwd?: string): Message[] {
  const base = cwd ?? process.cwd();
  const now = Date.now();

  const file = loadMessagesFile(base);
  if (!file) {
    return [];
  }

  const nudges = file.channels[NUDGE_CHANNEL] || [];
  return nudges
    .filter(
      (m) =>
        m.priority === "high" &&
        m.expiryAt !== null &&
        m.expiryAt > now,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Get all open (unresolved) escalations — messages with priority
 * 'escalation' and resolved == false.
 *
 * @param cwd? - Base directory for persistence
 */
export function getOpenEscalations(cwd?: string): Message[] {
  const base = cwd ?? process.cwd();

  const file = loadMessagesFile(base);
  if (!file) {
    return [];
  }

  const escalations = file.channels[ESCALATION_CHANNEL] || [];
  return escalations
    .filter((m) => m.priority === "escalation" && !m.resolved)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Resolve an escalation by ID.
 *
 * Sets resolved=true on all escalation messages sharing that escalation
 * ID (the originating message's id), across all channels.
 *
 * @param escalationId - The ID of the escalation to resolve
 * @param cwd?         - Base directory for persistence
 * @returns true if at least one escalation message was resolved, false otherwise
 */
export function resolveEscalation(
  escalationId: number,
  cwd?: string,
): boolean {
  if (!Number.isInteger(escalationId) || escalationId < 0) {
    throw new Error("resolveEscalation: escalationId must be a non-negative integer");
  }

  const base = cwd ?? process.cwd();
  const now = Date.now();

  let file = loadMessagesFile(base);
  if (!file) {
    return false;
  }

  let found = false;
  let changed = false;

  for (const messages of Object.values(file.channels)) {
    for (const msg of messages) {
      if (msg.id === escalationId && msg.priority === "escalation") {
        found = true;
        if (!msg.resolved) {
          msg.resolved = true;
          msg.updatedAt = now;
          changed = true;
        }
      }
    }
  }

  if (found && changed) {
    file.updatedAt = now;
    saveMessagesFile(base, file);
  }

  return found;
}

/**
 * Get messages for a specific channel with optional limit.
 *
 * Auto-creates the channel if it does not exist (writes an empty channel to the file).
 *
 * @param channel - The channel name to retrieve messages from
 * @param limit?  - Maximum number of messages to return (newest-first within the window). Defaults to all.
 * @param cwd?    - Base directory for persistence
 */
export function getChannelMessages(
  channel: string,
  limit?: number,
  cwd?: string,
): Message[] {
  if (!channel || typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error("getChannelMessages: channel must be a non-empty string");
  }

  if (limit !== undefined && (limit < 0 || !Number.isInteger(limit))) {
    throw new Error("getChannelMessages: limit must be a non-negative integer");
  }

  const base = cwd ?? process.cwd();
  const file = loadMessagesFile(base);

  // Auto-create the channel if it doesn't exist yet
  if (!file) {
    const fileData: MessagesFile = {
      version: CURRENT_VERSION,
      nextId: 1,
      channels: { [channel]: [] },
      updatedAt: Date.now(),
    };
    saveMessagesFile(base, fileData);
    return [];
  }

  if (!file.channels[channel]) {
    file.channels[channel] = [];
    file.updatedAt = Date.now();
    saveMessagesFile(base, file);
  }

  // All messages sorted oldest-first
  const all = [...file.channels[channel]].sort((a, b) => a.createdAt - b.createdAt);

  // Apply limit: return the last `limit` entries (newest within window)
  if (limit === 0) {
    return [];
  }
  if (limit !== undefined && limit > 0) {
    return all.slice(-limit);
  }

  return all;
}
