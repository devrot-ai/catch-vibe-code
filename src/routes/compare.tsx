import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { CompareView } from "../components/compare-view";
import { decodeCompare } from "../lib/share-link";

const searchSchema = z.object({ d: z.string().min(1) });

export const Route = createFileRoute("/compare")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({
    meta: [
      { title: "Shared comparison — Vibe & AI Detector" },
      {
        name: "description",
        content: "A shared before/after comparison of two Vibe and AI detection scans.",
      },
      { property: "og:title", content: "Shared comparison — Vibe & AI Detector" },
      {
        property: "og:description",
        content: "A shared before/after comparison of two Vibe and AI detection scans.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SharedComparePage,
});

function SharedComparePage() {
  const { d } = Route.useSearch();
  const [payload, setPayload] = useState<ComparePayload | null>(null);
  const [decoding, setDecoding] = useState(true);

  useEffect(() => {
    let live = true;
    setDecoding(true);
    decodeCompare(d).then((p) => {
      if (!live) return;
      setPayload(p);
      setDecoding(false);
    });
    return () => {
      live = false;
    };
  }, [d]);

  if (decoding) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">
          Decoding shared comparison…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← New scan
          </Link>
          {payload && (
            <div className="max-w-xs truncate font-mono text-xs text-muted-foreground">
              {payload.after.target}
            </div>
          )}
        </div>

        <h1 className="text-2xl font-semibold">Shared comparison</h1>

        {!payload ? (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-destructive">
            This share link is invalid or was truncated. Ask for a fresh link.
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {payload.after.kind === "github" ? "GitHub repository" : "Website"} ·{" "}
              {payload.after.target} · snapshot taken{" "}
              {new Date(payload.at).toLocaleString()}
            </p>
            <CompareView
              baseline={payload.before}
              current={payload.after}
              title="Changes between the two shared scans"
            />
            <div className="mt-6">
              <Link
                to="/scan"
                search={{ url: payload.after.target }}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Run a fresh scan of this target
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
