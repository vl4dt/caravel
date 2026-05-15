/**
 * Caravel Widget Bar Messaging Indicators
 *
 * Builds unread-count and escalation-count indicators for the Caravel
 * fleet widget bar.  Indicators are *only* rendered when the messaging
 * feature is enabled; when disabled the indicator array is empty so
 * callers can filter them out trivially.
 *
 * The public API is deliberately thin — it exposes pure functions that
 * take a plain-object "messaging snapshot" (a count of unread messages
 * and open escalations) and return rendered strings ready for the TUI.
 *
 * ## Indicator format
 *
 *   [3 unread]   — green, shown when unread > 0
 *   [1 escalation]  — yellow/orange, shown when escalations > 0
 *
 * Multiple indicators are joined with a separator: "  ·  ".
 *
 * ## Usage
 *
 * ```ts
 * // 1. Gather counts from caravel-messaging module
 * const unread = getMessages(agentIdentity, true).length;
 * const esc    = getOpenEscalations().length;
 *
 * // 2. Build indicators
 * const indicators = buildMessagingIndicators({ unread, escalations });
 *
 * // 3. Filter into the widget bar (only when messaging enabled)
 * const widgetLine = messagingEnabled
 *   ? indicators.length > 0
 *     ? indicators.join("  ·  ")
 *     : ""
 *   : "";
 * ```
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** Configuration for a messaging-indicator row. */
export interface MessagingIndicatorConfig {
  /** Whether the messaging subsystem is enabled. */
  enabled: boolean;
  /** Number of unread messages for the current agent.
   *  Omitted → falls back to module-level counts set via `setMessagingCounts`. */
  unread?: number;
  /** Number of open (unresolved) escalations.
   *  Omitted → falls back to module-level counts set via `setMessagingCounts`. */
  escalations?: number;
}

/**
 * Module-level messaging counts used by the widget bar.
 * Callers (e.g. the fleet orchestrator) should update these via
 * setMessagingCounts() each refresh cycle so the widget bar
 * displays live data.
 */
let _messagingCounts: { unread: number; escalations: number } = {
  unread: 0,
  escalations: 0,
};

/**
 * Set the current messaging counts.
 * Must be called each refresh cycle to keep the widget bar current.
 *
 * @param counts — unread count and open escalation count
 */
export function setMessagingCounts(counts: { unread: number; escalations: number }): void {
  _messagingCounts = { unread: Math.max(0, counts.unread), escalations: Math.max(0, counts.escalations) };
}

/** A single rendered indicator string. */
export interface IndicatorEntry {
  /** The formatted indicator text, e.g. "[3 unread]". */
  text: string;
  /** Color name used by the TUI theme for this indicator. */
  color: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Separator between multiple indicators. */
const INDICATOR_SEPARATOR = "  ·  ";

// ── Theme helpers ──────────────────────────────────────────────────────────────

/** Build a single indicator entry for unread messages. */
function buildUnreadIndicator(count: number): IndicatorEntry {
  return { text: `[${count} unread]`, color: "success" };
}

/** Build a single indicator entry for open escalations. */
function buildEscalationIndicator(count: number): IndicatorEntry {
  return { text: `[${count} escalation${count !== 1 ? "s" : ""}]`, color: "warning" };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build messaging indicators for the widget bar based on the provided
 * configuration.
 *
 * When `config.enabled` is false, returns an empty array regardless of
 * count values (defensive — no indicators when the feature is off).
 *
 * Counts are taken from `config` if provided; otherwise the module-level
 * counts set via `setMessagingCounts()` are used.
 *
 * @param config — unread/escalation counts + enabled flag
 * @returns array of indicator entries, empty when nothing to show
 */
export function buildMessagingIndicators(config: MessagingIndicatorConfig): IndicatorEntry[] {
  const entries: IndicatorEntry[] = [];

  // When disabled, return empty — caller can use length check to skip rendering.
  if (!config.enabled) {
    return entries;
  }

  // Resolve counts: explicit config values take priority over module-level
  const unread = config.unread != null ? config.unread : _messagingCounts.unread;
  const escalations = config.escalations != null ? config.escalations : _messagingCounts.escalations;

  // Unread messages indicator
  if (unread > 0) {
    entries.push(buildUnreadIndicator(unread));
  }

  // Escalation indicator
  if (escalations > 0) {
    entries.push(buildEscalationIndicator(escalations));
  }

  return entries;
}

/**
 * Format an array of IndicatorEntry into a single widget-bar line string
 * (without the border prefix).
 *
 * The caller is expected to prepend the border prefix via `edge()`.
 *
 * @param entries — array of indicator entries
 * @param theme   — TUI theme function (same signature as `ctx.ui.theme.fg`)
 * @returns formatted string or empty string when entries is empty
 */
export function formatIndicatorLine(
  entries: IndicatorEntry[],
  theme: { fg: (color: string, text: string) => string },
): string {
  if (entries.length === 0) return "";

  const formatted = entries
    .map((e) => `${theme.fg(e.color, e.text)}`)
    .join(INDICATOR_SEPARATOR);

  // Add a leading space to separate from the preceding widget content
  return `  ${formatted}`;
}

// ── Test helpers ───────────────────────────────────────────────────────────────

/**
 * Build a mock theme function for tests.
 * Returns the text unchanged but wrapped in `[<color>]` for debugging.
 */
export function createMockTheme(): { fg: (color: string, text: string) => string; lastColor: string; lastText: string } {
  let lastColor = "";
  let lastText = "";
  return {
    fg: (color: string, text: string) => {
      lastColor = color;
      lastText = text;
      return text; // Return plain text for test assertions
    },
    get lastColor(): string { return lastColor; },
    get lastText(): string { return lastText; },
  };
}

// ── Exported for testing ───────────────────────────────────────────────────────

// Allow tests to import the individual builder functions for fine-grained
// assertions while keeping the public surface minimal.
export const buildUnreadIndicatorForTest = buildUnreadIndicator;
export const buildEscalationIndicatorForTest = buildEscalationIndicator;
export const INDICATOR_SEPARATOR_FOR_TEST = INDICATOR_SEPARATOR;
