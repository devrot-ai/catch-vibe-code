/**
 * Retry policy for GitHub gateway throttling.
 *
 * All parameters are tunable through environment variables so CI can be made
 * more (or less) patient without a code change:
 *
 *   GITHUB_RETRY_MAX_ATTEMPTS   total attempts per request (default 4 = 1 + 3 retries)
 *   GITHUB_RETRY_BASE_MS        first backoff step, doubled each retry (default 500)
 *   GITHUB_RETRY_JITTER_MS      random extra wait added per retry (default 250)
 *   GITHUB_RETRY_MAX_WAIT_MS    cap for a single wait (default 10000)
 *   GITHUB_RETRY_TOTAL_WAIT_MS  cap for all waiting in one scan (default 20000)
 */
export interface RetryConfig {
  maxAttempts: number;
  baseMs: number;
  jitterMs: number;
  maxSingleWaitMs: number;
  maxTotalWaitMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  baseMs: 500,
  jitterMs: 250,
  maxSingleWaitMs: 10_000,
  maxTotalWaitMs: 20_000,
};

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Read the retry policy from the environment, falling back to the defaults. */
export function retryConfig(env: Record<string, string | undefined> = process.env): RetryConfig {
  return {
    maxAttempts: Math.round(num(env["GITHUB_RETRY_MAX_ATTEMPTS"], 4, 1, 10)),
    baseMs: num(env["GITHUB_RETRY_BASE_MS"], 500, 0, 60_000),
    jitterMs: num(env["GITHUB_RETRY_JITTER_MS"], 250, 0, 60_000),
    maxSingleWaitMs: num(env["GITHUB_RETRY_MAX_WAIT_MS"], 10_000, 0, 120_000),
    maxTotalWaitMs: num(env["GITHUB_RETRY_TOTAL_WAIT_MS"], 20_000, 0, 600_000),
  };
}

export type RetryReason = "timeout" | "rate-limited" | "server-error" | null;

/** Why a response should be retried, or null when it is a real answer. */
export function retryReason(res: { status: number; headers?: Headers } | null): RetryReason {
  if (!res) return "timeout"; // network error / abort
  if (res.status === 429) return "rate-limited";
  if (res.status === 403 && res.headers?.get("x-ratelimit-remaining") === "0")
    return "rate-limited";
  if (res.status >= 500 && res.status <= 599) return "server-error";
  return null;
}

/** True when the response means "try again later" rather than a real answer. */
export function isRetryable(res: { status: number; headers?: Headers } | null): boolean {
  return retryReason(res) !== null;
}

/** The server's own hint (retry-after seconds, or rate-limit reset epoch). */
export function serverWaitMs(
  res: { headers?: Headers } | null,
  now: number = Date.now(),
): number | null {
  const headers = res?.headers;
  if (!headers) return null;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(retryAfter); // HTTP-date form
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const at = Number(reset) * 1000;
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return null;
}

/** Wait before retry `attempt` (0-based), honouring the server hint when present. */
export function computeWaitMs(
  attempt: number,
  hintedMs: number | null,
  cfg: RetryConfig = DEFAULT_RETRY_CONFIG,
  jitter = Math.random(),
): number {
  const backoff = cfg.baseMs * 2 ** attempt;
  const chosen = hintedMs ?? backoff;
  return Math.min(chosen, cfg.maxSingleWaitMs) + jitter * cfg.jitterMs;
}

/** Minimal surface the runner needs from the health tracker. */
export interface RetryRecorder {
  recordRetry(reason: Exclude<RetryReason, null>, waitMs: number, serverHinted: boolean): void;
  recordRetryBudgetExhausted(): void;
}

/** One machine-parsable retry event, emitted as it happens. */
export interface RetryEvent {
  /** ISO timestamp (from the injected clock, so tests stay deterministic). */
  at: string;
  /** Request path that was retried, when the caller supplies one. */
  path: string | null;
  /** 0-based index of the attempt that failed and triggered this event. */
  attempt: number;
  type: "retry" | "budget-exhausted";
  reason: Exclude<RetryReason, null>;
  /** HTTP status of the failed attempt, null for a network error/timeout. */
  status: number | null;
  /** Wait the server asked for (retry-after / rate-limit reset), if any. */
  hintedMs: number | null;
  serverHinted: boolean;
  /** Wait actually taken; 0 for a budget-exhausted event. */
  waitMs: number;
  /** Total backoff spent in this scan after the event. */
  budgetSpentMs: number;
}

/** Cap so a badly throttled run cannot produce an enormous artifact. */
export const MAX_RETRY_EVENTS = 500;

export interface RetryRunnerOptions {
  /** Injectable for deterministic offline tests (no real waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1). */
  jitter?: () => number;
  /** Injectable clock, used when reading server reset hints. */
  now?: () => number;
  /** Structured retry log sink. */
  onEvent?: (event: RetryEvent) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build a retry runner whose backoff budget is shared across every request in
 * one scan, so a throttled run degrades gracefully instead of stalling.
 */
export function createRetryRunner(
  cfg: RetryConfig,
  recorder: RetryRecorder,
  opts: RetryRunnerOptions = {},
) {
  const sleep = opts.sleep ?? realSleep;
  const jitter = opts.jitter ?? Math.random;
  const now = opts.now ?? Date.now;
  const onEvent = opts.onEvent;
  let backoffSpentMs = 0;

  return async function run<T extends { status: number; headers?: Headers } | null>(
    attempt: (attemptIndex: number) => Promise<T>,
    path: string | null = null,
  ): Promise<T> {
    let res = (await attempt(0)) as T;
    const lastAttempt = cfg.maxAttempts - 1;
    for (let i = 0; i < lastAttempt; i += 1) {
      const reason = retryReason(res);
      if (reason === null) break;

      const hinted = serverWaitMs(res, now());
      const wait = computeWaitMs(i, hinted, cfg, jitter());
      const base = {
        at: new Date(now()).toISOString(),
        path,
        attempt: i,
        reason,
        status: res ? res.status : null,
        hintedMs: hinted,
        serverHinted: hinted !== null,
      };
      if (backoffSpentMs + wait > cfg.maxTotalWaitMs) {
        recorder.recordRetryBudgetExhausted();
        onEvent?.({ ...base, type: "budget-exhausted", waitMs: 0, budgetSpentMs: backoffSpentMs });
        break;
      }
      backoffSpentMs += wait;
      recorder.recordRetry(reason, wait, hinted !== null);
      onEvent?.({ ...base, type: "retry", waitMs: wait, budgetSpentMs: backoffSpentMs });
      await sleep(wait);
      res = (await attempt(i + 1)) as T;
    }
    return res;
  };
}
