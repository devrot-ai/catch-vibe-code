import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vibe & AI Detector — Score any repo or site" },
      {
        name: "description",
        content:
          "Paste a GitHub repo or website URL to get a Vibe Score and AI Score with heuristic evidence.",
      },
      { property: "og:title", content: "Vibe & AI Detector" },
      {
        property: "og:description",
        content: "Heuristic scores for AI-assisted and vibe-coded projects.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const [url, setUrl] = useState("");
  const navigate = useNavigate();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = url.trim();
    if (!v) return;
    navigate({ to: "/scan", search: { url: v } });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-16">
        <div className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          heuristic audit
        </div>
        <h1 className="text-center text-5xl font-semibold tracking-tight sm:text-6xl">
          Vibe & AI Detector
        </h1>
        <p className="mt-4 max-w-xl text-center text-muted-foreground">
          Paste a GitHub repo or a public website. Get a Vibe Score (design-system fingerprints)
          and an AI Score (LLM-assisted code fingerprints) with the evidence.
        </p>

        <form onSubmit={onSubmit} className="mt-10 flex w-full max-w-2xl flex-col gap-3 sm:flex-row">
          <input
            type="text"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="github.com/user/repo  or  https://example.com"
            className="flex-1 rounded-md border border-input bg-background px-4 py-3 text-base outline-none ring-ring/50 focus:ring-2"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Analyze
          </button>
        </form>

        <Link
          to="/test"
          className="mt-6 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          Run test mode →
        </Link>

        <div className="mt-16 grid w-full max-w-2xl grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-5 text-card-foreground">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Vibe signals</div>
            <ul className="mt-3 space-y-1 text-sm">
              <li>Tailwind config & class density</li>
              <li>shadcn / Radix / lucide deps</li>
              <li>CSS design tokens</li>
              <li>Framework fingerprints</li>
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-card p-5 text-card-foreground">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">AI signals</div>
            <ul className="mt-3 space-y-1 text-sm">
              <li>.cursorrules / AGENTS.md / CLAUDE.md</li>
              <li>Copilot/Cursor/Claude in commits</li>
              <li>Bot-authored commits, big code dumps</li>
              <li>Tutorial-voice README prose</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
