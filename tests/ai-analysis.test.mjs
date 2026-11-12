import assert from "node:assert/strict";
import test from "node:test";

import { githubAccessStatus } from "../src/lib/detectors/github-access.ts";
import { parseRetryTimeline, validateScanExplanationInput } from "../src/lib/ai-analysis.ts";

const retryEvent = {
  at: "2026-11-05T09:00:00.000Z",
  path: "/repos/example/project",
  attempt: 0,
  type: "retry",
  reason: "rate-limited",
  status: 429,
  hintedMs: 1000,
  serverHinted: true,
  waitMs: 1000,
  budgetSpentMs: 1000,
  completedAt: "2026-11-05T09:00:01.000Z",
  nextAttempt: 1,
  outcome: "recovered",
  outcomeStatus: 200,
};

test("GitHub scan access status distinguishes authenticated and anonymous results", () => {
  assert.deepEqual(githubAccessStatus(true), { mode: "authenticated" });
  assert.equal(githubAccessStatus(false).mode, "anonymous");
  assert.match(githubAccessStatus(false).warning, /lower anonymous rate limits/);
  assert.match(githubAccessStatus(true, true).warning, /Authenticated GitHub access failed/);
});

test("retry timeline parser accepts a report and summarizes its sequence", () => {
  const parsed = parseRetryTimeline(JSON.stringify({
    schemaVersion: 2,
    retryTimeline: [retryEvent],
    retryLog: [retryEvent],
    throttling: { events: [retryEvent] },
  }));
  assert.equal(parsed.retries, 1);
  assert.equal(parsed.waitedMs, 1000);
  assert.equal(parsed.longestWaitMs, 1000);
  assert.equal(parsed.serverHintedWaits, 1);
});

test("retry timeline parser rejects malformed and inconsistent reports", () => {
  assert.throws(() => parseRetryTimeline("not json"), /valid JSON/);
  assert.throws(() => parseRetryTimeline(JSON.stringify([{ ...retryEvent, waitMs: -1 }])), /valid event fields/);
  assert.throws(() => parseRetryTimeline(JSON.stringify({ retryTimeline: [], retryLog: [retryEvent] })), /don’t match/);
  assert.throws(() => parseRetryTimeline(JSON.stringify({ schemaVersion: 1, retryTimeline: [retryEvent] })), /version isn’t supported/);
  assert.throws(() => parseRetryTimeline(JSON.stringify([{ ...retryEvent, completedAt: "invalid" }])), /valid timestamps/);
});

test("scan explanation input validates evidence and confidence fields", () => {
  const valid = {
    target: "github.com/example/project",
    kind: "github",
    vibeScore: 45,
    aiScore: 30,
    confidence: {
      vibe: { level: "medium", detail: "Several signals fired." },
      ai: { level: "low", detail: "Only one signal fired." },
    },
    signals: [{ category: "vibe", label: "Design tokens", weight: 10, evidence: "tokens found", sourceRef: "styles.css" }],
  };
  assert.equal(validateScanExplanationInput(valid).signals.length, 1);
  assert.throws(() => validateScanExplanationInput({ ...valid, vibeScore: 101 }));
});