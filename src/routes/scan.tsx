import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { analyzeUrl } from "../lib/analyze.functions";
import type { AnalysisResult, Signal } from "../lib/detectors/signals";

const searchSchema = z.object({ url: z.string().min(1) });

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

type DiffRow = {
  id: string;
  label: string;
  category: Signal["category"];
  before: number | null;
  after: number | null;
  evidence: string;
};

function diffSignals(before: Signal[], after: Signal[]): DiffRow[] {
  const b = new Map(before.map((s) => [s.id, s]));
  const a = new Map(after.map((s) => [s.id, s]));
  const ids = new Set([...b.keys(), ...a.keys()]);
  const rows: DiffRow[] = [];
  for (const id of ids) {
    const bs = b.get(id);
    const as = a.get(id);
    if (bs && as && bs.weight === as.weight) continue;
    const ref = as ?? bs!;
    rows.push({
      id,
      label: ref.label,
      category: ref.category,
      before: bs ? bs.weight : null,
      after: as ? as.weight : null,
      evidence: ref.evidence,
    });
  }
  return rows.sort(
    (x, y) => Math.abs((y.after ?? 0) - (y.before ?? 0)) - Math.abs((x.after ?? 0) - (x.before ?? 0)),
  );
}

function Delta({ value, suffix = "" }: { value: number; suffix?: string }) {
  const tone =
    value > 0 ? "text-red-500" : value < 0 ? "text-emerald-500" : "text-muted-foreground";
  return (
    <span className={`font-mono text-xs ${tone}`}>
      {value > 0 ? "+" : ""}
      {value}
      {suffix}
    </span>
  );
}

function CompareView({ baseline, current }: { baseline: AnalysisResult; current: AnalysisResult }) {
  const rows = diffSignals(baseline.signals, current.signals);
  return (
    <div className="mt-8 rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Changes since previous scan
        </h2>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>
            Vibe {baseline.vibeScore} → {current.vibeScore}{" "}
            <Delta value={current.vibeScore - baseline.vibeScore} />
          </span>
          <span>
            AI {baseline.aiScore} → {current.aiScore}{" "}
            <Delta value={current.aiScore - baseline.aiScore} />
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No signal changed — the rerun reproduced the previous result exactly.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const status = r.before === null ? "new" : r.after === null ? "gone" : "changed";
            return (
              <li key={r.id} className="border-b border-border/60 pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">
                    <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {r.category}
                    </span>
                    {r.label}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {status === "new" && <span className="text-red-500">new signal</span>}
                    {status === "gone" && <span className="text-emerald-500">no longer fires</span>}
                    {r.before ?? 0} → {r.after ?? 0}{" "}
                    <Delta value={(r.after ?? 0) - (r.before ?? 0)} />
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{r.evidence}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ScanPage() {
  const { url } = Route.useSearch();
  const analyze = useServerFn(analyzeUrl);
  const [baseline, setBaseline] = useState<AnalysisResult | null>(null);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["scan", url],
    queryFn: () => analyze({ data: { url } }),
    staleTime: 60_000,
    retry: false,
  });

  const rescan = async () => {
    if (data && !data.error) setBaseline(data);
    await refetch();
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
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-destructive">
                {data.error}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-8 rounded-xl border border-border bg-card p-8 sm:grid-cols-2">
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
