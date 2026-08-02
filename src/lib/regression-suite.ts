import { scoreConfidence, scoreFromSignals, type Signal } from "./detectors/signals.ts";
import { runSignalRules } from "./detectors/rule-engine.ts";
import {
  createAiToolingRules,
  createPackageFingerprintRules,
  createReadmeHeuristicRules,
  createWebsiteHtmlRules,
} from "./detectors/rule-catalog.ts";
import { passes, scoreBucket } from "./test-samples.ts";

export type RegressionBucket = "high" | "medium" | "low";

export interface RegressionCaseResult {
  id: string;
  label: string;
  note: string;
  expectedVibe: RegressionBucket;
  expectedAi: RegressionBucket;
  vibeScore: number;
  aiScore: number;
  vibeBucket: RegressionBucket;
  aiBucket: RegressionBucket;
  confidence: { vibe: ReturnType<typeof scoreConfidence>; ai: ReturnType<typeof scoreConfidence> };
  vibePass: boolean;
  aiPass: boolean;
  lowConfidence: boolean;
  signals: Signal[];
}

interface RegressionCaseDefinition {
  id: string;
  label: string;
  note: string;
  expectedVibe: RegressionBucket;
  expectedAi: RegressionBucket;
  buildSignals: () => Signal[];
}

function packageFingerprintSignals(text: string): Signal[] {
  return runSignalRules(
    text,
    "package.json",
    createPackageFingerprintRules([
      { name: "tailwindcss", weight: 8, label: "tailwindcss" },
      { name: "@radix-ui/", weight: 6, label: "@radix-ui/*" },
      { name: "shadcn", weight: 10, label: "shadcn/ui" },
      { name: "class-variance-authority", weight: 4, label: "class-variance-authority" },
      { name: "lucide-react", weight: 4, label: "lucide-react" },
      { name: "@tanstack/react-router", weight: 3, label: "@tanstack/react-router" },
    ]),
  );
}

function aiToolingSignals(text: string): Signal[] {
  return runSignalRules(text, "repo-summary", createAiToolingRules());
}

const REGRESSION_CASES: RegressionCaseDefinition[] = [
  {
    id: "design-system-html",
    label: "Design-system HTML",
    note: "Heavy utility classes plus CSS tokens and shadcn-style markup.",
    expectedVibe: "medium",
    expectedAi: "low",
    buildSignals: () => {
      const html = `
        <div class="flex items-center justify-between gap-4 rounded-md border bg-background p-4 text-sm shadow-sm hover:bg-accent md:grid lg:flex sm:items-center">
          <button class="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90">Save</button>
          <div data-slot="card" class="rounded-md border bg-card text-card-foreground"></div>
        </div>
      `;
      const css = `
        :root {
          --background: oklch(1 0 0);
          --foreground: oklch(0.13 0.04 264.7);
          --card: oklch(1 0 0);
          --card-foreground: oklch(0.13 0.04 264.7);
          --primary: oklch(0.21 0.04 265.7);
          --primary-foreground: oklch(0.98 0.003 247.8);
          --muted: oklch(0.968 0.007 247.896);
        }
      `;

      return runSignalRules(html + css, "fixture.html", createWebsiteHtmlRules());
    },
  },
  {
    id: "ui-package-manifest",
    label: "UI package manifest",
    note: "A repo with common design-system packages and React router tooling.",
    expectedVibe: "medium",
    expectedAi: "low",
    buildSignals: () =>
      packageFingerprintSignals(`
      {
        "dependencies": {
          "tailwindcss": "^4.2.1",
          "@radix-ui/react-dialog": "^1.1.15",
          "shadcn": "^1.0.0",
          "class-variance-authority": "^0.7.1",
          "lucide-react": "^0.575.0",
          "@tanstack/react-router": "^1.170.16"
        }
      }
    `),
  },
  {
    id: "tutorial-readme",
    label: "Tutorial README",
    note: "Instructional voice and emoji headers should move the AI score but stay below the high threshold.",
    expectedVibe: "low",
    expectedAi: "low",
    buildSignals: () => {
      const readme = `
        # 🚀 Quick start
        ## 🧭 Setup
        We'll now create the first component.
        In this example, let's build the route.
        ### 🎯 Usage
        First, we add the final step.
      `;
      return runSignalRules(readme, "README", createReadmeHeuristicRules());
    },
  },
  {
    id: "generated-site",
    label: "Generated site",
    note: "A generated page should trip the generator meta tag but not much else.",
    expectedVibe: "low",
    expectedAi: "low",
    buildSignals: () => {
      const html = `
        <html>
          <head>
            <meta name="generator" content="Lovable 1.0" />
          </head>
          <body><main class="container mx-auto">Hello</main></body>
        </html>
      `;
      return runSignalRules(html, "generated.html", createWebsiteHtmlRules());
    },
  },
  {
    id: "ai-tooling-repo-summary",
    label: "AI tooling repo summary",
    note: "Repository metadata and commit language should push the AI score over the high threshold.",
    expectedVibe: "low",
    expectedAi: "high",
    buildSignals: () =>
      aiToolingSignals(`
        AGENTS.md
        CLAUDE.md
        copilot-instructions.md
        commit: feat: add onboarding flow with Copilot
        commit: chore(bot): generated helper cleanup
      `),
  },
  {
    id: "plain-project",
    label: "Plain project",
    note: "A control case with no meaningful signals.",
    expectedVibe: "low",
    expectedAi: "low",
    buildSignals: () => [],
  },
];

export function runRegressionSuite(): RegressionCaseResult[] {
  return REGRESSION_CASES.map((entry) => {
    const signals = entry.buildSignals();
    const { vibe, ai } = scoreFromSignals(signals);
    const vibeBucket = scoreBucket(vibe);
    const aiBucket = scoreBucket(ai);
    const vibeSignals = signals.filter((signal) => signal.category === "vibe");
    const aiSignals = signals.filter((signal) => signal.category === "ai");
    const confidence = {
      vibe: scoreConfidence(vibe, vibeSignals.length),
      ai: scoreConfidence(ai, aiSignals.length),
    };
    return {
      id: entry.id,
      label: entry.label,
      note: entry.note,
      expectedVibe: entry.expectedVibe,
      expectedAi: entry.expectedAi,
      vibeScore: vibe,
      aiScore: ai,
      vibeBucket,
      aiBucket,
      confidence,
      vibePass: passes(vibe, entry.expectedVibe),
      aiPass: passes(ai, entry.expectedAi),
      lowConfidence: confidence.vibe.level === "low" || confidence.ai.level === "low",
      signals,
    };
  });
}
