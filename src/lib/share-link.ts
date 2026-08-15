import type { AnalysisResult, Signal } from "./detectors/signals";

/** Minimal snapshot needed to render a comparison. */
export interface CompareSnapshot {
  target: string;
  kind: AnalysisResult["kind"];
  vibeScore: number;
  aiScore: number;
  signals: Signal[];
}

export interface ComparePayload {
  v: 1;
  before: CompareSnapshot;
  after: CompareSnapshot;
  at: number;
}

function toSnapshot(r: AnalysisResult): CompareSnapshot {
  return {
    target: r.target,
    kind: r.kind,
    vibeScore: r.vibeScore,
    aiScore: r.aiScore,
    signals: r.signals.map((s) => ({
      id: s.id,
      category: s.category,
      label: s.label,
      weight: s.weight,
      evidence: s.evidence,
      ...(s.sourceRef ? { sourceRef: s.sourceRef } : {}),
    })),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeCompare(before: AnalysisResult, after: AnalysisResult): string {
  const payload: ComparePayload = {
    v: 1,
    before: toSnapshot(before),
    after: toSnapshot(after),
    at: Date.now(),
  };
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeCompare(encoded: string): ComparePayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
    if (!parsed || parsed.v !== 1 || !parsed.before || !parsed.after) return null;
    if (!Array.isArray(parsed.before.signals) || !Array.isArray(parsed.after.signals)) return null;
    return parsed as ComparePayload;
  } catch {
    return null;
  }
}
