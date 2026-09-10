import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { analyzeGithub } from "../src/lib/detectors/github.ts";
import { categoryRaw, normalizeWeight, confidenceFor } from "../src/lib/detectors/scoring.ts";

const REPORT_DIR = "test-results";
const REPORT_PATH = `${REPORT_DIR}/e2e-scan-report.json`;

const MISSING_KEYS = ["LOVABLE_API_KEY", "GITHUB_API_KEY"].filter((k) => !process.env[k]);
const HAS_KEYS = MISSING_KEYS.length === 0;

// Make a self-skip impossible to miss: annotate it in CI and leave a marker
// file the workflow turns into a warning on the run summary.
if (!HAS_KEYS) {
  const msg = `E2E live scan skipped: missing ${MISSING_KEYS.join(", ")}. Configure these repository secrets or the scan is never exercised.`;
  console.log(`::warning title=E2E scan skipped::${msg}`);
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(`${REPORT_DIR}/e2e-skipped.txt`, `${MISSING_KEYS.join(",")}\n`);
}

/**
 * Dump the full scan result (raw signals, health banner, score breakdown) to
 * disk so CI can upload it as an artifact when the test fails. Never includes
 * credentials — only the analyzer's own output.
 */
async function writeScanReport(result, failure) {
  const report = {
    generatedAt: new Date().toISOString(),
    target: result?.target ?? "github.com/shadcn-ui/ui",
    failure: failure ? { name: failure.name, message: failure.message } : null,
    scores: result
      ? {
          vibe: result.vibeScore,
          ai: result.aiScore,
          confidence: result.confidence,
          raw: {
            vibe: categoryRaw(result.signals ?? [], "vibe"),
            ai: categoryRaw(result.signals ?? [], "ai"),
          },
          normalized: {
            vibe: normalizeWeight(categoryRaw(result.signals ?? [], "vibe")),
            ai: normalizeWeight(categoryRaw(result.signals ?? [], "ai")),
          },
        }
      : null,
    health: result?.health ?? null,
    // Throttling/retry stats for the run, so flaky CI runs can be diagnosed
    // without reproducing the scan locally.
    throttling: result?.health?.throttling ?? null,
    requests: result?.health?.requests ?? null,
    coverage: result?.coverage ?? null,
    error: result?.error ?? null,
    signals: (result?.signals ?? []).map((s) => ({
      id: s.id,
      category: s.category,
      weight: s.weight,
      label: s.label,
      evidence: s.evidence,
      sourceRef: s.sourceRef ?? null,
    })),
  };
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`scan report written to ${REPORT_PATH}`);
}

/**
 * Live end-to-end scan of a real repository. Skipped automatically when the
 * GitHub connector credentials are not present (local runs / forks), so CI
 * stays green without network access.
 */
test(
  "shadcn-ui/ui end-to-end scan keeps health, confidence and signals consistent",
  { skip: HAS_KEYS ? false : "GitHub connector credentials not configured", timeout: 120_000 },
  async () => {
    if (!HAS_KEYS) return; // credentials absent: skip (already warned above)
    let result;
    try {
      result = await analyzeGithub("shadcn-ui", "ui");
      // Written on pass and fail alike: the workflow turns it into a step
      // summary so a slow-but-green run still shows its throttling.
      await writeThrottlingSummary(result);
      assertScanResult(result);
      assertRetryLog(result);
    } catch (err) {
      await writeThrottlingSummary(result ?? null);
      // On failure the report lands in test-results/ for the CI artifact upload.
      await writeScanReport(result ?? null, err);
      throw err;
    }
  },
);

/** Always-written throttling snapshot, including the structured retry log. */
async function writeThrottlingSummary(result) {
  const health = result?.health ?? null;
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(
    THROTTLING_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        target: result?.target ?? "github.com/shadcn-ui/ui",
        status: health?.status ?? "unknown",
        label: health?.label ?? "Unknown",
        durationMs: health?.durationMs ?? 0,
        requests: health?.requests ?? null,
        throttling: health?.throttling ?? null,
        retryLog: health?.throttling?.events ?? [],
      },
      null,
      2,
    ),
  );
}

/** The structured retry log must agree with the retry counters. */
function assertRetryLog(result) {
  const th = result.health.throttling;
  const log = th.events;
  assert.ok(Array.isArray(log), "expected a structured retry log");
  const retries = log.filter((e) => e.type === "retry").length;
  const exhausted = log.filter((e) => e.type === "budget-exhausted").length;
  assert.equal(retries, Math.min(th.retries, log.length), "retry events must match the counter");
  assert.equal(exhausted, th.budgetExhausted, "budget-exhausted events must match the counter");
  for (const e of log) {
    assert.ok(["retry", "budget-exhausted"].includes(e.type));
    assert.ok(["rate-limited", "server-error", "timeout"].includes(e.reason));
    assert.ok(typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)));
    assert.ok(e.path === null || e.path.startsWith("/"), `bad retry event path ${e.path}`);
    assert.ok(Number.isFinite(e.waitMs) && e.waitMs >= 0);
    assert.ok(Number.isFinite(e.budgetSpentMs) && e.budgetSpentMs >= 0);
  }
}

function assertScanResult(result) {
  assert.equal(result.error, undefined, `scan failed: ${result.error}`);
  assert.equal(result.kind, "github");
  assert.equal(result.target, "github.com/shadcn-ui/ui");

  // --- health banner -----------------------------------------------------
  const health = result.health;
  assert.ok(health, "expected health metadata on the result");
  assert.ok(
    ["complete", "slow", "rate-limited", "blocked"].includes(health.status),
    `unexpected health status ${health.status}`,
  );
  assert.ok(health.label.length > 0 && health.detail.length > 0);
  assert.ok(health.durationMs > 0, "health duration should be measured");
  const r = health.requests;
  assert.ok(r.total > 0, "expected at least one tracked request");
  assert.ok(
    r.ok + r.blocked + r.rateLimited + r.timedOut <= r.total,
    "request counters must not exceed the total",
  );
  // Retries are attempts within a request, so they are tracked separately and
  // must never be reported as extra requests.
  assert.equal(typeof r.retries, "number", "expected a retry counter on health");
  assert.ok(r.retries >= 0, "retry counter must not be negative");
  const th = health.throttling;
  assert.ok(th, "expected throttling statistics on health");
  assert.equal(th.retries, r.retries, "throttling stats must agree with the retry counter");
  assert.equal(
    th.retriesByReason["rate-limited"] + th.retriesByReason["server-error"] + th.retriesByReason.timeout,
    th.retries,
    "every retry must be attributed to a reason",
  );
  assert.ok(th.waitedMs >= 0 && th.longestWaitMs >= 0);
  assert.ok(th.serverHintedWaits <= th.retries);
  assert.ok(
    r.retries <= r.total * 3,
    `retries ${r.retries} exceed the 3-per-request retry budget for ${r.total} requests`,
  );
  // The banner claims "complete" only when nothing was throttled or refused.
  if (health.status === "complete") {
    assert.equal(r.rateLimited, 0);
    assert.equal(r.blocked, 0);
    assert.equal(r.timedOut, 0);
  }


  // --- coverage ----------------------------------------------------------
  const coverage = result.coverage;
  assert.ok(coverage, "expected coverage metadata");
  assert.ok(coverage.sourcesAttempted > 0, "expected attempted sources");
  assert.ok(
    coverage.sourcesRead <= coverage.sourcesAttempted,
    `read ${coverage.sourcesRead} > attempted ${coverage.sourcesAttempted}`,
  );
  assert.ok(Array.isArray(coverage.notes));

  // --- signals -----------------------------------------------------------
  const signals = result.signals;
  assert.ok(signals.length > 0, "a real repo scan should produce signals");
  for (const s of signals) {
    assert.ok(["vibe", "ai"].includes(s.category), `bad category ${s.category}`);
    assert.ok(s.weight > 0, `${s.id} should carry a positive weight`);
    assert.ok(s.label.length > 0 && s.evidence.length > 0, `${s.id} missing label/evidence`);
  }
  // Duplicate keys would collapse rows in the results-page breakdown.
  const keys = signals.map((s) => `${s.id}::${s.sourceRef ?? ""}`);
  assert.equal(new Set(keys).size, keys.length, "signal id + sourceRef pairs must be unique");

  // Every AI-agent attribution must name an actual agent, never the human
  // author of a commit that merely carries an agent co-author trailer.
  const botSignal = signals.find((s) => s.id === "ai.bot_authors");
  if (botSignal) {
    assert.match(
      botSignal.evidence,
      /(claude|copilot|cursor|lovable|devin|codex|chatgpt)/i,
      `bot-author evidence should name an AI agent, got: ${botSignal.evidence}`,
    );
  }

  // --- scores match the breakdown the UI renders -------------------------
  const vibeRaw = categoryRaw(signals, "vibe");
  const aiRaw = categoryRaw(signals, "ai");
  const fullCoverage = coverage.sourcesRead / Math.max(1, coverage.sourcesAttempted) >= 0.3;
  if (fullCoverage) {
    assert.equal(result.vibeScore, normalizeWeight(vibeRaw));
    assert.equal(result.aiScore, normalizeWeight(aiRaw));
  }
  assert.ok(result.vibeScore >= 0 && result.vibeScore <= 100);
  assert.ok(result.aiScore >= 0 && result.aiScore <= 100);

  // --- confidence breakdown ---------------------------------------------
  const vibeCount = signals.filter((s) => s.category === "vibe").length;
  const aiCount = signals.filter((s) => s.category === "ai").length;
  assert.deepEqual(
    result.confidence.vibe,
    confidenceFor(result.vibeScore, vibeCount, coverage),
    "vibe confidence must be derived from the rendered score, signal count and coverage",
  );
  assert.deepEqual(
    result.confidence.ai,
    confidenceFor(result.aiScore, aiCount, coverage),
    "AI confidence must be derived from the rendered score, signal count and coverage",
  );

  // Expected shape of this specific repo: design-system heavy, and it should
  // never read as a zero-evidence scan.
  assert.ok(vibeCount > 0, "shadcn-ui/ui should produce vibe signals");
  assert.ok(result.vibeScore >= 35, `expected medium-or-higher vibe, got ${result.vibeScore}`);
}
