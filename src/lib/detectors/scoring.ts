import type { Signal, ScoreConfidence, ConfidenceLevel } from "./signals";

export interface Coverage {
  sourcesRead: number;
  sourcesAttempted: number;
  notes: string[];
}

export function emptyCoverage(): Coverage {
  return { sourcesRead: 0, sourcesAttempted: 0, notes: [] };
}

/**
 * Raw weights are summed then passed through a saturating curve so that no
 * single strong signal pins the score at 100 and many weak signals still add up.
 * K is tuned so ~45 raw weight lands around 63 (the "high" bucket boundary).
 */
const K = 45;

export function normalizeWeight(raw: number): number {
  if (raw <= 0) return 0;
  return Math.round(100 * (1 - Math.exp(-raw / K)));
}

export function categoryRaw(signals: Signal[], category: "vibe" | "ai"): number {
  return signals.filter((s) => s.category === category).reduce((sum, s) => sum + s.weight, 0);
}

export interface ScoredResult {
  vibe: number;
  ai: number;
  vibeRaw: number;
  aiRaw: number;
}

export function computeScores(signals: Signal[], coverage: Coverage): ScoredResult {
  const vibeRaw = categoryRaw(signals, "vibe");
  const aiRaw = categoryRaw(signals, "ai");
  // If we could barely read anything, damp the score rather than reporting a
  // confident zero-ish number.
  const readRatio =
    coverage.sourcesAttempted > 0
      ? Math.min(1, coverage.sourcesRead / Math.max(1, coverage.sourcesAttempted))
      : 1;
  const damp = readRatio < 0.3 ? 0.6 + readRatio : 1;
  return {
    vibe: normalizeWeight(vibeRaw * damp),
    ai: normalizeWeight(aiRaw * damp),
    vibeRaw,
    aiRaw,
  };
}

export function confidenceFor(
  score: number,
  signalCount: number,
  coverage: Coverage,
): ScoreConfidence {
  const distance = Math.min(Math.abs(score - 35), Math.abs(score - 65));
  const thinCoverage = coverage.sourcesRead <= 1;

  let level: ConfidenceLevel;
  let detail: string;

  if (thinCoverage || signalCount <= 1 || distance <= 5) {
    level = "low";
    detail = thinCoverage
      ? `Only ${coverage.sourcesRead} of ${coverage.sourcesAttempted} sources could be read, so evidence is thin.`
      : signalCount <= 1
        ? `Only ${signalCount} signal fired.`
        : "Score sits close to a bucket boundary and can move with small evidence changes.";
  } else if (signalCount <= 3 || distance <= 12 || coverage.sourcesRead <= 3) {
    level = "medium";
    detail = `Read ${coverage.sourcesRead}/${coverage.sourcesAttempted} sources and matched ${signalCount} signals — directionally sound but not heavily reinforced.`;
  } else {
    level = "high";
    detail = `Read ${coverage.sourcesRead}/${coverage.sourcesAttempted} sources and matched ${signalCount} reinforcing signals, well clear of the bucket boundaries.`;
  }

  const label =
    level === "high" ? "High confidence" : level === "medium" ? "Medium confidence" : "Low confidence";
  return { level, label, detail };
}
