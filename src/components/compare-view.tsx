import type { Signal } from "../lib/detectors/signals";
import type { CompareSnapshot } from "../lib/share-link";

type DiffRow = {
  id: string;
  label: string;
  category: Signal["category"];
  before: number | null;
  after: number | null;
  evidence: string;
};

export function diffSignals(before: Signal[], after: Signal[]): DiffRow[] {
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

export function Delta({ value, suffix = "" }: { value: number; suffix?: string }) {
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

export function CompareView({
  baseline,
  current,
  title = "Changes since previous scan",
}: {
  baseline: CompareSnapshot;
  current: CompareSnapshot;
  title?: string;
}) {
  const rows = diffSignals(baseline.signals, current.signals);
  return (
    <div className="mt-8 rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
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
