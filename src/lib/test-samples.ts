export interface TestSample {
  url: string;
  label: string;
  expectVibe: "high" | "medium" | "low";
  expectAi: "high" | "medium" | "low";
  note?: string;
}

// Threshold buckets match verdict() in scan.tsx: high>=65, medium>=35, low<35
export const EXPECTATION_RANGES: Record<"high" | "medium" | "low", [number, number]> = {
  high: [65, 100],
  medium: [35, 100], // medium-or-above passes
  low: [0, 34],
};

export function scoreBucket(score: number): "high" | "medium" | "low" {
  if (score >= 65) return "high";
  if (score >= 35) return "medium";
  return "low";
}

export function passes(score: number, expected: "high" | "medium" | "low"): boolean {
  const [min, max] = EXPECTATION_RANGES[expected];
  return score >= min && score <= max;
}

export const TEST_SAMPLES: TestSample[] = [
  {
    url: "https://github.com/shadcn-ui/ui",
    label: "shadcn/ui",
    expectVibe: "high",
    expectAi: "low",
    note: "Canonical vibe-coded design system; not AI-generated.",
  },
  {
    url: "https://github.com/tailwindlabs/tailwindcss",
    label: "tailwindlabs/tailwindcss",
    expectVibe: "medium",
    expectAi: "low",
    note: "Tailwind itself — utility signals but hand-written.",
  },
  {
    url: "https://github.com/vercel/next.js",
    label: "vercel/next.js",
    expectVibe: "low",
    expectAi: "low",
    note: "Large framework, no strong vibe or AI fingerprints.",
  },
  {
    url: "https://github.com/torvalds/linux",
    label: "torvalds/linux",
    expectVibe: "low",
    expectAi: "low",
    note: "Control: C kernel, should score near zero on both.",
  },
  {
    url: "https://github.com/lovable-dev/awesome-lovable",
    label: "lovable-dev/awesome-lovable",
    expectVibe: "medium",
    expectAi: "medium",
    note: "Lovable-adjacent repo; expect some AI signals.",
  },
];
