import { type AnalysisResult, type Signal, scoreFromSignals, scoreConfidence } from "./signals";
import { runSignalRules } from "./rule-engine";
import { createStylesheetRules, createWebsiteHtmlRules } from "./rule-catalog";

async function fetchText(url: string, maxBytes = 2_000_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "VibeDetector/1.0 (+https://lovable.dev)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text|css|html|javascript|json/i.test(ct)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

function extractStylesheetLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi;
  const hrefRe = /href=["']([^"']+)["']/i;
  const matches = html.match(re) ?? [];
  for (const tag of matches) {
    const h = hrefRe.exec(tag);
    if (h) {
      try {
        out.push(new URL(h[1], base).toString());
      } catch {
        // ignore
      }
    }
  }
  return out.slice(0, 2);
}

export async function analyzeWebsite(inputUrl: string): Promise<AnalysisResult> {
  const target = inputUrl;
  const html = await fetchText(inputUrl);
  if (!html) {
    return {
      target,
      kind: "website",
      vibeScore: 0,
      aiScore: 0,
      confidence: { vibe: scoreConfidence(0, 0), ai: scoreConfidence(0, 0) },
      signals: [],
      error: "Could not fetch page (blocked, timed out, or not HTML).",
    };
  }

  const signals: Signal[] = [];

  signals.push(...runSignalRules(html, "index.html", createWebsiteHtmlRules()));

  // Fetch a couple of stylesheets
  const cssLinks = extractStylesheetLinks(html, inputUrl);
  for (const link of cssLinks) {
    const css = await fetchText(link, 1_000_000);
    if (!css) continue;
    signals.push(...runSignalRules(css, link, createStylesheetRules(link)));
  }

  const { vibe, ai } = scoreFromSignals(signals);
  const vibeSignals = signals.filter((signal) => signal.category === "vibe");
  const aiSignals = signals.filter((signal) => signal.category === "ai");
  return {
    target,
    kind: "website",
    vibeScore: vibe,
    aiScore: ai,
    confidence: {
      vibe: scoreConfidence(vibe, vibeSignals.length),
      ai: scoreConfidence(ai, aiSignals.length),
    },
    signals,
  };
}
