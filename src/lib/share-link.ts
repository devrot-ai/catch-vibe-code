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

/* ------------------------------------------------------------------ *
 * Compact wire format (lossless).
 *
 * Signals are stored as positional tuples instead of JSON objects, and
 * repeated strings (labels, evidence, source refs) are interned into a
 * shared string table — large repos repeat the same evidence text across
 * before/after snapshots, so this alone cuts the payload a lot. The
 * result is then gzip-compressed via CompressionStream when available.
 * ------------------------------------------------------------------ */

type CompactSignal = [id: number, cat: 0 | 1, label: number, weight: number, ev: number, src: number];
type CompactSnapshot = [target: number, kind: 0 | 1, vibe: number, ai: number, signals: CompactSignal[]];
type CompactPayload = [v: 2, strings: string[], before: CompactSnapshot, after: CompactSnapshot, at: number];

class Interner {
  private map = new Map<string, number>();
  readonly list: string[] = [];
  add(s: string | undefined): number {
    if (s === undefined) return -1;
    const hit = this.map.get(s);
    if (hit !== undefined) return hit;
    const i = this.list.length;
    this.list.push(s);
    this.map.set(s, i);
    return i;
  }
}

function compactSnapshot(snap: CompareSnapshot, t: Interner): CompactSnapshot {
  return [
    t.add(snap.target),
    snap.kind === "github" ? 0 : 1,
    snap.vibeScore,
    snap.aiScore,
    snap.signals.map(
      (s): CompactSignal => [
        t.add(s.id),
        s.category === "vibe" ? 0 : 1,
        t.add(s.label),
        s.weight,
        t.add(s.evidence),
        t.add(s.sourceRef),
      ],
    ),
  ];
}

function expandSnapshot(c: CompactSnapshot, strings: string[]): CompareSnapshot {
  const str = (i: number) => strings[i] ?? "";
  return {
    target: str(c[0]),
    kind: c[1] === 0 ? "github" : "website",
    vibeScore: c[2],
    aiScore: c[3],
    signals: c[4].map((s) => ({
      id: str(s[0]),
      category: s[1] === 0 ? "vibe" : "ai",
      label: str(s[2]),
      weight: s[3],
      evidence: str(s[4]),
      ...(s[5] >= 0 ? { sourceRef: str(s[5]) } : {}),
    })),
  };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("DecompressionStream unavailable");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode both snapshots into a URL-safe string.
 * Prefix `z` = gzipped compact form, `c` = uncompressed compact form.
 */
export async function encodeCompare(before: AnalysisResult, after: AnalysisResult): Promise<string> {
  const t = new Interner();
  const b = compactSnapshot(toSnapshot(before), t);
  const a = compactSnapshot(toSnapshot(after), t);
  const payload: CompactPayload = [2, t.list, b, a, Date.now()];
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const zipped = await gzip(raw);
  return zipped && zipped.length < raw.length ? `z${toBase64Url(zipped)}` : `c${toBase64Url(raw)}`;
}

/** Decode a share payload. Accepts compressed, compact, and legacy v1 links. */
export async function decodeCompare(encoded: string): Promise<ComparePayload | null> {
  try {
    const tag = encoded[0];
    let json: string;
    if (tag === "z") {
      json = new TextDecoder().decode(await gunzip(fromBase64Url(encoded.slice(1))));
    } else if (tag === "c") {
      json = new TextDecoder().decode(fromBase64Url(encoded.slice(1)));
    } else {
      // legacy v1: plain base64url JSON object
      const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
      if (!parsed || parsed.v !== 1 || !parsed.before || !parsed.after) return null;
      if (!Array.isArray(parsed.before.signals) || !Array.isArray(parsed.after.signals)) return null;
      return parsed as ComparePayload;
    }
    const c = JSON.parse(json) as CompactPayload;
    if (!Array.isArray(c) || c[0] !== 2 || !Array.isArray(c[1])) return null;
    return {
      v: 1,
      before: expandSnapshot(c[2], c[1]),
      after: expandSnapshot(c[3], c[1]),
      at: c[4],
    };
  } catch {
    return null;
  }
}
