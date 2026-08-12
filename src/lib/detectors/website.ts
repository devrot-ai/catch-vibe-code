import {
  type AnalysisResult,
  type Signal,
  detectTailwindClassDensity,
  detectCssVariables,
  detectHslTokens,
  detectArbitraryValues,
} from "./signals";
import { computeScores, confidenceFor, emptyCoverage, type Coverage } from "./scoring";

interface Fetched {
  text: string;
  headers: Headers;
}

async function fetchDoc(url: string, maxBytes = 2_500_000): Promise<Fetched | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; VibeDetector/1.0; +https://lovable.dev) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,text/css,application/javascript,*/*",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    return { text: new TextDecoder().decode(buf), headers: res.headers };
  } catch {
    return null;
  }
}

/** Some sites block server-side fetches; fall back to a rendered-HTML proxy. */
async function fetchPage(url: string): Promise<Fetched | null> {
  const direct = await fetchDoc(url);
  if (direct) return direct;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "X-Return-Format": "html" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.length < 200) return null;
    return { text, headers: res.headers };
  } catch {
    return null;
  }
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function extractAssets(html: string, base: string) {
  const css: string[] = [];
  const js: string[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  for (const tag of html.match(linkRe) ?? []) {
    if (!/stylesheet/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const abs = href ? absolutize(href, base) : null;
    if (abs) css.push(abs);
  }
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html))) {
    const abs = absolutize(m[1], base);
    if (abs && !/gtag|analytics|hotjar|clarity|tagmanager/i.test(abs)) js.push(abs);
  }
  return { css: css.slice(0, 2), js: js.slice(0, 2) };
}

export async function analyzeWebsite(inputUrl: string): Promise<AnalysisResult> {
  const target = inputUrl;
  const coverage: Coverage = emptyCoverage();
  coverage.sourcesAttempted += 1;
  const doc = await fetchPage(inputUrl);

  if (!doc) {
    return {
      target,
      kind: "website",
      vibeScore: 0,
      aiScore: 0,
      confidence: { vibe: confidenceFor(0, 0, coverage), ai: confidenceFor(0, 0, coverage) },
      signals: [],
      coverage,
      error:
        "Could not fetch the page — it may block bots, require JavaScript to serve HTML, or have timed out.",
    };
  }
  coverage.sourcesRead += 1;

  const html = doc.text;
  const signals: Signal[] = [];

  // ---- HTML-level signals ----
  const tw = detectTailwindClassDensity(html, "page HTML");
  if (tw) signals.push({ ...tw, weight: Math.min(18, tw.weight) });
  const arb = detectArbitraryValues(html, "page HTML");
  if (arb) signals.push(arb);
  const inlineVars = detectCssVariables(html, "page HTML");
  if (inlineVars) signals.push(inlineVars);

  if (/data-radix-|data-slot=|role="dialog"[^>]*data-state=/i.test(html)) {
    signals.push({
      id: "vibe.radix_runtime",
      category: "vibe",
      label: "Radix / shadcn runtime markers",
      weight: 16,
      evidence: "Rendered markup contains Radix primitives' data attributes (data-radix-*/data-slot).",
    });
  }

  const frameworks: string[] = [];
  if (/_next\/static/i.test(html)) frameworks.push("Next.js");
  if (/\/assets\/index-[A-Za-z0-9_-]+\.js/i.test(html)) frameworks.push("Vite");
  if (/__remixContext|\/_build\//i.test(html)) frameworks.push("Remix");
  if (/id="root"|id="__next"|data-reactroot/i.test(html)) frameworks.push("React");
  if (frameworks.length > 0) {
    signals.push({
      id: "vibe.framework_hints",
      category: "vibe",
      label: "Modern SPA framework fingerprints",
      weight: Math.min(10, frameworks.length * 4),
      evidence: `Detected: ${frameworks.join(", ")}.`,
    });
  }

  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  if (generator) {
    if (/lovable|v0\.dev|\bv0\b|bolt|copilot|builder\.ai|durable|framer ai/i.test(generator)) {
      signals.push({
        id: "ai.generator_meta",
        category: "ai",
        label: "AI-builder generator meta tag",
        weight: 34,
        evidence: `<meta name="generator" content="${generator}">`,
      });
    } else {
      signals.push({
        id: "vibe.generator_meta",
        category: "vibe",
        label: "Site generator meta tag",
        weight: 4,
        evidence: `<meta name="generator" content="${generator}">`,
      });
    }
  }

  // Platform fingerprints in markup + response headers.
  const headerBlob = [...doc.headers.entries()]
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const platformHits: string[] = [];
  if (/lovable\.app|lovableproject\.com|lovable-tagger|gptengineer/i.test(html))
    platformHits.push("Lovable");
  if (/v0\.dev|vusercontent\.net/i.test(html)) platformHits.push("v0");
  if (/bolt\.new|stackblitz/i.test(html)) platformHits.push("Bolt");
  if (/replit\.dev|repl\.co/i.test(html)) platformHits.push("Replit");
  if (platformHits.length > 0) {
    signals.push({
      id: "ai.platform_fingerprint",
      category: "ai",
      label: "AI app-builder platform fingerprint",
      weight: Math.min(34, platformHits.length * 22),
      evidence: `Page references ${platformHits.join(", ")} assets or domains.`,
    });
  }

  const hostHits: string[] = [];
  if (/vercel/i.test(headerBlob)) hostHits.push("Vercel");
  if (/netlify/i.test(headerBlob)) hostHits.push("Netlify");
  if (/cloudflare/i.test(headerBlob)) hostHits.push("Cloudflare");
  if (hostHits.length > 0) {
    signals.push({
      id: "vibe.modern_hosting",
      category: "vibe",
      label: "Modern edge hosting",
      weight: 4,
      evidence: `Served via ${hostHits.join(", ")}.`,
    });
  }

  if (/lovable\.dev\/projects|Edit with Lovable|gpt-engineer/i.test(html)) {
    signals.push({
      id: "ai.builder_badge",
      category: "ai",
      label: "AI builder badge in page",
      weight: 25,
      evidence: "Page still carries an AI builder badge / edit link.",
    });
  }

  // ---- Assets ----
  const { css, js } = extractAssets(html, inputUrl);
  coverage.sourcesAttempted += css.length + js.length;

  const assets = await Promise.all([
    ...css.map((u) => fetchDoc(u, 3_000_000).then((r) => ({ kind: "css" as const, url: u, r }))),
    ...js.map((u) => fetchDoc(u, 3_000_000).then((r) => ({ kind: "js" as const, url: u, r }))),
  ]);

  for (const asset of assets) {
    if (!asset.r) continue;
    coverage.sourcesRead += 1;
    const text = asset.r.text;
    const label = asset.url.split("/").pop() ?? asset.url;

    if (asset.kind === "css") {
      if (/--tw-|tailwindcss|\.(?:sm|md|lg)\\:/.test(text)) {
        signals.push({
          id: `vibe.tailwind_css.${label}`,
          category: "vibe",
          label: "Tailwind-compiled stylesheet",
          weight: 18,
          evidence: `${label} contains Tailwind's compiled runtime variables.`,
          sourceRef: asset.url,
        });
      }
      const vars = detectCssVariables(text, label);
      if (vars) signals.push({ ...vars, id: `${vars.id}.${label}`, sourceRef: asset.url });
      const hsl = detectHslTokens(text, label);
      if (hsl) signals.push({ ...hsl, id: `${hsl.id}.${label}`, sourceRef: asset.url });
    } else {
      if (/@radix-ui|data-radix|radix-ui/i.test(text)) {
        signals.push({
          id: `vibe.radix_bundle.${label}`,
          category: "vibe",
          label: "Radix UI in JS bundle",
          weight: 14,
          evidence: `${label} bundles Radix UI primitives.`,
          sourceRef: asset.url,
        });
      }
      if (/class-variance-authority|tailwind-merge|twMerge/i.test(text)) {
        signals.push({
          id: `vibe.cva_bundle.${label}`,
          category: "vibe",
          label: "cva / tailwind-merge in bundle",
          weight: 10,
          evidence: `${label} bundles the cn()/cva class-composition stack.`,
          sourceRef: asset.url,
        });
      }
      if (/lovable-tagger|data-lov-id|gpt-engineer/i.test(text)) {
        signals.push({
          id: `ai.tagger_bundle.${label}`,
          category: "ai",
          label: "AI builder instrumentation in bundle",
          weight: 30,
          evidence: `${label} contains AI-builder component tagging artifacts.`,
          sourceRef: asset.url,
        });
      }
      const bundleTw = detectTailwindClassDensity(text, label);
      if (bundleTw) {
        signals.push({
          ...bundleTw,
          id: `${bundleTw.id}.${label}`,
          weight: Math.min(12, bundleTw.weight),
          sourceRef: asset.url,
        });
      }
    }
  }

  if (coverage.sourcesRead <= 1) {
    coverage.notes.push("Only the HTML shell was readable; stylesheets and bundles were blocked.");
  }

  const { vibe, ai } = computeScores(signals, coverage);
  const vibeCount = signals.filter((s) => s.category === "vibe").length;
  const aiCount = signals.filter((s) => s.category === "ai").length;

  return {
    target,
    kind: "website",
    vibeScore: vibe,
    aiScore: ai,
    confidence: {
      vibe: confidenceFor(vibe, vibeCount, coverage),
      ai: confidenceFor(ai, aiCount, coverage),
    },
    signals,
    coverage,
  };
}
