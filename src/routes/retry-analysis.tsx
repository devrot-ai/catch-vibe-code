import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { analyzeRetryTimeline } from "../lib/ai-analysis.functions";

export const Route = createFileRoute("/retry-analysis")({
  head: () => ({
    meta: [
      { title: "Retry timeline analysis — Vibe & AI Detector" },
      { name: "description", content: "Analyze GitHub E2E retry timelines and get evidence-based throttling fixes." },
      { property: "og:title", content: "Retry timeline analysis — Vibe & AI Detector" },
      { property: "og:description", content: "Find likely causes of GitHub retry throttling and practical scan-configuration fixes." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RetryAnalysisPage,
});

function RetryAnalysisPage() {
  const analyze = useServerFn(analyzeRetryTimeline);
  const [rawJson, setRawJson] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<{
    retries: number;
    budgetExhausted: number;
    waitedMs: number;
    longestWaitMs: number;
    serverHintedWaits: number;
  } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAnalysis("");
    setSummary(null);
    setError("");
    setIsAnalyzing(true);
    try {
      const result = await analyze({ data: { rawJson } });
      if ("analysis" in result) {
        setAnalysis(result.analysis);
        setSummary(result.summary);
      } else {
        setError(result.error);
      }
    } catch {
      setError("The timeline could not be analyzed. Check the JSON and try again.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Home</Link>
          <Link to="/scan" search={{}} className="text-sm text-muted-foreground hover:text-foreground">Scan a repository or website</Link>
        </div>

        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Developer diagnostics</p>
          <h1 className="mt-2 text-3xl font-semibold">Retry timeline analysis</h1>
          <p className="mt-3 text-muted-foreground">
            Paste the E2E throttling report or its retry timeline. The analysis uses event patterns to suggest configuration changes; it does not change your scan settings.
          </p>

          <form onSubmit={onSubmit} className="mt-8">
            <label htmlFor="retry-json" className="mb-2 block text-sm font-medium">Retry timeline or report JSON</label>
            <Textarea
              id="retry-json"
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              placeholder={'Paste a retry event array or report with "retryTimeline" and "throttling" fields…'}
              className="min-h-72 resize-y font-mono text-xs"
              maxLength={120_000}
              required
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">JSON only · up to 500 events · 120,000 characters</span>
              <Button type="submit" disabled={isAnalyzing || !rawJson.trim()}>
                <Sparkles aria-hidden="true" />
                {isAnalyzing ? "Analyzing…" : "Analyze retry pattern"}
              </Button>
            </div>
          </form>

          {error && <p role="alert" className="mt-5 text-sm text-destructive">{error}</p>}

          {analysis && (
            <section className="mt-8 border-t border-border pt-6" aria-labelledby="retry-analysis-result">
              <h2 id="retry-analysis-result" className="text-xl font-semibold">Analysis</h2>
              {summary && (
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-4 text-sm sm:grid-cols-5">
                  <div><dt className="text-muted-foreground">Retries</dt><dd className="mt-1 font-mono">{summary.retries}</dd></div>
                  <div><dt className="text-muted-foreground">Waited</dt><dd className="mt-1 font-mono">{(summary.waitedMs / 1000).toFixed(1)}s</dd></div>
                  <div><dt className="text-muted-foreground">Longest wait</dt><dd className="mt-1 font-mono">{(summary.longestWaitMs / 1000).toFixed(1)}s</dd></div>
                  <div><dt className="text-muted-foreground">Server hints</dt><dd className="mt-1 font-mono">{summary.serverHintedWaits}</dd></div>
                  <div><dt className="text-muted-foreground">Budget exhausted</dt><dd className="mt-1 font-mono">{summary.budgetExhausted}</dd></div>
                </dl>
              )}
              <div className="mt-5 whitespace-pre-wrap text-sm leading-6">{analysis}</div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}