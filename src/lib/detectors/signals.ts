export type SignalCategory = "vibe" | "ai";

export interface Signal {
  id: string;
  category: SignalCategory;
  label: string;
  weight: number;
  evidence: string;
  sourceRef?: string;
}

export type ConfidenceLevel = "low" | "medium" | "high";

export interface ScoreConfidence {
  level: ConfidenceLevel;
  label: string;
  detail: string;
}

import type { ScanHealth } from "./health";

export interface AnalysisResult {
  target: string;
  kind: "github" | "website";
  vibeScore: number;
  aiScore: number;
  confidence: { vibe: ScoreConfidence; ai: ScoreConfidence };
  signals: Signal[];
  coverage?: { sourcesRead: number; sourcesAttempted: number; notes: string[] };
  health?: ScanHealth;
  meta?: { description?: string | null; stars?: number; branch?: string };
  error?: string;
}


export function scoreFromSignals(signals: Signal[]): { vibe: number; ai: number } {
  let vibe = 0;
  let ai = 0;
  for (const s of signals) {
    if (s.category === "vibe") vibe += s.weight;
    else ai += s.weight;
  }
  return {
    vibe: Math.max(0, Math.min(100, Math.round(vibe))),
    ai: Math.max(0, Math.min(100, Math.round(ai))),
  };
}

export function scoreConfidence(score: number, signalCount: number): ScoreConfidence {
  const distance = Math.min(Math.abs(score - 35), Math.abs(score - 65));
  const scoreBand = score >= 65 ? "high" : score >= 35 ? "medium" : "low";

  if (signalCount <= 2 || distance <= 5) {
    return {
      level: "low",
      label: "Low confidence",
      detail:
        signalCount <= 2
          ? `Only ${signalCount} signal${signalCount === 1 ? "" : "s"} fired.`
          : "Score sits close to a bucket boundary, so the result can move with small evidence changes.",
    };
  }

  if (signalCount <= 4 || distance <= 12) {
    return {
      level: "medium",
      label: "Medium confidence",
      detail:
        scoreBand === "high"
          ? "The score is likely directionally correct, but the evidence set is still limited."
          : "There is enough evidence for a stable read, but the score is not heavily reinforced.",
    };
  }

  return {
    level: "high",
    label: "High confidence",
    detail: "Multiple signals reinforce this score and it is well away from the bucket boundaries.",
  };
}

// ---------- Shared text detectors ----------

const TW_UTILITY =
  /\b(?:bg|text|p[trblxy]?|m[trblxy]?|flex|grid|rounded|border|gap|w|h|min-[wh]|max-[wh]|shadow|ring|space-[xy]|items|justify|hover:|dark:|md:|lg:|sm:)[-:][a-z0-9/[\]#().-]+/g;

export function detectTailwindClassDensity(text: string, source: string): Signal | null {
  const matches = text.match(TW_UTILITY);
  if (!matches) return null;
  const density = matches.length;
  if (density < 15) return null;
  const weight = Math.min(25, Math.round(density / 20));
  return {
    id: "vibe.tailwind_density",
    category: "vibe",
    label: "Tailwind utility class density",
    weight,
    evidence: `~${density} Tailwind-style utility classes detected in ${source}. Sample: ${matches.slice(0, 5).join(" ")}`,
  };
}

export function detectCssVariables(text: string, source: string): Signal | null {
  const varDefs = text.match(/--[a-z][a-z0-9-]*\s*:/gi);
  if (!varDefs || varDefs.length < 6) return null;
  const weight = Math.min(15, Math.round(varDefs.length / 4));
  return {
    id: "vibe.css_variables",
    category: "vibe",
    label: "Design-token CSS custom properties",
    weight,
    evidence: `${varDefs.length} CSS custom properties (--tokens) defined in ${source}.`,
  };
}

export function detectTutorialVoice(text: string, source: string): Signal | null {
  const patterns = [
    /\bwe(?:'ll| will)\s+(?:now|first|next)\b/gi,
    /\bin this example\b/gi,
    /\blet['\u2019]s\s+(?:add|build|create|start)\b/gi,
    /\bstep\s*\d+\s*[:.]/gi,
    /\bfirst,\s+we\b/gi,
  ];
  let hits = 0;
  const samples: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      hits += m.length;
      if (samples.length < 3) samples.push(m[0]);
    }
  }
  if (hits < 2) return null;
  return {
    id: "ai.tutorial_voice",
    category: "ai",
    label: "LLM-style tutorial voice",
    weight: Math.min(15, hits * 3),
    evidence: `Found ${hits} tutorial-voice phrases in ${source}: ${samples.join(", ")}`,
  };
}

export function detectEmojiHeaders(text: string, source: string): Signal | null {
  const emojiHeader = text.match(/^#{1,3}\s+[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gmu);
  if (!emojiHeader || emojiHeader.length < 2) return null;
  return {
    id: "ai.emoji_headers",
    category: "ai",
    label: "Emoji-decorated markdown headers",
    weight: 5,
    evidence: `${emojiHeader.length} markdown headers start with emoji in ${source}.`,
  };
}

// ---------- Source-code prose / comment detectors ----------

const COMMENT_RE = /(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\})/g;

export function extractComments(text: string): string[] {
  return text.match(COMMENT_RE) ?? [];
}

/** Comments that narrate the obvious next line — a strong LLM tell. */
export function detectNarratingComments(text: string, source: string): Signal | null {
  const comments = extractComments(text);
  if (comments.length === 0) return null;
  const patterns = [
    /\/\/\s*(?:import|define|create|initialize|set up|setup|render|return|handle|update|fetch|check|loop through|map over|state for)\b/i,
    /\/\/\s*(?:this|the)\s+(?:function|component|hook|variable|constant)\s+(?:will|is|does)\b/i,
    /\/\*+\s*(?:={3,}|-{3,})/,
  ];
  const hits = comments.filter((c) => patterns.some((p) => p.test(c)));
  if (hits.length < 3) return null;
  return {
    id: "ai.narrating_comments",
    category: "ai",
    label: "Comments narrating obvious code",
    weight: Math.min(14, 3 + hits.length),
    evidence: `${hits.length} explanatory comments in ${source}, e.g. ${hits
      .slice(0, 2)
      .map((c) => `"${c.trim().slice(0, 60)}"`)
      .join(", ")}`,
    sourceRef: source,
  };
}

/** Big banner comments splitting a file into labelled sections. */
export function detectSectionBanners(text: string, source: string): Signal | null {
  const banners = text.match(/(?:\/\/|\{\/\*|\/\*)\s*[-=*]{3,}[^\n]*\n?|\{\/\*\s*[A-Z][A-Za-z ]{3,30}\s*\*\/\}/g);
  if (!banners || banners.length < 3) return null;
  return {
    id: "ai.section_banners",
    category: "ai",
    label: "Section banner comments",
    weight: Math.min(10, banners.length * 2),
    evidence: `${banners.length} decorative section banners in ${source}.`,
    sourceRef: source,
  };
}

export function detectPlaceholders(text: string, source: string): Signal | null {
  const hits = text.match(
    /\/\/\s*(?:TODO|FIXME)\s*:?\s*(?:implement|add|replace with|hook up|wire up|your)\b[^\n]*/gi,
  );
  if (!hits || hits.length < 2) return null;
  return {
    id: "ai.placeholders",
    category: "ai",
    label: "Unfinished scaffold placeholders",
    weight: Math.min(10, hits.length * 3),
    evidence: `${hits.length} placeholder TODOs in ${source}, e.g. "${hits[0].trim().slice(0, 70)}"`,
    sourceRef: source,
  };
}

/** Tailwind arbitrary values like w-[420px] — common in generated UI. */
export function detectArbitraryValues(text: string, source: string): Signal | null {
  const hits = text.match(/\b[a-z-]+-\[[^\]\s"']+\]/g);
  if (!hits || hits.length < 4) return null;
  return {
    id: "vibe.tailwind_arbitrary",
    category: "vibe",
    label: "Tailwind arbitrary values",
    weight: Math.min(8, Math.round(hits.length / 2)),
    evidence: `${hits.length} arbitrary-value utilities in ${source}, e.g. ${hits.slice(0, 3).join(" ")}`,
    sourceRef: source,
  };
}

/** HSL design tokens (`--primary: 222 47% 11%`) — the shadcn theming convention. */
export function detectHslTokens(text: string, source: string): Signal | null {
  const hits = text.match(/--[a-z-]+:\s*\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%/gi);
  if (!hits || hits.length < 4) return null;
  return {
    id: "vibe.hsl_tokens",
    category: "vibe",
    label: "shadcn-style HSL design tokens",
    weight: Math.min(14, 6 + hits.length),
    evidence: `${hits.length} raw-HSL theme tokens in ${source}.`,
    sourceRef: source,
  };
}

export function detectCnHelper(text: string, source: string): Signal | null {
  if (!/\bcn\(/.test(text) || !/(class-variance-authority|cva\(|clsx|tailwind-merge|twMerge)/.test(text)) {
    return null;
  }
  return {
    id: "vibe.cn_helper",
    category: "vibe",
    label: "cn() + cva class-composition convention",
    weight: 10,
    evidence: `${source} uses the cn()/cva class-composition pattern popularised by shadcn/ui.`,
    sourceRef: source,
  };
}
