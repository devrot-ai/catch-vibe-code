import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  throttlingReportToCsv,
  validateAndExport,
  validateThrottlingReport,
} from "../scripts/validate-throttling-report.mjs";

const event = {
  at: "2026-09-11T09:14:00.000Z",
  path: "/repos/example/repo,with-comma",
  attempt: 0,
  type: "retry",
  reason: "rate-limited",
  status: 429,
  hintedMs: 1000,
  serverHinted: true,
  waitMs: 1000,
  budgetSpentMs: 1000,
};

const report = (events = [event]) => ({
  schemaVersion: 1,
  generatedAt: "2026-09-11T09:14:00.000Z",
  target: "github.com/example/repo",
  status: "complete",
  label: "Complete",
  durationMs: 1500,
  requests: { total: 1, ok: 1, blocked: 0, rateLimited: 0, timedOut: 0, retries: events.length },
  throttling: {
    retries: events.length,
    retriesByReason: { "rate-limited": events.length, "server-error": 0, timeout: 0 },
    waitedMs: events.length ? 1000 : 0,
    longestWaitMs: events.length ? 1000 : 0,
    serverHintedWaits: events.length,
    budgetExhausted: 0,
    events,
  },
  retryLog: events,
});

test("accepts a complete versioned throttling report", () => {
  assert.equal(validateThrottlingReport(report()).schemaVersion, 1);
});

test("rejects missing required per-scan retry fields", () => {
  const value = report();
  delete value.throttling.longestWaitMs;
  assert.throws(() => validateThrottlingReport(value), /longestWaitMs/);
});

test("rejects unsupported versions and malformed retry events", () => {
  assert.throws(() => validateThrottlingReport({ ...report(), schemaVersion: 2 }), /version 2/);
  const value = report();
  value.retryLog[0] = { ...event, waitMs: -1 };
  value.throttling.events = value.retryLog;
  assert.throws(() => validateThrottlingReport(value), /waitMs/);
});

test("exports one escaped CSV row per retry event", () => {
  const csv = throttlingReportToCsv(report());
  assert.match(csv, /^schema_version,generated_at,/);
  assert.match(csv, /"\/repos\/example\/repo,with-comma"/);
  assert.match(csv, /,1,2026-09-11T09:14:00\.000Z,/);
});

test("exports a summary row when the scan has no retries", () => {
  const csv = throttlingReportToCsv(report([]));
  assert.equal(csv.trim().split("\n").length, 2);
  assert.match(csv, /,0,0,0,0,0,0,,,,,,,,,,,\n$/);
});

test("validates a JSON file before writing its CSV", async () => {
  const dir = await mkdtemp(join(tmpdir(), "throttling-report-"));
  const input = join(dir, "report.json");
  const output = join(dir, "report.csv");
  await writeFile(input, JSON.stringify(report()));
  await validateAndExport(input, output);
  assert.match(await readFile(output, "utf8"), /retry_count/);
});