/**
 * Metrics Collection System
 *
 * Collects and exports fleet metrics for analysis, reporting, and budgeting.
 * Metrics include task duration, review cycles, tokens, pass/fail rates,
 * and phase timing.
 *
 * Output formats: JSON (structured), CSV (spreadsheet-compatible)
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────────

/** A single metric data point. */
export interface MetricPoint {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  labels: Record<string, string>;
}

/** Summary statistics for a metric series. */
export interface MetricSummary {
  name: string;
  unit: string;
  count: number;
  min: number;
  max: number;
  avg: number;
  total: number;
  /** Per-label breakdowns */
  byLabel: Record<string, { count: number; avg: number; total: number }>;
}

/** All fleet metrics in one aggregate. */
export interface FleetMetrics {
  /** When metrics collection started */
  startedAt: number;
  /** Current time */
  now: number;
  /** Elapsed time since collection started */
  elapsed: number;
  /** All individual metric points */
  points: MetricPoint[];
  /** Pre-computed summaries */
  summaries: MetricSummary[];
  /** Export functions */
  toJSON(): string;
  toCSV(): string;
  saveToFile(directory: string): Promise<void>;
}

// ── Collector ──────────────────────────────────────────────────────────────

/**
 * Collect a single metric point.
 * @param name - Metric name (e.g., "task_duration", "review_count")
 * @param value - Numeric value
 * @param unit - Unit label (e.g., "ms", "tokens", "count")
 * @param labels - Optional labels for grouping (e.g., { agent: "developer", phase: "P1" })
 */
export function collectMetric(
  name: string,
  value: number,
  unit: string,
  labels?: Record<string, string>
): MetricPoint {
  return {
    name,
    value,
    unit,
    timestamp: Date.now(),
    labels: labels || {},
  };
}

/**
 * Calculate summary statistics for a metric series.
 */
export function summarizeMetrics(points: MetricPoint[]): MetricSummary[] {
  const byName = new Map<string, MetricPoint[]>();
  for (const p of points) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name)!.push(p);
  }

  const summaries: MetricSummary[] = [];
  for (const [name, pts] of byName) {
    const values = pts.map((p) => p.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;

    const byLabel = new Map<string, { values: number[] }>();
    for (const p of pts) {
      const key = JSON.stringify(p.labels);
      if (!byLabel.has(key)) byLabel.set(key, { values: [] });
      byLabel.get(key)!.values.push(p.value);
    }

    const byLabelSummary: Record<string, { count: number; avg: number; total: number }> = {};
    for (const [key, data] of byLabel) {
      const lsum = data.values.reduce((a, b) => a + b, 0);
      byLabelSummary[key] = {
        count: data.values.length,
        avg: lsum / data.values.length,
        total: lsum,
      };
    }

    summaries.push({
      name,
      unit: pts[0].unit,
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round(avg * 100) / 100,
      total: sum,
      byLabel: byLabelSummary,
    });
  }

  return summaries;
}

// ── Fleet Metrics Aggregate ────────────────────────────────────────────────

export function createFleetMetrics(
  fleetState: {
    phases: Array<{
      name: string;
      status: string;
      tasks: Array<{
        id: string;
        agentName: string;
        description: string;
        status: string;
        tokensUsed?: number;
        inputTokens?: number;
        outputTokens?: number;
        reviewCount?: number;
        codeReviewStatus?: string;
        designReviewStatus?: string;
        startedAt?: number;
        completedAt?: number;
      }>;
    }>;
    totalFleetTokens: number;
    startTime: number;
    currentPhaseIndex: number;
    reviewIterations: number;
  },
  startTime: number
): FleetMetrics {
  const now = Date.now();
  const points: MetricPoint[] = [];

  // Collect per-phase metrics
  for (const [i, phase] of fleetState.phases.entries()) {
    const phaseStartedAt = phase.tasks.length > 0
      ? Math.min(...phase.tasks.map((t) => t.startedAt || now))
      : now;
    const phaseCompletedAt = phase.tasks.length > 0
      ? Math.max(...phase.tasks.map((t) => t.completedAt || now))
      : now;

    // Phase duration
    const phaseDuration = phaseCompletedAt - phaseStartedAt;
    points.push(collectMetric("phase_duration", phaseDuration, "ms", {
      phase: `P${i + 1}`,
      phaseName: phase.name,
      status: phase.status,
    }));

    // Per-task metrics
    for (const task of phase.tasks) {
      const taskDuration = (task.completedAt || now) - (task.startedAt || now);
      points.push(collectMetric("task_duration", taskDuration, "ms", {
        phase: `P${i + 1}`,
        phaseName: phase.name,
        task: task.id,
        agent: task.agentName,
        status: task.status,
      }));

      // Token usage per task
      if (task.tokensUsed) {
        points.push(collectMetric("task_tokens", task.tokensUsed, "tokens", {
          phase: `P${i + 1}`,
          agent: task.agentName,
          task: task.id,
        }));
      }
      if (task.inputTokens) {
        points.push(collectMetric("task_input_tokens", task.inputTokens, "tokens", {
          phase: `P${i + 1}`,
          agent: task.agentName,
          task: task.id,
        }));
      }
      if (task.outputTokens) {
        points.push(collectMetric("task_output_tokens", task.outputTokens, "tokens", {
          phase: `P${i + 1}`,
          agent: task.agentName,
          task: task.id,
        }));
      }

      // Review count per task
      if (task.reviewCount) {
        points.push(collectMetric("review_count", task.reviewCount, "reviews", {
          phase: `P${i + 1}`,
          agent: task.agentName,
          task: task.id,
        }));
      }

      // Review pass/fail per task
      if (task.codeReviewStatus) {
        points.push(collectMetric("code_review_result", task.codeReviewStatus === "approved" ? 1 : 0, "binary", {
          phase: `P${i + 1}`,
          agent: task.agentName,
          task: task.id,
        }));
      }
      if (task.designReviewStatus) {
        points.push(collectMetric("design_review_result", task.designReviewStatus === "approved" ? 1 : 0, "binary", {
          phase: `P${i + 1}`,
          agent: task.agentName,
          task: task.id,
        }));
      }
    }
  }

  // Overall fleet token usage
  points.push(collectMetric("total_fleet_tokens", fleetState.totalFleetTokens, "tokens", {
    scope: "fleet",
  }));

  // Review iterations
  points.push(collectMetric("review_iterations", fleetState.reviewIterations, "iterations", {
    scope: "fleet",
  }));

  // Phase completion status
  const completedPhases = fleetState.phases.filter((p) => p.status === "complete").length;
  const failedPhases = fleetState.phases.filter((p) => p.status === "failed").length;
  points.push(collectMetric("completed_phases", completedPhases, "phases", { scope: "fleet" }));
  points.push(collectMetric("failed_phases", failedPhases, "phases", { scope: "fleet" }));

  // Task completion rates
  const totalTasks = fleetState.phases.reduce((s, p) => s + p.tasks.length, 0);
  const completedTasks = fleetState.phases.reduce((s, p) => s + p.tasks.filter((t) => t.status === "complete").length, 0);
  points.push(collectMetric("completed_tasks", completedTasks, "tasks", { scope: "fleet" }));
  points.push(collectMetric("pending_tasks", totalTasks - completedTasks, "tasks", { scope: "fleet" }));

  const summaries = summarizeMetrics(points);

  return {
    startedAt: startTime,
    now,
    elapsed: now - startTime,
    points,
    summaries,

    toJSON() {
      return JSON.stringify({
        startedAt: new Date(this.startedAt).toISOString(),
        now: new Date(this.now).toISOString(),
        elapsed: this.elapsed,
        elapsedFormatted: formatDuration(this.elapsed),
        summaries: this.summaries,
        totalPoints: this.points.length,
        metrics: this.points,
      }, null, 2);
    },

    toCSV() {
      const headers = ["name", "value", "unit", "timestamp", "labels"];
      const rows = this.points.map((p) => [
        p.name,
        p.value,
        p.unit,
        new Date(p.timestamp).toISOString(),
        JSON.stringify(p.labels),
      ].map((v) => `"${v}"`).join(","));
      return [headers.join(","), ...rows].join("\n");
    },

    async saveToFile(directory: string) {
      const dir = path.join(directory, ".caravel");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

      await fs.promises.writeFile(
        path.join(dir, `metrics-${timestamp}.json`),
        this.toJSON(),
        "utf-8"
      );

      await fs.promises.writeFile(
        path.join(dir, `metrics-${timestamp}.csv`),
        this.toCSV(),
        "utf-8"
      );
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
