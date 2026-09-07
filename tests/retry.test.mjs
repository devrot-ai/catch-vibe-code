import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RETRY_CONFIG,
  computeWaitMs,
  isRetryable,
  retryConfig,
  retryReason,
  serverWaitMs,
} from "../src/lib/detectors/retry.ts";

const res = (status, headers = {}) => ({ status, headers: new Headers(headers) });

test("retry decision matrix", () => {
  // Retryable: throttling, exhausted quota, transient server errors, timeouts.
  assert.equal(retryReason(res(429)), "rate-limited");
  assert.equal(retryReason(res(403, { "x-ratelimit-remaining": "0" })), "rate-limited");
  assert.equal(retryReason(res(500)), "server-error");
  assert.equal(retryReason(res(502)), "server-error");
  assert.equal(retryReason(res(503)), "server-error");
  assert.equal(retryReason(res(504)), "server-error");
  assert.equal(retryReason(null), "timeout");

  // Not retryable: real answers, including permission errors with quota left.
  assert.equal(retryReason(res(200)), null);
  assert.equal(retryReason(res(304)), null);
  assert.equal(retryReason(res(404)), null);
  assert.equal(retryReason(res(401)), null);
  assert.equal(retryReason(res(422)), null);
  assert.equal(retryReason(res(403, { "x-ratelimit-remaining": "42" })), null);
  assert.equal(retryReason(res(403)), null);

  assert.equal(isRetryable(res(429)), true);
  assert.equal(isRetryable(res(404)), false);
  assert.equal(isRetryable(null), true);
});

test("retry-after handling", () => {
  const now = 1_000_000_000_000;
  assert.equal(serverWaitMs(res(429, { "retry-after": "3" }), now), 3000);
  assert.equal(serverWaitMs(res(429, { "retry-after": "0" }), now), 0);
  // HTTP-date form.
  assert.equal(
    serverWaitMs(res(429, { "retry-after": new Date(now + 5000).toUTCString() }), now),
    5000,
  );
  // Garbage falls through to the rate-limit reset header.
  assert.equal(
    serverWaitMs(res(429, { "retry-after": "soon", "x-ratelimit-reset": String((now + 8000) / 1000) }), now),
    8000,
  );
  // A reset already in the past means "go now", never a negative wait.
  assert.equal(serverWaitMs(res(403, { "x-ratelimit-reset": String((now - 9000) / 1000) }), now), 0);
  // No hints at all.
  assert.equal(serverWaitMs(res(500), now), null);
  assert.equal(serverWaitMs(null, now), null);
});

test("wait computation honours hints, exponential curve and caps", () => {
  const cfg = { ...DEFAULT_RETRY_CONFIG, baseMs: 500, jitterMs: 250, maxSingleWaitMs: 10_000 };
  // No hint: 500 / 1000 / 2000 plus jitter.
  assert.equal(computeWaitMs(0, null, cfg, 0), 500);
  assert.equal(computeWaitMs(1, null, cfg, 0), 1000);
  assert.equal(computeWaitMs(2, null, cfg, 0), 2000);
  // Jitter is added on top, bounded by jitterMs.
  assert.equal(computeWaitMs(0, null, cfg, 1), 750);
  // Server hint wins over the curve, in both directions.
  assert.equal(computeWaitMs(2, 100, cfg, 0), 100);
  assert.equal(computeWaitMs(0, 6000, cfg, 0), 6000);
  // Single-wait cap applies to hints too.
  assert.equal(computeWaitMs(0, 120_000, cfg, 0), 10_000);
  assert.equal(computeWaitMs(9, null, cfg, 0), 10_000);
});

test("retry parameters are configurable through the environment", () => {
  assert.deepEqual(retryConfig({}), DEFAULT_RETRY_CONFIG);
  assert.deepEqual(
    retryConfig({
      GITHUB_RETRY_MAX_ATTEMPTS: "6",
      GITHUB_RETRY_BASE_MS: "250",
      GITHUB_RETRY_JITTER_MS: "0",
      GITHUB_RETRY_MAX_WAIT_MS: "5000",
      GITHUB_RETRY_TOTAL_WAIT_MS: "60000",
    }),
    { maxAttempts: 6, baseMs: 250, jitterMs: 0, maxSingleWaitMs: 5000, maxTotalWaitMs: 60_000 },
  );
  // Invalid or out-of-range values fall back / clamp instead of breaking a run.
  assert.equal(retryConfig({ GITHUB_RETRY_MAX_ATTEMPTS: "nope" }).maxAttempts, 4);
  assert.equal(retryConfig({ GITHUB_RETRY_MAX_ATTEMPTS: "0" }).maxAttempts, 1);
  assert.equal(retryConfig({ GITHUB_RETRY_MAX_ATTEMPTS: "999" }).maxAttempts, 10);
  assert.equal(retryConfig({ GITHUB_RETRY_BASE_MS: "-5" }).baseMs, 0);
});
