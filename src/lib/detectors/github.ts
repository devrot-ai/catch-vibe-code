import { type AnalysisResult, type Signal, scoreFromSignals, scoreConfidence } from "./signals";
import { runSignalRules } from "./rule-engine";
import {
  createAiToolingRules,
  createPackageFingerprintRules,
  createReadmeHeuristicRules,
} from "./rule-catalog";

const GATEWAY = "https://connector-gateway.lovable.dev/github";

interface GHFile {
  name: string;
  path: string;
  type: string;
  size?: number;
  download_url?: string | null;
}

async function gh(path: string, apiKey: string, connKey: string): Promise<Response> {
  return fetch(`${GATEWAY}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${apiKey}`,
      "X-Connection-Api-Key": connKey,
    },
  });
}

async function ghJson<T>(path: string, apiKey: string, connKey: string): Promise<T | null> {
  const res = await gh(path, apiKey, connKey);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function ghText(path: string, apiKey: string, connKey: string): Promise<string | null> {
  const res = await gh(path, apiKey, connKey);
  if (!res.ok) return null;
  return await res.text();
}

const VIBE_PACKAGES: Array<{ name: string; weight: number; label: string }> = [
  { name: "tailwindcss", weight: 8, label: "tailwindcss" },
  { name: "@radix-ui/", weight: 6, label: "@radix-ui/*" },
  { name: "shadcn", weight: 10, label: "shadcn/ui" },
  { name: "class-variance-authority", weight: 4, label: "class-variance-authority" },
  { name: "lucide-react", weight: 4, label: "lucide-react" },
  { name: "@tanstack/react-router", weight: 3, label: "@tanstack/react-router" },
  { name: "next", weight: 2, label: "next.js" },
];

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (!/github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

export async function analyzeGithub(owner: string, repo: string): Promise<AnalysisResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  const connKey = process.env.GITHUB_API_KEY;
  const target = `github.com/${owner}/${repo}`;
  if (!apiKey || !connKey) {
    return {
      target,
      kind: "github",
      vibeScore: 0,
      aiScore: 0,
      signals: [],
      error: "GitHub connector not configured on the server.",
    };
  }

  const signals: Signal[] = [];

  const meta = await ghJson<{
    default_branch?: string;
    description?: string;
    stargazers_count?: number;
  }>(`/repos/${owner}/${repo}`, apiKey, connKey);
  if (!meta) {
    return {
      target,
      kind: "github",
      vibeScore: 0,
      aiScore: 0,
      signals: [],
      error: "Could not fetch repository (private, not found, or rate-limited).",
    };
  }

  const branch = meta.default_branch ?? "main";

  const root = await ghJson<GHFile[]>(`/repos/${owner}/${repo}/contents`, apiKey, connKey);
  const rootNames = new Set((root ?? []).map((f) => f.path));

  // Vibe: tailwind config
  const twConfig = [...rootNames].find((n) => /^tailwind\.config\.(js|ts|mjs|cjs)$/i.test(n));
  if (twConfig) {
    signals.push({
      id: "vibe.tailwind_config",
      category: "vibe",
      label: "Tailwind config file",
      weight: 30,
      evidence: `Found ${twConfig} at repo root.`,
      sourceRef: twConfig,
    });
  }

  // package.json inspection
  if (rootNames.has("package.json")) {
    const pkgText = await ghText(`/repos/${owner}/${repo}/contents/package.json`, apiKey, connKey);
    if (pkgText) {
      // contents API returns JSON with base64 by default; but Accept header not raw. Parse.
      try {
        const parsed = JSON.parse(pkgText);
        const encoded =
          parsed.content && parsed.encoding === "base64"
            ? Buffer.from(parsed.content, "base64").toString("utf8")
            : pkgText;
        const packageSignals = runSignalRules(
          encoded,
          "package.json",
          createPackageFingerprintRules(VIBE_PACKAGES),
        );
        if (packageSignals.length > 0) {
          signals.push({
            id: "vibe.packages",
            category: "vibe",
            label: "AI-friendly UI packages",
            weight: Math.min(
              25,
              packageSignals.reduce((sum, sig) => sum + sig.weight, 0),
            ),
            evidence: `package.json includes: ${packageSignals.map((sig) => sig.label).join(", ")}.`,
            sourceRef: "package.json",
          });
        }
      } catch {
        // ignore
      }
    }
  }

  // AI config files
  const aiFound: string[] = [];
  for (const path of [
    ".cursorrules",
    ".cursor/rules",
    ".windsurfrules",
    "copilot-instructions.md",
    ".github/copilot-instructions.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".lovable/project.json",
  ]) {
    const res = await gh(`/repos/${owner}/${repo}/contents/${path}`, apiKey, connKey);
    if (res.ok) aiFound.push(path);
  }
  if (aiFound.length > 0) {
    signals.push({
      id: "ai.config_files",
      category: "ai",
      label: "AI-tooling config files",
      weight: Math.min(40, aiFound.length * 25),
      evidence: `Found: ${aiFound.join(", ")}`,
    });
  }

  // README analysis
  const readmeRes = await gh(`/repos/${owner}/${repo}/readme`, apiKey, connKey);
  if (readmeRes.ok) {
    const readmeJson = (await readmeRes.json()) as { content?: string; encoding?: string };
    if (readmeJson.content && readmeJson.encoding === "base64") {
      const readme = Buffer.from(readmeJson.content, "base64").toString("utf8");
      signals.push(...runSignalRules(readme, "README", createReadmeHeuristicRules()));
    }
  }

  // Commit history
  const commits = await ghJson<
    Array<{
      commit: { message: string; author?: { name?: string } };
      author?: { login?: string } | null;
      sha: string;
    }>
  >(`/repos/${owner}/${repo}/commits?per_page=100&sha=${branch}`, apiKey, connKey);
  if (commits && commits.length > 0) {
    const kwRe =
      /(copilot|cursor|claude|chatgpt|gpt-?4|gemini|generated by ai|lovable|vibecod|codex)/i;
    const kwHits = commits.filter((c) => kwRe.test(c.commit.message)).slice(0, 5);
    if (kwHits.length > 0) {
      signals.push({
        id: "ai.commit_keywords",
        category: "ai",
        label: "AI keywords in commit messages",
        weight: Math.min(25, kwHits.length * 8),
        evidence: `${kwHits.length} commit(s) reference AI tools. e.g. "${kwHits[0].commit.message.slice(0, 80)}"`,
      });
    }

    const botAuthors = commits.filter(
      (c) =>
        /\[bot\]|copilot|lovable/i.test(c.author?.login ?? "") ||
        /\[bot\]|copilot/i.test(c.commit.author?.name ?? ""),
    );
    if (botAuthors.length > 0) {
      signals.push({
        id: "ai.bot_authors",
        category: "ai",
        label: "Bot / AI-tool authored commits",
        weight: Math.min(20, botAuthors.length * 5),
        evidence: `${botAuthors.length} commits by bot-style authors (e.g. ${botAuthors[0].author?.login ?? botAuthors[0].commit.author?.name}).`,
      });
    }

    // Large initial commit
    const initial = commits[commits.length - 1];
    if (initial) {
      const stat = await ghJson<{ stats?: { additions?: number } }>(
        `/repos/${owner}/${repo}/commits/${initial.sha}`,
        apiKey,
        connKey,
      );
      const adds = stat?.stats?.additions ?? 0;
      if (adds > 1000) {
        signals.push({
          id: "ai.large_initial_commit",
          category: "ai",
          label: "Large initial commit (code dump)",
          weight: 15,
          evidence: `Initial commit added ${adds.toLocaleString()} lines.`,
        });
      }
    }
  }

  // Scan a couple of CSS/HTML files for tailwind density + css vars
  const cssCandidates = (root ?? [])
    .filter(
      (f) => f.type === "file" && /\.(css|scss|html)$/i.test(f.name) && (f.size ?? 0) < 200_000,
    )
    .slice(0, 3);
  for (const f of cssCandidates) {
    const raw = await ghText(`/repos/${owner}/${repo}/contents/${f.path}`, apiKey, connKey);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const text =
        parsed.content && parsed.encoding === "base64"
          ? Buffer.from(parsed.content, "base64").toString("utf8")
          : raw;
      const tw = detectTailwindClassDensity(text, f.path);
      if (tw) signals.push(tw);
      const cv = detectCssVariables(text, f.path);
      if (cv) signals.push(cv);
    } catch {
      // ignore
    }
  }

  const { vibe, ai } = scoreFromSignals(signals);
  const vibeSignals = signals.filter((signal) => signal.category === "vibe");
  const aiSignals = signals.filter((signal) => signal.category === "ai");
  return {
    target,
    kind: "github",
    vibeScore: vibe,
    aiScore: ai,
    confidence: {
      vibe: scoreConfidence(vibe, vibeSignals.length),
      ai: scoreConfidence(ai, aiSignals.length),
    },
    signals,
    meta: { description: meta.description, stars: meta.stargazers_count, branch },
  };
}
