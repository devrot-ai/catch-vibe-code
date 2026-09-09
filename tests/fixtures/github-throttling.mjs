/**
 * Offline, deterministic GitHub throttling fixture.
 *
 * Lets retry tests run with no network, no real waiting and no randomness:
 * every scenario is a scripted list of responses per request path, replayed by
 * a fake `fetch`. A virtual clock records how long the retry logic *would* have
 * waited, so backoff curves and caps can be asserted exactly.
 */

/** Build a Response-like object (status + headers) without touching the network. */
export function mockResponse(status, { headers = {}, body = "" } = {}) {
  return new Response(body, { status, headers });
}

/** A network failure / timeout: the client turns a throw into `null`. */
export const NETWORK_ERROR = Symbol("network-error");

/** Common canned responses. */
export const responses = {
  ok: (body = { ok: true }) =>
    mockResponse(200, {
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
      body: JSON.stringify(body),
    }),
  rateLimited: (retryAfterSeconds) =>
    mockResponse(429, {
      headers: retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) },
    }),
  quotaExhausted: (resetEpochSeconds) =>
    mockResponse(403, {
      headers: {
        "x-ratelimit-remaining": "0",
        ...(resetEpochSeconds === undefined ? {} : { "x-ratelimit-reset": String(resetEpochSeconds) }),
      },
    }),
  serverError: (status = 502) => mockResponse(status),
  notFound: () => mockResponse(404),
  forbidden: () => mockResponse(403, { headers: { "x-ratelimit-remaining": "42" } }),
  timeout: () => NETWORK_ERROR,
};

/**
 * A scripted gateway.
 *
 * `script` maps a path substring to an array of responses returned in order;
 * the last entry repeats once the list is exhausted. `"*"` is the fallback.
 */
export function createMockGateway(script) {
  const calls = [];
  const counters = new Map();

  const pick = (url) => {
    const key =
      Object.keys(script).find((k) => k !== "*" && url.includes(k)) ??
      ("*" in script ? "*" : null);
    if (key === null) throw new Error(`No fixture entry for ${url}`);
    const seq = script[key];
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return seq[Math.min(n, seq.length - 1)];
  };

  const fetchImpl = async (url) => {
    const value = pick(String(url));
    calls.push(String(url));
    if (value === NETWORK_ERROR) throw new Error("simulated network timeout");
    // Fresh clone per attempt so a body can be read more than once.
    return value.clone();
  };

  return {
    fetchImpl,
    calls,
    /** How many attempts were made against a given path fragment. */
    attempts: (fragment) => calls.filter((u) => u.includes(fragment)).length,
    get total() {
      return calls.length;
    },
  };
}

/** Virtual clock: records waits instead of performing them. */
export function createFakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  const waits = [];
  return {
    now: () => now,
    waits,
    get totalWaitedMs() {
      return waits.reduce((a, b) => a + b, 0);
    },
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
}

/** Deterministic jitter source: always the same value (0 by default). */
export const fixedJitter =
  (value = 0) =>
  () =>
    value;

/** Ready-made scenarios covering the throttling behaviours worth locking down. */
export const scenarios = {
  /** Throttled twice, then succeeds. */
  recoversAfterTwoRateLimits: {
    "*": [responses.rateLimited(), responses.rateLimited(), responses.ok()],
  },
  /** Server tells us exactly how long to wait. */
  honoursRetryAfter: {
    "*": [responses.rateLimited(3), responses.ok()],
  },
  /** Quota exhausted with a reset hint, then recovers. */
  quotaResetHint: {
    "*": [responses.quotaExhausted(), responses.ok()],
  },
  /** Transient gateway errors, then success. */
  transientServerErrors: {
    "*": [responses.serverError(502), responses.serverError(503), responses.ok()],
  },
  /** Network timeouts, then success. */
  timeoutsThenSuccess: {
    "*": [responses.timeout(), responses.timeout(), responses.ok()],
  },
  /** Never recovers: retries are exhausted. */
  permanentlyThrottled: { "*": [responses.rateLimited()] },
  /** A real answer that must never be retried. */
  notFound: { "*": [responses.notFound()] },
  /** Permission error with quota left: also never retried. */
  forbiddenWithQuota: { "*": [responses.forbidden()] },
};
