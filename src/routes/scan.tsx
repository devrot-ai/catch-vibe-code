import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { analyzeUrl } from "../lib/analyze.functions";
import type { Signal } from "../lib/detectors/signals";

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

function SignalRow({ s }: { s: Signal }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <div className="flex-1">
        <div className="text-sm font-medium">{s.label}</div>
        <div className="mt-1 text-xs text-muted-foreground">{s.evidence}</div>
        {s.sourceRef && (
          <div className="mt-1 text-[11px] font-mono text-muted-foreground/80">{s.sourceRef}</div>
        )}
      </div>
      <div className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
        +{s.weight}
      </div>
    </div>
  );
}

function ScanPage() {
  const { url } = Route.useSearch();
  const analyze = useServerFn(analyzeUrl);

  const { data, isFetching, error } = useQuery({
    queryKey: ["scan", url],
    queryFn: () => analyze({ data: { url } }),
    staleTime: 60_000,
    retry: false,
  });

  const vibeSignals = data?.signals.filter((s: Signal) => s.category === "vibe") ?? [];
  const aiSignals = data?.signals.filter((s: Signal) => s.category === "ai") ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← New scan
          </Link>
          <div className="text-xs font-mono text-muted-foreground truncate max-w-md">{url}</div>
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

                <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div className="rounded-lg border border-border bg-card p-6">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      Vibe evidence
                    </h2>
                    {vibeSignals.length === 0 ? (
                      <div className="text-sm text-muted-foreground">No vibe signals detected.</div>
                    ) : (
                      vibeSignals.map((s) => <SignalRow key={s.id} s={s} />)
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-card p-6">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      AI evidence
                    </h2>
                    {aiSignals.length === 0 ? (
                      <div className="text-sm text-muted-foreground">No AI signals detected.</div>
                    ) : (
                      aiSignals.map((s) => <SignalRow key={s.id} s={s} />)
                    )}
                  </div>
                </div>

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
