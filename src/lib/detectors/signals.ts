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

export interface AnalysisResult {
  target: string;
  kind: "github" | "website";
  vibeScore: number;
  aiScore: number;
  confidence: { vibe: ScoreConfidence; ai: ScoreConfidence };
  signals: Signal[];
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
