import {
  type AnalysisResult,
  type Signal,
  detectTailwindClassDensity,
  detectCssVariables,
  detectTutorialVoice,
  detectEmojiHeaders,
  detectNarratingComments,
  detectSectionBanners,
  detectPlaceholders,
  detectArbitraryValues,
  detectHslTokens,
  detectCnHelper,
} from "./signals";
import { computeScores, confidenceFor, emptyCoverage, type Coverage } from "./scoring";

const GATEWAY = "https://connector-gateway.lovable.dev/github";

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

interface CommitEntry {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
}

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function failure(target: string, error: string, health?: ScanHealth): AnalysisResult {
  const coverage = emptyCoverage();
  return {
    target,
    kind: "github",
    vibeScore: 0,
    aiScore: 0,
    confidence: { vibe: confidenceFor(0, 0, coverage), ai: confidenceFor(0, 0, coverage) },
    signals: [],
    coverage,
    ...(health ? { health } : {}),
    error,
  };
}

function makeClient(apiKey: string, connKey: string, health: HealthTracker) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${apiKey}`,
    "X-Connection-Api-Key": connKey,
  };
  const raw = async (path: string): Promise<Response | null> => {
    try {
      const res = await fetch(`${GATEWAY}${path}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      // GitHub signals a hit quota with 403 + remaining:0, or a plain 429.
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 403 && remaining === "0") health.record({ status: 429 });
      else health.record(res);
      return res;
    } catch {
      health.record(null);
      return null;
    }
  };
  const json = async <T,>(path: string): Promise<T | null> => {
    const res = await raw(path);
    if (!res || !res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  };
  return { raw, json };
}

function decodeContent(payload: { content?: string; encoding?: string } | null): string | null {
  if (!payload?.content) return null;
  if (payload.encoding !== "base64") return payload.content;
  try {
    return Buffer.from(payload.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

const AI_CONFIG_FILES = [
  ".cursorrules",
  ".cursor/rules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  "copilot-instructions.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".lovable/project.json",
  ".aider.conf.yml",
  ".clinerules",
  ".continue/config.json",
  ".replit",
];

const VIBE_PACKAGES: Array<{ name: string; weight: number; label: string }> = [
  { name: "tailwindcss", weight: 8, label: "tailwindcss" },
  { name: "@radix-ui/", weight: 7, label: "@radix-ui/*" },
  { name: "class-variance-authority", weight: 5, label: "class-variance-authority" },
  { name: "tailwind-merge", weight: 4, label: "tailwind-merge" },
  { name: "lucide-react", weight: 4, label: "lucide-react" },
  { name: "framer-motion", weight: 2, label: "framer-motion" },
  { name: "clsx", weight: 2, label: "clsx" },
  { name: "next-themes", weight: 2, label: "next-themes" },
];

const AI_PACKAGES = [
  { name: "lovable-tagger", weight: 30, label: "lovable-tagger" },
  { name: "@v0/", weight: 20, label: "v0 packages" },
  { name: "bolt-", weight: 10, label: "bolt tooling" },
];

const GENERIC_COMMIT =
  /^(?:update(?:d)?(?: files?| code| project)?|fix(?:es|ed)?(?: bug| issue)?|changes?|wip|initial commit|refactor|improvements?|misc|cleanup|final|done|test)\.?$/i;

function pickCodeSamples(tree: TreeEntry[]): string[] {
  const files = tree.filter((e) => e.type === "blob");
  const isCode = (p: string) => /\.(tsx|jsx)$/i.test(p) && !/\.(test|spec)\./i.test(p);
  const uiComponents = files.filter((f) => /components\/ui\/.+\.tsx$/i.test(f.path));
  const pages = files.filter(
    (f) => isCode(f.path) && /(pages|routes|app|views|screens)\//i.test(f.path),
  );
  const rest = files.filter((f) => isCode(f.path));
  const ordered = [...pages, ...rest, ...uiComponents].filter((f) => (f.size ?? 0) < 120_000);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of ordered) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f.path);
    if (out.length >= 4) break;
  }
  return out;
}

function pickStyleSamples(tree: TreeEntry[]): string[] {
  const preferred = [
    "src/index.css",
    "src/styles.css",
    "src/app/globals.css",
    "app/globals.css",
    "styles/globals.css",
    "src/global.css",
  ];
  const paths = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
  const found = preferred.filter((p) => paths.has(p));
  if (found.length > 0) return found.slice(0, 2);
  return tree
    .filter((e) => e.type === "blob" && /\.(css|scss)$/i.test(e.path) && (e.size ?? 0) < 300_000)
    .slice(0, 2)
    .map((e) => e.path);
}

export async function analyzeGithub(owner: string, repo: string): Promise<AnalysisResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  const connKey = process.env.GITHUB_API_KEY;
  const target = `github.com/${owner}/${repo}`;
  if (!apiKey || !connKey) return failure(target, "GitHub connector not configured on the server.");

  const api = makeClient(apiKey, connKey);
  const coverage: Coverage = emptyCoverage();
  const signals: Signal[] = [];

  coverage.sourcesAttempted += 1;
  const meta = await api.json<{
    default_branch?: string;
    description?: string;
    stargazers_count?: number;
    created_at?: string;
    pushed_at?: string;
    size?: number;
  }>(`/repos/${owner}/${repo}`);
  if (!meta) return failure(target, "Could not fetch repository (private, not found, or rate-limited).");
  coverage.sourcesRead += 1;

  const branch = meta.default_branch ?? "main";

  // ---- 1. One recursive tree call gives us the whole file structure ----
  coverage.sourcesAttempted += 1;
  const treeRes = await api.json<{ tree?: TreeEntry[]; truncated?: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const tree = treeRes?.tree ?? [];
  if (tree.length > 0) coverage.sourcesRead += 1;
  else coverage.notes.push("Repository file tree could not be read.");
  if (treeRes?.truncated) coverage.notes.push("File tree was truncated by GitHub (very large repo).");

  const paths = tree.filter((e) => e.type === "blob").map((e) => e.path);
  const pathSet = new Set(paths);

  const tailwindConfig = paths.find((p) => /(^|\/)tailwind\.config\.(js|ts|mjs|cjs)$/i.test(p));
  if (tailwindConfig) {
    signals.push({
      id: "vibe.tailwind_config",
      category: "vibe",
      label: "Tailwind config file",
      weight: 14,
      evidence: `Found ${tailwindConfig}.`,
      sourceRef: tailwindConfig,
    });
  }

  if (pathSet.has("components.json")) {
    signals.push({
      id: "vibe.shadcn_manifest",
      category: "vibe",
      label: "shadcn/ui components.json manifest",
      weight: 16,
      evidence: "components.json (shadcn/ui CLI manifest) present at repo root.",
      sourceRef: "components.json",
    });
  }

  const uiComponents = paths.filter((p) => /components\/ui\/[^/]+\.(tsx|jsx|vue|svelte)$/i.test(p));
  if (uiComponents.length >= 3) {
    signals.push({
      id: "vibe.ui_component_folder",
      category: "vibe",
      label: "components/ui primitive library",
      weight: Math.min(16, 6 + Math.round(uiComponents.length / 3)),
      evidence: `${uiComponents.length} primitives under components/ui (e.g. ${uiComponents
        .slice(0, 3)
        .map((p) => p.split("/").pop())
        .join(", ")}).`,
      sourceRef: uiComponents[0],
    });
  }

  const aiConfigFound = AI_CONFIG_FILES.filter((f) => pathSet.has(f));
  if (aiConfigFound.length > 0) {
    signals.push({
      id: "ai.config_files",
      category: "ai",
      label: "AI-tooling config files",
      weight: Math.min(36, aiConfigFound.length * 20),
      evidence: `Found: ${aiConfigFound.join(", ")}`,
      sourceRef: aiConfigFound[0],
    });
  }

  // Scaffold shape: many files, few directories, everything under src/ — typical
  // of a one-shot generated project.
  if (paths.length > 0 && paths.length < 400) {
    const srcRatio = paths.filter((p) => p.startsWith("src/")).length / paths.length;
    const hasTests = paths.some((p) => /\.(test|spec)\.[jt]sx?$/i.test(p));
    const hasCi = paths.some((p) => p.startsWith(".github/workflows/"));
    if (srcRatio > 0.6 && !hasTests && !hasCi) {
      signals.push({
        id: "ai.scaffold_shape",
        category: "ai",
        label: "One-shot scaffold shape",
        weight: 12,
        evidence: `${Math.round(srcRatio * 100)}% of files live under src/, with no tests and no CI — typical of a single generated scaffold.`,
      });
    }
  }

  // ---- 2. Fetch the informative files in parallel ----
  const codeSamples = pickCodeSamples(tree);
  const styleSamples = pickStyleSamples(tree);
  const fileTargets = [
    ...(pathSet.has("package.json") ? ["package.json"] : []),
    ...styleSamples,
    ...codeSamples,
  ];

  coverage.sourcesAttempted += fileTargets.length + 1; // + readme
  const [readmePayload, ...filePayloads] = await Promise.all([
    api.json<{ content?: string; encoding?: string }>(`/repos/${owner}/${repo}/readme`),
    ...fileTargets.map((p) =>
      api.json<{ content?: string; encoding?: string }>(
        `/repos/${owner}/${repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
      ),
    ),
  ]);

  const files = new Map<string, string>();
  fileTargets.forEach((path, i) => {
    const text = decodeContent(filePayloads[i]);
    if (text) {
      files.set(path, text);
      coverage.sourcesRead += 1;
    }
  });

  const pkgText = files.get("package.json");
  if (pkgText) {
    const matchedVibe = VIBE_PACKAGES.filter((p) => pkgText.includes(`"${p.name}`));
    if (matchedVibe.length > 0) {
      signals.push({
        id: "vibe.packages",
        category: "vibe",
        label: "Design-system dependency fingerprint",
        weight: Math.min(22, matchedVibe.reduce((s, p) => s + p.weight, 0)),
        evidence: `package.json depends on ${matchedVibe.map((p) => p.label).join(", ")}.`,
        sourceRef: "package.json",
      });
    }
    const matchedAi = AI_PACKAGES.filter((p) => pkgText.includes(p.name));
    if (matchedAi.length > 0) {
      signals.push({
        id: "ai.packages",
        category: "ai",
        label: "AI-builder dependency fingerprint",
        weight: Math.min(35, matchedAi.reduce((s, p) => s + p.weight, 0)),
        evidence: `package.json depends on ${matchedAi.map((p) => p.label).join(", ")}.`,
        sourceRef: "package.json",
      });
    }
  }

  for (const path of styleSamples) {
    const css = files.get(path);
    if (!css) continue;
    const vars = detectCssVariables(css, path);
    if (vars) signals.push({ ...vars, id: `${vars.id}.${path}`, sourceRef: path });
    const hsl = detectHslTokens(css, path);
    if (hsl) signals.push({ ...hsl, id: `${hsl.id}.${path}` });
    if (/@tailwind\s+(base|components|utilities)|@import\s+["']tailwindcss["']/.test(css)) {
      signals.push({
        id: `vibe.tailwind_entry.${path}`,
        category: "vibe",
        label: "Tailwind stylesheet entrypoint",
        weight: 10,
        evidence: `${path} imports Tailwind layers.`,
        sourceRef: path,
      });
    }
  }

  let densityTotal = 0;
  let densityFile = "";
  for (const path of codeSamples) {
    const code = files.get(path);
    if (!code) continue;
    const tw = detectTailwindClassDensity(code, path);
    if (tw && tw.weight > densityTotal) {
      densityTotal = tw.weight;
      densityFile = path;
    }
    const arb = detectArbitraryValues(code, path);
    if (arb) signals.push({ ...arb, id: `${arb.id}.${path}` });
    const cnHelper = detectCnHelper(code, path);
    if (cnHelper) signals.push({ ...cnHelper, id: `${cnHelper.id}.${path}` });
    const narrating = detectNarratingComments(code, path);
    if (narrating) signals.push({ ...narrating, id: `${narrating.id}.${path}` });
    const banners = detectSectionBanners(code, path);
    if (banners) signals.push({ ...banners, id: `${banners.id}.${path}` });
    const placeholders = detectPlaceholders(code, path);
    if (placeholders) signals.push({ ...placeholders, id: `${placeholders.id}.${path}` });
    const tutorial = detectTutorialVoice(code, path);
    if (tutorial) signals.push({ ...tutorial, id: `${tutorial.id}.${path}`, sourceRef: path });
  }
  if (densityTotal > 0) {
    signals.push({
      id: "vibe.tailwind_density",
      category: "vibe",
      label: "Tailwind utility class density",
      weight: Math.min(18, densityTotal),
      evidence: `Heaviest utility-class usage found in ${densityFile}.`,
      sourceRef: densityFile,
    });
  }

  const readme = decodeContent(readmePayload);
  if (readme) {
    coverage.sourcesRead += 1;
    const tutorial = detectTutorialVoice(readme, "README");
    if (tutorial) signals.push(tutorial);
    const emoji = detectEmojiHeaders(readme, "README");
    if (emoji) signals.push(emoji);
    if (/(built|generated|created|made)\s+with\s+(lovable|v0|bolt\.new|cursor|claude|chatgpt|copilot)/i.test(readme)) {
      signals.push({
        id: "ai.readme_attribution",
        category: "ai",
        label: "README credits an AI builder",
        weight: 28,
        evidence: "README explicitly says the project was built with an AI tool.",
        sourceRef: "README",
      });
    }
  } else {
    coverage.notes.push("README could not be read.");
  }

  // ---- 3. Commit history ----
  coverage.sourcesAttempted += 1;
  const commits =
    (await api.json<CommitEntry[]>(
      `/repos/${owner}/${repo}/commits?per_page=100&sha=${encodeURIComponent(branch)}`,
    )) ?? [];
  if (commits.length > 0) {
    coverage.sourcesRead += 1;

    // Deliberately strict: bare words like "cursor", "codex" or "gemini" appear
    // constantly in normal code history, so we only match explicit attribution.
    const kwRe =
      /(generated (?:by|with) (?:ai|an? llm|copilot|claude|chatgpt|cursor|gemini)|(?:written|built|created|scaffolded|vibe-?coded) (?:by|with) (?:ai|copilot|claude|chatgpt|cursor|lovable|bolt\.new|v0)|co-authored-by:\s*(?:claude|copilot|cursor|chatgpt|lovable|devin|codex)|github copilot|claude code|cursor agent|lovable\.dev|bolt\.new|via lovable|\bai-generated\b)/i;
    const kwHits = commits.filter((c) => kwRe.test(c.commit.message));
    if (kwHits.length > 0) {
      signals.push({
        id: "ai.commit_keywords",
        category: "ai",
        label: "AI attribution in commit messages",
        weight: Math.min(24, kwHits.length * 6),
        evidence: `${kwHits.length} of ${commits.length} recent commits explicitly credit an AI tool, e.g. "${kwHits[0].commit.message.split("\n")[0].slice(0, 80)}"`,
      });
    }

    // Only AI coding agents count — dependabot, renovate and github-actions are
    // ordinary automation and must not inflate the AI score.
    const AI_BOT = /(copilot|lovable|devin|claude|cursor|codex|sweep-ai|codegen)/i;
    const GENERIC_BOT = /(dependabot|renovate|github-actions|greenkeeper|snyk|semantic-release|netlify|vercel|allcontributors|imgbot|pre-commit-ci)/i;
    const botCommits = commits.filter((c) => {
      const login = c.author?.login ?? "";
      const name = c.commit.author?.name ?? "";
      const byAuthor = (AI_BOT.test(login) || AI_BOT.test(name)) && !GENERIC_BOT.test(login) && !GENERIC_BOT.test(name);
      const byTrailer = /co-authored-by:\s*(claude|copilot|cursor|lovable|chatgpt|devin|codex)/i.test(
        c.commit.message,
      );
      return byAuthor || byTrailer;
    });
    if (botCommits.length > 0) {
      signals.push({
        id: "ai.bot_authors",
        category: "ai",
        label: "AI-agent authored commits",
        weight: Math.min(22, botCommits.length * 4),
        evidence: `${botCommits.length} commits authored or co-authored by an AI coding agent (e.g. ${
          botCommits[0].author?.login ?? botCommits[0].commit.author?.name ?? "co-authored trailer"
        }).`,
      });
    }


    const generic = commits.filter((c) => GENERIC_COMMIT.test(c.commit.message.split("\n")[0].trim()));
    if (generic.length >= 5 && generic.length / commits.length > 0.3) {
      signals.push({
        id: "ai.generic_commits",
        category: "ai",
        label: "Generic, low-information commit messages",
        weight: Math.min(14, Math.round((generic.length / commits.length) * 20)),
        evidence: `${generic.length}/${commits.length} recent commits use generic messages like "${generic[0].commit.message.split("\n")[0].slice(0, 40)}".`,
      });
    }

    // Burst pattern: most of the history landed in a couple of sessions.
    const dates = commits
      .map((c) => c.commit.author?.date)
      .filter((d): d is string => Boolean(d))
      .map((d) => new Date(d).getTime())
      .sort((a, b) => a - b);
    if (dates.length >= 10) {
      const span = dates[dates.length - 1] - dates[0];
      const hours = span / 3_600_000;
      if (hours > 0 && hours < 24) {
        signals.push({
          id: "ai.commit_burst",
          category: "ai",
          label: "Commit burst (single-session build)",
          weight: 14,
          evidence: `${dates.length} commits landed within ${hours.toFixed(1)} hours.`,
        });
      }
    }
  } else {
    coverage.notes.push("Commit history could not be read.");
  }

  // True first commit via the Link: rel="last" header trick.
  coverage.sourcesAttempted += 1;
  const firstPage = await api.raw(
    `/repos/${owner}/${repo}/commits?per_page=1&sha=${encodeURIComponent(branch)}`,
  );
  if (firstPage?.ok) {
    coverage.sourcesRead += 1;
    const link = firstPage.headers.get("link") ?? "";
    const lastMatch = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
    const totalCommits = lastMatch ? Number(lastMatch[1]) : commits.length;
    let firstSha: string | null = null;
    if (lastMatch) {
      const lastPage = await api.json<CommitEntry[]>(
        `/repos/${owner}/${repo}/commits?per_page=1&page=${lastMatch[1]}&sha=${encodeURIComponent(branch)}`,
      );
      firstSha = lastPage?.[0]?.sha ?? null;
    } else if (commits.length > 0) {
      firstSha = commits[commits.length - 1].sha;
    }

    // A big first commit only means "code dump" on a young, short-history repo —
    // long-lived projects (or imported history) legitimately start huge.
    const youngRepo = totalCommits <= 60;
    if (firstSha && youngRepo) {
      const stat = await api.json<{ stats?: { additions?: number } }>(
        `/repos/${owner}/${repo}/commits/${firstSha}`,
      );
      const adds = stat?.stats?.additions ?? 0;
      if (adds > 1000) {
        signals.push({
          id: "ai.large_initial_commit",
          category: "ai",
          label: "Large initial commit (code dump)",
          weight: adds > 5000 ? 16 : 11,
          evidence: `The first commit added ${adds.toLocaleString()} lines in one go, on a repo with only ${totalCommits} commits.`,
          sourceRef: firstSha.slice(0, 7),
        });
      }
    }


    // Lots of code, almost no history.
    if (totalCommits > 0 && totalCommits <= 15 && paths.length >= 40) {
      signals.push({
        id: "ai.low_history_high_volume",
        category: "ai",
        label: "Large codebase, minimal history",
        weight: 13,
        evidence: `${paths.length} files but only ${totalCommits} commit${totalCommits === 1 ? "" : "s"} on ${branch}.`,
      });
    }
  }

  const { vibe, ai } = computeScores(signals, coverage);
  const vibeCount = signals.filter((s) => s.category === "vibe").length;
  const aiCount = signals.filter((s) => s.category === "ai").length;

  return {
    target,
    kind: "github",
    vibeScore: vibe,
    aiScore: ai,
    confidence: {
      vibe: confidenceFor(vibe, vibeCount, coverage),
      ai: confidenceFor(ai, aiCount, coverage),
    },
    signals,
    coverage,
    meta: { description: meta.description, stars: meta.stargazers_count, branch },
  };
}
