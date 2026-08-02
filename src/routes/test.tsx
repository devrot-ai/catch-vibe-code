import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueries } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { analyzeUrl } from "../lib/analyze.functions";
import { TEST_SAMPLES, passes, scoreBucket } from "../lib/test-samples";
import type { AnalysisResult, Signal } from "../lib/detectors/signals";

export const Route = createFileRoute("/test")({
  head: () => ({
    meta: [
      { title: "Test mode — Vibe & AI Detector" },
      { name: "description", content: "Run the analyzer against known sample repos and see pass/fail metrics." },
      { property: "og:title", content: "Test mode — Vibe & AI Detector" },
      { property: "og:description", content: "Regression harness for Vibe and AI heuristics." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TestPage,
});

function Badge({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const tone =
    ok === null
      ? "bg-muted text-muted-foreground"
      : ok
        ? "bg-emerald-500/15 text-emerald-500"
        : "bg-red-500/15 text-red-500";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>;
}

function Breakdown({
  title,
  score,
  expected,
  ok,
  signals,
}: {
  title: string;
  score: number;
  expected: string;
  ok: boolean | null;
  signals: Signal[];
}) {
  const max = Math.max(1, ...signals.map((s) => s.weight));
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{title}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{score}</span>
          <span>vs {expected}</span>
          <Badge ok={ok}>{ok ? "PASS" : "FAIL"}</Badge>
        </div>
      </div>
      {signals.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No signals fired — score stays at 0, which reads as “low”.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {signals
            .slice()
            .sort((a, b) => b.weight - a.weight)
            .map((sig) => (
              <li key={sig.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium">{sig.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">+{sig.weight}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-foreground/60"
                    style={{ width: `${Math.round((sig.weight / max) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{sig.evidence}</p>
                {sig.sourceRef && (
                  <p className="text-[11px] font-mono text-muted-foreground/70">{sig.sourceRef}</p>
                )}
              </li>
            ))}
        </ul>
      )}
      <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
        Total {signals.reduce((a, b) => a + b.weight, 0)} raw → {score} capped ·{" "}
        {signals.length} signal{signals.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function isLowConfidence(score: number, signalCount: number): boolean {
  // Sparse evidence coverage.
  if (signalCount <= 2) return true;
  // Within 5 points of a bucket boundary (35 or 65).
  const distance = Math.min(Math.abs(score - 35), Math.abs(score - 65));
  return distance <= 5;
}

export type FilterKey = "failedVibe" | "failedAi" | "lowConfidence";

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function TestPage() {
  const analyze = useServerFn(analyzeUrl);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    failedVibe: false,
    failedAi: false,
    lowConfidence: false,
  });

  const queries = useQueries({
    queries: TEST_SAMPLES.map((s) => ({
      queryKey: ["test-scan", s.url],
      queryFn: () => analyze({ data: { url: s.url } }) as Promise<AnalysisResult>,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  const rows = useMemo(
    () =>
      TEST_SAMPLES.map((s, i) => ({
        sample: s,
        query: queries[i],
        index: i,
      })),
    [queries],
  );

  const allDone = queries.filter((q) => q.data && !q.data.error).length;
  let vibePass = 0;
  let aiPass = 0;
  let totalDone = 0;
  queries.forEach((q, i) => {
    const d = q.data;
    if (!d || d.error) return;
    totalDone++;
    if (passes(d.vibeScore, TEST_SAMPLES[i].expectVibe)) vibePass++;
    if (passes(d.aiScore, TEST_SAMPLES[i].expectAi)) aiPass++;
  });

  const filteredRows = rows.filter(({ sample, query }) => {
    const d = query.data;
    if (!d || d.error) return true; // Keep loading/error rows visible.
    const vibeOk = passes(d.vibeScore, sample.expectVibe);
    const aiOk = passes(d.aiScore, sample.expectAi);
    const lowConf = isLowConfidence(d.vibeScore, d.signals.length) || isLowConfidence(d.aiScore, d.signals.length);

    if (!filters.failedVibe && !filters.failedAi && !filters.lowConfidence) return true;

    const matches =
      (filters.failedVibe && !vibeOk) ||
      (filters.failedAi && !aiOk) ||
      (filters.lowConfidence && lowConf);
    return matches;
  });

  let filteredVibePass = 0;
  let filteredAiPass = 0;
  let filteredDone = 0;
  filteredRows.forEach(({ sample, query }) => {
    const d = query.data;
    if (!d || d.error) return;
    filteredDone++;
    if (passes(d.vibeScore, sample.expectVibe)) filteredVibePass++;
    if (passes(d.aiScore, sample.expectAi)) filteredAiPass++;
  });

  const anyFilter = filters.failedVibe || filters.failedAi || filters.lowConfidence;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Home
          </Link>
          <div className="text-xs text-muted-foreground">
            {allDone}/{TEST_SAMPLES.length} scans complete
          </div>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight">Test mode</h1>
        <p className="mt-2 text-muted-foreground">
          Runs the analyzer against known sample GitHub repos and checks each score against an
          expected bucket (low &lt; 35, medium 35–64, high ≥ 65).
        </p>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Vibe pass</div>
            <div className="mt-1 text-2xl font-semibold">
              {vibePass}/{totalDone || TEST_SAMPLES.length}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">AI pass</div>
            <div className="mt-1 text-2xl font-semibold">
              {aiPass}/{totalDone || TEST_SAMPLES.length}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Overall</div>
            <div className="mt-1 text-2xl font-semibold">
              {totalDone > 0 ? Math.round(((vibePass + aiPass) / (totalDone * 2)) * 100) : 0}%
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip
              active={filters.failedVibe}
              onClick={() => setFilters((f) => ({ ...f, failedVibe: !f.failedVibe }))}
            >
              Failed Vibe
            </FilterChip>
            <FilterChip
              active={filters.failedAi}
              onClick={() => setFilters((f) => ({ ...f, failedAi: !f.failedAi }))}
            >
              Failed AI
            </FilterChip>
            <FilterChip
              active={filters.lowConfidence}
              onClick={() => setFilters((f) => ({ ...f, lowConfidence: !f.lowConfidence }))}
            >
              Low confidence / evidence
            </FilterChip>
            {anyFilter && (
              <button
                type="button"
                onClick={() => setFilters({ failedVibe: false, failedAi: false, lowConfidence: false })}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                clear
              </button>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Showing {filteredRows.length} of {rows.length} repos
            {anyFilter && filteredDone > 0 && (
              <span className="ml-2 text-foreground">
                filtered pass rate: {" "}
                {Math.round(((filteredVibePass + filteredAiPass) / (filteredDone * 2)) * 100)}%
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Sample</th>
                <th className="px-4 py-3 text-left">Vibe (expected)</th>
                <th className="px-4 py-3 text-left">AI (expected)</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ sample, query, index }) => {
                const d = query.data;
                const loading = query.isFetching;
                const err = query.error as Error | null;
                const vibeOk = d && !d.error ? passes(d.vibeScore, sample.expectVibe) : null;
                const aiOk = d && !d.error ? passes(d.aiScore, sample.expectAi) : null;
                const open = !!expanded[sample.url];
                return (
                  <Fragment key={sample.url}>
                  <tr className="border-t border-border align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{sample.label}</div>
                      <div className="text-xs text-muted-foreground">{sample.note}</div>
                      <div className="mt-1 flex gap-3">
                        <Link
                          to="/scan"
                          search={{ url: sample.url }}
                          className="inline-block text-xs text-muted-foreground underline hover:text-foreground"
                        >
                          open scan →
                        </Link>
                        {d && !d.error && (
                          <button
                            type="button"
                            onClick={() => setExpanded((e) => ({ ...e, [sample.url]: !e[sample.url] }))}
                            className="text-xs text-muted-foreground underline hover:text-foreground"
                          >
                            {open ? "hide breakdown" : `why? (${d.signals.length} signals)`}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {d && !d.error ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono">{d.vibeScore}</span>
                          <span className="text-xs text-muted-foreground">
                            ({scoreBucket(d.vibeScore)})
                          </span>
                          <Badge ok={vibeOk}>{vibeOk ? "PASS" : "FAIL"}</Badge>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <div className="text-xs text-muted-foreground">expect: {sample.expectVibe}</div>
                    </td>
                    <td className="px-4 py-3">
                      {d && !d.error ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono">{d.aiScore}</span>
                          <span className="text-xs text-muted-foreground">
                            ({scoreBucket(d.aiScore)})
                          </span>
                          <Badge ok={aiOk}>{aiOk ? "PASS" : "FAIL"}</Badge>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <div className="text-xs text-muted-foreground">expect: {sample.expectAi}</div>
                    </td>
                    <td className="px-4 py-3">
                      {loading && <span className="text-muted-foreground">scanning…</span>}
                      {err && <span className="text-red-500">{err.message}</span>}
                      {d?.error && <span className="text-red-500">{d.error}</span>}
                      {d && !d.error && !loading && (
                        <span className="text-emerald-500">ok</span>
                      )}
                    </td>
                  </tr>
                  {open && d && !d.error && (
                    <tr key={`${sample.url}-detail`} className="border-t border-border bg-muted/20">
                      <td colSpan={4} className="px-4 py-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <Breakdown
                            title="Vibe signals"
                            score={d.vibeScore}
                            expected={sample.expectVibe}
                            ok={vibeOk}
                            signals={d.signals.filter((x) => x.category === "vibe")}
                          />
                          <Breakdown
                            title="AI signals"
                            score={d.aiScore}
                            expected={sample.expectAi}
                            ok={aiOk}
                            signals={d.signals.filter((x) => x.category === "ai")}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {filteredRows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No repos match the selected filters.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
