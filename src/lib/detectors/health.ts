/** Runtime health of a scan: how well the fetching phase actually went. */
export type HealthStatus = "complete" | "slow" | "rate-limited" | "blocked";

export interface ScanHealth {
  status: HealthStatus;
  label: string;
  detail: string;
  durationMs: number;
  requests: { total: number; ok: number; blocked: number; rateLimited: number; timedOut: number };
}

export interface HealthTracker {
  startedAt: number;
  total: number;
  ok: number;
  blocked: number;
  rateLimited: number;
  timedOut: number;
  usedFallback: boolean;
  record(res: { status: number } | null, opts?: { timedOut?: boolean }): void;
}

/** Requests slower than this make an otherwise-complete scan read as "slow". */
export const SLOW_SCAN_MS = 12_000;

export function createHealthTracker(): HealthTracker {
  return {
    startedAt: Date.now(),
    total: 0,
    ok: 0,
    blocked: 0,
    rateLimited: 0,
    timedOut: 0,
    usedFallback: false,
    record(res, opts) {
      this.total += 1;
      if (!res) {
        this.timedOut += 1;
        return;
      }
      if (opts?.timedOut) this.timedOut += 1;
      const s = res.status;
      if (s === 429) this.rateLimited += 1;
      else if (s === 401 || s === 403 || s === 451) this.blocked += 1;
      else if (s >= 200 && s < 400) this.ok += 1;
    },
  };
}

export function computeHealth(t: HealthTracker): ScanHealth {
  const durationMs = Date.now() - t.startedAt;
  const requests = {
    total: t.total,
    ok: t.ok,
    blocked: t.blocked,
    rateLimited: t.rateLimited,
    timedOut: t.timedOut,
  };
  const base = { durationMs, requests };

  if (t.rateLimited > 0) {
    return {
      ...base,
      status: "rate-limited",
      label: "Rate limited",
      detail: `${t.rateLimited} request${t.rateLimited === 1 ? "" : "s"} were throttled, so some evidence is missing. Wait a minute and rescan for a fuller picture.`,
    };
  }
  if (t.blocked > 0 || t.usedFallback) {
    const parts: string[] = [];
    if (t.blocked > 0)
      parts.push(
        t.blocked === 1
          ? "1 request was refused (401/403)"
          : `${t.blocked} requests were refused (401/403)`,
      );
    if (t.usedFallback) parts.push("the page had to be read through a rendering proxy");
    return {
      ...base,
      status: "blocked",
      label: "Partially blocked",
      detail: `${parts.join(" and ")}. Scores are based on the sources that did load.`,
    };
  }
  if (durationMs >= SLOW_SCAN_MS || t.timedOut > 0) {
    return {
      ...base,
      status: "slow",
      label: "Slow scan",
      detail:
        t.timedOut > 0
          ? `${t.timedOut} request${t.timedOut === 1 ? "" : "s"} timed out after ${Math.round(durationMs / 1000)}s; a rescan may pick up more evidence.`
          : `The scan took ${Math.round(durationMs / 1000)}s. All sources answered, just slowly.`,
    };
  }
  return {
    ...base,
    status: "complete",
    label: "Complete",
    detail: `All ${t.total} source request${t.total === 1 ? "" : "s"} finished in ${(durationMs / 1000).toFixed(1)}s with no throttling or blocking.`,
  };
}
