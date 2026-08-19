import assert from "node:assert/strict";
import test from "node:test";

import { analyzeGithub } from "../src/lib/detectors/github.ts";
import { categoryRaw, normalizeWeight, confidenceFor } from "../src/lib/detectors/scoring.ts";

const HAS_KEYS = Boolean(process.env.LOVABLE_API_KEY && process.env.GITHUB_API_KEY);

/**
 * Live end-to-end scan of a real repository. Skipped automatically when the
 * GitHub connector credentials are not present (local runs / forks), so CI
 * stays green without network access.
 */
test(
  "shadcn-ui/ui end-to-end scan keeps health, confidence and signals consistent",
  { skip: HAS_KEYS ? false : "GitHub connector credentials not configured", timeout: 120_000 },
  async () => {
    const result = await analyzeGithub("shadcn-ui", "ui");

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
  },
);
