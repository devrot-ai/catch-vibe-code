import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { analyzeUrl } from "../lib/analyze.functions";
import type { AnalysisResult, Signal } from "../lib/detectors/signals";
import type { ScanHealth } from "../lib/detectors/health";
import { CompareView } from "../components/compare-view";
import { encodeCompare } from "../lib/share-link";
import { explainScan } from "../lib/ai-analysis.functions";
import { Button } from "../components/ui/button";
import { Sparkles } from "lucide-react";

const searchSchema = z.object({ url: z.string().min(1).optional() });

export const Route = createFileRoute("/scan")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({
    meta: [
      { title: "Scan results — Vibe & AI Detector" },
      { name: "description", content: "Heuristic Vibe and AI scores with evidence." },
      { property: "og:title", content: "Scan results — Vibe & AI Detector" },
      { property: "og:description", content: "Heuristic Vibe and AI scores with evidence." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ScanPage,
});

function verdict(score: number): { label: string; tone: string } {
  if (score >= 65) return { label: "High", tone: "text-red-500" };
  if (score >= 35) return { label: "Medium", tone: "text-amber-500" };
  return { label: "Low", tone: "text-emerald-500" };
}

function Gauge({ score, label, subtitle }: { score: number; label: string; subtitle: string }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  const v = verdict(score);
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-44 w-44">
        <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90">
          <circle cx="90" cy="90" r={r} fill="none" stroke="var(--color-muted)" strokeWidth="14" />
          <circle
            cx="90"
            cy="90"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="14"
            strokeDasharray={c}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className={v.tone}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-4xl font-semibold">{score}</div>
          <div className={`text-xs font-medium uppercase tracking-wider ${v.tone}`}>{v.label}</div>
        </div>
      </div>
      <div className="mt-3 text-lg font-medium">{label}</div>
      <div className="text-sm text-muted-foreground">{subtitle}</div>
    </div>
  );
}

function Breakdown({
  title,
  score,
  signals,
}: {
  title: string;
  score: number;
  signals: Signal[];
}) {
  const sorted = signals.slice().sort((a, b) => b.weight - a.weight);
  const raw = sorted.reduce((a, b) => a + b.weight, 0);
  const max = Math.max(1, ...sorted.map((s) => s.weight));
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <span className="font-mono text-xs text-muted-foreground">{score}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No signals fired — score stays at 0, which reads as low.
        </p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((s) => (
            <li key={s.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{s.label}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  +{s.weight} · {raw > 0 ? Math.round((s.weight / raw) * 100) : 0}%
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground/60"
                  style={{ width: `${Math.round((s.weight / max) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.evidence}</p>
              {s.sourceRef && (
                <p className="text-[11px] font-mono text-muted-foreground/70">{s.sourceRef}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
        {raw} raw weight → normalized score {score} · {sorted.length} signal
        {sorted.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}


function ConfidencePill({ label, detail, tone }: { label: string; detail: string; tone: string }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="text-xs font-semibold uppercase tracking-wider">{label}</div>
      <div className="mt-1 text-xs">{detail}</div>
    </div>
  );
}

const HEALTH_TONE: Record<ScanHealth["status"], string> = {
  complete: "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  slow: "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  "rate-limited": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-300",
};

function HealthBanner({ health }: { health: ScanHealth }) {
  const r = health.requests;
  return (
    <div className={`mt-4 rounded-lg border px-4 py-3 ${HEALTH_TONE[health.status]}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider">
          Scan health: {health.label}
        </span>
        <span className="font-mono text-[11px] opacity-80">
          {(health.durationMs / 1000).toFixed(1)}s · {r.ok}/{r.total} ok
          {r.rateLimited > 0 && ` · ${r.rateLimited} throttled`}
          {r.blocked > 0 && ` · ${r.blocked} blocked`}
          {r.timedOut > 0 && ` · ${r.timedOut} timed out`}
        </span>
      </div>
      <p className="mt-1 text-xs">{health.detail}</p>
    </div>
  );
}




function ScanPage() {
  const urlParam = Route.useSearch().url;
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState(urlParam ?? "");
  const analyze = useServerFn(analyzeUrl);
  const explain = useServerFn(explainScan);
  const [baseline, setBaseline] = useState<AnalysisResult | null>(null);
  const [shareState, setShareState] = useState<"idle" | "copied" | "failed">("idle");
  const [aiExplanation, setAiExplanation] = useState("");
  const [aiExplanationError, setAiExplanationError] = useState("");
  const [isExplaining, setIsExplaining] = useState(false);

  if (!urlParam) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-xl px-6 py-16">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back home
          </Link>
          <form
            className="mt-4 rounded-xl border border-border bg-card p-8"
            onSubmit={(e) => {
              e.preventDefault();
              const v = urlInput.trim();
              if (v) navigate({ to: "/scan", search: { url: v } });
            }}
          >
            <h1 className="text-xl font-semibold">Scan a repo or website</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Paste a GitHub repository or website URL to get its Vibe and AI scores.
            </p>
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={!urlInput.trim()}
              className="mt-3 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Scan
            </button>
          </form>
        </div>
      </div>
    );
  }

  const url = urlParam;

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["scan", url],
    queryFn: () => analyze({ data: { url } }),
    staleTime: 60_000,
    retry: false,
  });

  const rescan = async () => {
    if (data && !data.error) setBaseline(data);
    setShareState("idle");
    setAiExplanation("");
    setAiExplanationError("");
    await refetch();
  };

  const explainResults = async (result: AnalysisResult) => {
    setIsExplaining(true);
    setAiExplanationError("");
    const response = await explain({
      data: {
        target: result.target,
        kind: result.kind,
        vibeScore: result.vibeScore,
        aiScore: result.aiScore,
        confidence: result.confidence,
        signals: result.signals.map(({ category, label, weight, evidence, sourceRef }) => ({
          category,
          label,
          weight,
          evidence,
          sourceRef,
        })),
        coverage: result.coverage,
      },
    });
    if ("explanation" in response) setAiExplanation(response.explanation);
    else setAiExplanationError(response.error);
    setIsExplaining(false);
  };

  const shareComparison = async () => {
    if (!baseline || !data || data.error) return;
    const link = `${window.location.origin}/compare?d=${await encodeCompare(baseline, data)}`;
    try {
      await navigator.clipboard.writeText(link);
      setShareState("copied");
    } catch {
      window.prompt("Copy this comparison link:", link);
      setShareState("failed");
    }
    setTimeout(() => setShareState("idle"), 2500);
  };


  const vibeSignals = data?.signals.filter((s: Signal) => s.category === "vibe") ?? [];
  const aiSignals = data?.signals.filter((s: Signal) => s.category === "ai") ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← New scan
          </Link>
          <div className="flex items-center gap-4">
            <div className="text-xs font-mono text-muted-foreground truncate max-w-xs">{url}</div>
            <button
              type="button"
              onClick={rescan}
              disabled={isFetching}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {isFetching ? "Rescanning…" : "Rescan & compare"}
            </button>
            {baseline && data && !data.error && (
              <button
                type="button"
                onClick={shareComparison}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {shareState === "copied"
                  ? "Link copied"
                  : shareState === "failed"
                    ? "Copy manually"
                    : "Share comparison"}
              </button>
            )}
            {baseline && (
              <button
                type="button"
                onClick={() => setBaseline(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear comparison
              </button>
            )}

          </div>
        </div>

        {isFetching && (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
            Scanning… this can take a few seconds.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-destructive">
            {(error as Error).message}
          </div>
        )}

        {data && !isFetching && (
          <>
            {data.error ? (
              <>
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-destructive">
                  {data.error}
                </div>
                {data.health && <HealthBanner health={data.health} />}
                {data.kind === "github" && data.githubAccess && (
                  <div className={`mt-3 rounded-md border px-4 py-3 text-sm ${data.githubAccess.mode === "anonymous" ? "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200" : "border-emerald-500/25 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200"}`}>
                    <div className="font-medium">
                      GitHub access: {data.githubAccess.mode === "authenticated" ? "Authenticated" : "Anonymous"}
                    </div>
                    {data.githubAccess.warning && <p className="mt-1 text-xs">{data.githubAccess.warning}</p>}
                  </div>
                )}
              </>
            ) : (
              <>
                {data.health && <HealthBanner health={data.health} />}
                <div className="mt-4 grid grid-cols-1 gap-8 rounded-xl border border-border bg-card p-8 sm:grid-cols-2">
                  <Gauge
                    score={data.vibeScore}
                    label="Vibe Score"
                    subtitle="Design-system fingerprints"
                  />
                  <Gauge
                    score={data.aiScore}
                    label="AI Score"
                    subtitle="LLM-assisted code fingerprints"
                  />
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ConfidencePill
                    label={`Vibe confidence: ${data.confidence.vibe.label}`}
                    detail={data.confidence.vibe.detail}
                    tone={
                      data.confidence.vibe.level === "high"
                        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                        : data.confidence.vibe.level === "medium"
                          ? "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                          : "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300"
                    }
                  />
                  <ConfidencePill
                    label={`AI confidence: ${data.confidence.ai.label}`}
                    detail={data.confidence.ai.detail}
                    tone={
                      data.confidence.ai.level === "high"
                        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                        : data.confidence.ai.level === "medium"
                          ? "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                          : "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300"
                    }
                  />
                </div>

                {data.coverage && (
                  <div className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Evidence coverage:</span>{" "}
                    read {data.coverage.sourcesRead} of {data.coverage.sourcesAttempted} sources
                    {data.coverage.notes.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-4">
                        {data.coverage.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <section className="mt-6 border-y border-border py-5" aria-labelledby="ai-explanation-title">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 id="ai-explanation-title" className="text-lg font-semibold">Plain-language explanation</h2>
                      <p className="mt-1 text-sm text-muted-foreground">An AI summary grounded in the signals above; it does not change the scores.</p>
                    </div>
                    <Button type="button" variant="outline" onClick={() => void explainResults(data)} disabled={isExplaining}>
                      <Sparkles aria-hidden="true" />
                      {isExplaining ? "Explaining…" : aiExplanation ? "Refresh explanation" : "Explain these scores"}
                    </Button>
                  </div>
                  {aiExplanationError && <p role="alert" className="mt-4 text-sm text-destructive">{aiExplanationError}</p>}
                  {aiExplanation && <div className="prose prose-sm dark:prose-invert mt-4 max-w-none whitespace-pre-wrap text-sm leading-6">{aiExplanation}</div>}
                </section>

                <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <Breakdown title="Vibe evidence" score={data.vibeScore} signals={vibeSignals} />
                  <Breakdown title="AI evidence" score={data.aiScore} signals={aiSignals} />
                </div>

                {baseline && <CompareView baseline={baseline} current={data} />}

                <div className="mt-6 text-xs text-muted-foreground">
                  Kind: {data.kind} · Target: {data.target}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
