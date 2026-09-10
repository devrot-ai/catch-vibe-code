/**
 * Offline retry tests: no network, no real waiting, no randomness.
 * Everything runs against the scripted fixture gateway.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { computeHealth, createHealthTracker } from "../src/lib/detectors/health.ts";
import { makeClient } from "../src/lib/detectors/github.ts";
import { DEFAULT_RETRY_CONFIG, MAX_RETRY_EVENTS } from "../src/lib/detectors/retry.ts";
import {
  createFakeClock,
  createMockGateway,
  fixedJitter,
  responses,
  scenarios,
} from "./fixtures/github-throttling.mjs";

function harness(script, config = {}) {
  const gateway = createMockGateway(script);
  const clock = createFakeClock();
  const health = createHealthTracker();
  const client = makeClient("test-key", "test-conn", health, {
    fetchImpl: gateway.fetchImpl,
    config: { ...DEFAULT_RETRY_CONFIG, ...config },
    runnerOptions: { sleep: clock.sleep, now: clock.now, jitter: fixedJitter(0) },
  });
  return { gateway, clock, health, client };
}

test("recovers after throttling, with exponential waits", async () => {
  const h = harness(scenarios.recoversAfterTwoRateLimits);
  const res = await h.client.raw("/repos/a/b");

  assert.equal(res.status, 200);
  assert.equal(h.gateway.total, 3, "one original attempt plus two retries");
  assert.deepEqual(h.clock.waits, [500, 1000], "0.5s then 1s backoff");
  assert.equal(h.health.retries, 2);
  assert.equal(h.health.retriesByReason["rate-limited"], 2);
  // Only the final attempt is the request outcome.
  assert.equal(h.health.total, 1);
  assert.equal(h.health.ok, 1);
  assert.equal(h.health.rateLimited, 0);
});

test("honours a retry-after hint instead of the curve", async () => {
  const h = harness(scenarios.honoursRetryAfter);
  await h.client.raw("/repos/a/b");
  assert.deepEqual(h.clock.waits, [3000]);
  assert.equal(h.health.serverHintedWaits, 1);
});

test("honours a rate-limit reset hint on an exhausted-quota 403", async () => {
  const clockStart = 1_700_000_000_000;
  const gateway = createMockGateway({
    "*": [responses.quotaExhausted((clockStart + 4000) / 1000), responses.ok()],
  });
  const clock = createFakeClock(clockStart);
  const health = createHealthTracker();
  const client = makeClient("k", "c", health, {
    fetchImpl: gateway.fetchImpl,
    config: DEFAULT_RETRY_CONFIG,
    runnerOptions: { sleep: clock.sleep, now: clock.now, jitter: fixedJitter(0) },
  });

  const res = await client.raw("/repos/a/b");
  assert.equal(res.status, 200);
  assert.deepEqual(clock.waits, [4000]);
  assert.equal(health.serverHintedWaits, 1);
});

test("retries transient server errors and timeouts", async () => {
  const server = harness(scenarios.transientServerErrors);
  await server.client.raw("/repos/a/b");
  assert.equal(server.health.retriesByReason["server-error"], 2);

  const timeouts = harness(scenarios.timeoutsThenSuccess);
  const res = await timeouts.client.raw("/repos/a/b");
  assert.equal(res.status, 200);
  assert.equal(timeouts.health.retriesByReason.timeout, 2);
  assert.equal(timeouts.health.timedOut, 0, "the successful final attempt is the outcome");
});

test("gives up after the configured attempts and reports rate limiting", async () => {
  const h = harness(scenarios.permanentlyThrottled);
  const res = await h.client.raw("/repos/a/b");

  assert.equal(res.status, 429);
  assert.equal(h.gateway.total, DEFAULT_RETRY_CONFIG.maxAttempts);
  assert.equal(h.health.retries, DEFAULT_RETRY_CONFIG.maxAttempts - 1);
  assert.equal(h.health.rateLimited, 1);
  assert.deepEqual(h.clock.waits, [500, 1000, 2000]);
});

test("real answers are never retried", async () => {
  const missing = harness(scenarios.notFound);
  await missing.client.raw("/repos/a/b");
  assert.equal(missing.gateway.total, 1);
  assert.equal(missing.health.retries, 0);

  const forbidden = harness(scenarios.forbiddenWithQuota);
  await forbidden.client.raw("/repos/a/b");
  assert.equal(forbidden.gateway.total, 1);
  assert.equal(forbidden.health.blocked, 1);
});

test("the scan-wide wait budget stops runaway backoff", async () => {
  const h = harness(scenarios.permanentlyThrottled, { maxTotalWaitMs: 600 });
  await h.client.raw("/repos/a/b");

  assert.deepEqual(h.clock.waits, [500], "second 1s wait exceeds the 600ms budget");
  assert.equal(h.health.retryBudgetExhausted, 1);
  assert.equal(h.gateway.total, 2);
});

test("the budget is shared across requests in one scan", async () => {
  const h = harness(scenarios.permanentlyThrottled, { maxTotalWaitMs: 1200 });
  await h.client.raw("/repos/a/b");
  await h.client.raw("/repos/c/d");

  assert.equal(h.clock.totalWaitedMs <= 1200, true);
  assert.equal(h.health.retryBudgetExhausted >= 1, true);
});

test("attempts can be scripted per path", async () => {
  const h = harness({
    "/repos/a/b": [responses.rateLimited(), responses.ok()],
    "*": [responses.notFound()],
  });
  await h.client.raw("/repos/a/b");
  await h.client.raw("/repos/x/y");

  assert.equal(h.gateway.attempts("/repos/a/b"), 2);
  assert.equal(h.gateway.attempts("/repos/x/y"), 1);
});

test("json() decodes the recovered response body", async () => {
  const h = harness({ "*": [responses.rateLimited(), responses.ok({ full_name: "a/b" })] });
  const body = await h.client.json("/repos/a/b");
  assert.deepEqual(body, { full_name: "a/b" });
});

test("structured retry events are logged for each attempt", async () => {
  const h = harness(scenarios.recoversAfterTwoRateLimits);
  await h.client.raw("/repos/a/b");

  const log = h.health.retryEvents;
  assert.equal(log.length, 2);
  assert.deepEqual(
    log.map((e) => [e.type, e.path, e.attempt, e.reason, e.status, e.waitMs, e.budgetSpentMs]),
    [
      ["retry", "/repos/a/b", 0, "rate-limited", 429, 500, 500],
      ["retry", "/repos/a/b", 1, "rate-limited", 429, 1000, 1500],
    ],
  );
  for (const e of log) assert.ok(!Number.isNaN(Date.parse(e.at)), "events carry a timestamp");
  // The same log is exposed on the computed health for the scan report.
  assert.deepEqual(computeHealth(h.health).throttling.events, log);
});

test("a timeout retry and an exhausted budget are logged distinctly", async () => {
  const timeouts = harness(scenarios.timeoutsThenSuccess);
  await timeouts.client.raw("/repos/a/b");
  assert.deepEqual(
    timeouts.health.retryEvents.map((e) => [e.reason, e.status, e.serverHinted]),
    [
      ["timeout", null, false],
      ["timeout", null, false],
    ],
  );

  const budget = harness(scenarios.permanentlyThrottled, { maxTotalWaitMs: 600 });
  await budget.client.raw("/repos/a/b");
  const types = budget.health.retryEvents.map((e) => e.type);
  assert.deepEqual(types, ["retry", "budget-exhausted"]);
  assert.equal(budget.health.retryEvents.at(-1).waitMs, 0);
});

test("a server-hinted wait is flagged in the log", async () => {
  const h = harness(scenarios.honoursRetryAfter);
  await h.client.raw("/repos/a/b");
  const [event] = h.health.retryEvents;
  assert.equal(event.serverHinted, true);
  assert.equal(event.hintedMs, 3000);
  assert.equal(event.waitMs, 3000);
});

test("the retry log is capped so an artifact cannot grow unbounded", async () => {
  const health = createHealthTracker();
  const event = {
    at: new Date().toISOString(),
    path: "/x",
    attempt: 0,
    type: "retry",
    reason: "rate-limited",
    status: 429,
    hintedMs: null,
    serverHinted: false,
    waitMs: 1,
    budgetSpentMs: 1,
  };
  for (let i = 0; i < MAX_RETRY_EVENTS + 25; i += 1) health.recordRetryEvent({ ...event });
  assert.equal(health.retryEvents.length, MAX_RETRY_EVENTS);
});
