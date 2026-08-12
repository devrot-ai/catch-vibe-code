import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { runRegressionSuite, type RegressionCaseResult } from "../lib/regression-suite";
import {
  createTestRunSnapshot,
  formatTestRunDate,
  getSnapshotDelta,
  readTestRunHistory,
  type TestRunSnapshot,
  writeTestRunHistory,
} from "../lib/test-history";
import {
  makePresetId,
  readCustomPresets,
  writeCustomPresets,
  type StoredPreset,
} from "../lib/test-presets";


export const Route = createFileRoute("/test")({
  head: () => ({
    meta: [
      { title: "Test mode — Vibe & AI Detector" },
      {
        name: "description",
        content:
          "Run the analyzer against deterministic sample fixtures and see pass/fail metrics.",
      },
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
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>
  );
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
  signals: RegressionCaseResult["signals"];
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
        Total {signals.reduce((a, b) => a + b.weight, 0)} raw → {score} capped · {signals.length}{" "}
        signal{signals.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

type BucketThresholds = {
  lowMax: number;
  mediumMax: number;
};

type ConfidenceRules = {
  minSignals: number;
  boundaryWindow: number;
};

type SortKey = "sample" | "vibe" | "ai" | "confidence";

type SortDirection = "asc" | "desc";

type SortConfig = {
  key: SortKey;
  direction: SortDirection;
};

const SORT_DEFAULT_DIRECTIONS: Record<SortKey, SortDirection> = {
  sample: "asc",
  vibe: "desc",
  ai: "desc",
  confidence: "asc",
};

function confidenceRank(level: string): number {
  if (level === "low") return 0;
  if (level === "medium") return 1;
  return 2;
}

function compareRows(
  a: RegressionCaseResult,
  b: RegressionCaseResult,
  sortConfig: SortConfig,
): number {
  const multiplier = sortConfig.direction === "asc" ? 1 : -1;

  switch (sortConfig.key) {
    case "sample":
      return multiplier * a.label.localeCompare(b.label);
    case "vibe":
      return multiplier * (a.vibeScore - b.vibeScore);
    case "ai":
      return multiplier * (a.aiScore - b.aiScore);
    case "confidence": {
      const aConfidence = Math.min(
        confidenceRank(a.confidence.vibe.level),
        confidenceRank(a.confidence.ai.level),
      );
      const bConfidence = Math.min(
        confidenceRank(b.confidence.vibe.level),
        confidenceRank(b.confidence.ai.level),
      );
      return multiplier * (aConfidence - bConfidence);
    }
  }
}

function buildSignalSummary(signals: RegressionCaseResult["signals"]): string {
  if (signals.length === 0) return "None";

  return signals
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((signal) => {
      const source = signal.sourceRef ? ` (${signal.sourceRef})` : "";
      return `${signal.label} [+${signal.weight}]: ${signal.evidence}${source}`;
    })
    .join(" | ");
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  const text = value == null ? "" : String(value);
  const escaped = text.replaceAll('"', '""');
  return `"${escaped}"`;
}

function buildCsvReport(
  rows: RegressionCaseResult[],
  sortConfig: SortConfig,
  bucketThresholds: BucketThresholds,
  confidenceRules: ConfidenceRules,
): string {
  const lines = [
    ["Test report", new Date().toISOString()],
    ["Sort key", sortConfig.key],
    ["Sort direction", sortConfig.direction],
    ["Low / Medium boundary", bucketThresholds.lowMax],
    ["Medium / High boundary", bucketThresholds.mediumMax],
    ["Minimum signals", confidenceRules.minSignals],
    ["Boundary window", confidenceRules.boundaryWindow],
    [],
    [
      "Sample",
      "Vibe score",
      "Vibe bucket",
      "AI score",
      "AI bucket",
      "Vibe pass",
      "AI pass",
      "Vibe confidence",
      "AI confidence",
      "Vibe why?",
      "AI why?",
      "Total signals",
      "Note",
    ],
    ...rows.map((row) => {
      const vibeSignals = row.signals.filter((signal) => signal.category === "vibe");
      const aiSignals = row.signals.filter((signal) => signal.category === "ai");
      return [
        row.label,
        row.vibeScore,
        row.vibeBucket,
        row.aiScore,
        row.aiBucket,
        row.vibePass,
        row.aiPass,
        row.confidence.vibe.label,
        row.confidence.ai.label,
        buildSignalSummary(vibeSignals),
        buildSignalSummary(aiSignals),
        row.signals.length,
        row.note,
      ];
    }),
  ];

  return lines
    .map((line) => (line.length === 0 ? "" : line.map((entry) => csvEscape(entry)).join(",")))
    .join("\n");
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function classifyBucket(
  score: number,
  thresholds: BucketThresholds,
): RegressionCaseResult["vibeBucket"] {
  if (score >= thresholds.mediumMax) return "high";
  if (score >= thresholds.lowMax) return "medium";
  return "low";
}

function isLowConfidenceWithRules(
  score: number,
  signalCount: number,
  thresholds: BucketThresholds,
  confidenceRules: ConfidenceRules,
): boolean {
  if (signalCount <= confidenceRules.minSignals) return true;
  const distanceToLow = Math.abs(score - thresholds.lowMax);
  const distanceToHigh = Math.abs(score - thresholds.mediumMax);
  return Math.min(distanceToLow, distanceToHigh) <= confidenceRules.boundaryWindow;
}

function clampThresholds(next: BucketThresholds): BucketThresholds {
  const lowMax = Math.max(1, Math.min(next.lowMax, next.mediumMax - 1));
  const mediumMax = Math.max(lowMax + 1, Math.min(next.mediumMax, 99));
  return {
    lowMax,
    mediumMax,
  };
}

export const DEFAULT_BUCKET_THRESHOLDS: BucketThresholds = { lowMax: 35, mediumMax: 65 };
export const DEFAULT_CONFIDENCE_RULES: ConfidenceRules = { minSignals: 2, boundaryWindow: 5 };

const PRESETS = [
  {
    key: "strict",
    label: "Strict",
    thresholds: { lowMax: 50, mediumMax: 80 } as BucketThresholds,
    confidenceRules: { minSignals: 4, boundaryWindow: 8 } as ConfidenceRules,
  },
  {
    key: "balanced",
    label: "Balanced",
    thresholds: DEFAULT_BUCKET_THRESHOLDS,
    confidenceRules: DEFAULT_CONFIDENCE_RULES,
  },
  {
    key: "lenient",
    label: "Lenient",
    thresholds: { lowMax: 20, mediumMax: 50 } as BucketThresholds,
    confidenceRules: { minSignals: 1, boundaryWindow: 3 } as ConfidenceRules,
  },
];

function PresetChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
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
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function ThresholdSlider({
  label,
  value,
  min,
  max,
  step = 1,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-foreground">{label}</label>
        <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 font-mono text-xs text-foreground">
          {value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-primary"
      />
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function TuningPanel({
  thresholds,
  confidenceRules,
  onThresholdsChange,
  onConfidenceRulesChange,
}: {
  thresholds: BucketThresholds;
  confidenceRules: ConfidenceRules;
  onThresholdsChange: (next: BucketThresholds) => void;
  onConfidenceRulesChange: (next: ConfidenceRules) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customPresets, setCustomPresets] = useState<StoredPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    setCustomPresets(readCustomPresets());
  }, []);

  const isDefault =
    thresholds.lowMax === DEFAULT_BUCKET_THRESHOLDS.lowMax &&
    thresholds.mediumMax === DEFAULT_BUCKET_THRESHOLDS.mediumMax &&
    confidenceRules.minSignals === DEFAULT_CONFIDENCE_RULES.minSignals &&
    confidenceRules.boundaryWindow === DEFAULT_CONFIDENCE_RULES.boundaryWindow;

  const matches = (preset: {
    thresholds: BucketThresholds;
    confidenceRules: ConfidenceRules;
  }) =>
    thresholds.lowMax === preset.thresholds.lowMax &&
    thresholds.mediumMax === preset.thresholds.mediumMax &&
    confidenceRules.minSignals === preset.confidenceRules.minSignals &&
    confidenceRules.boundaryWindow === preset.confidenceRules.boundaryWindow;

  const activePreset = PRESETS.find(matches);
  const activeCustomPreset = customPresets.find(matches);

  const saveCurrentAsPreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const existing = customPresets.find(
      (preset) => preset.name.toLowerCase() === name.toLowerCase(),
    );
    const next = existing
      ? customPresets.map((preset) =>
          preset.id === existing.id ? { ...preset, thresholds, confidenceRules } : preset,
        )
      : [...customPresets, { id: makePresetId(), name, thresholds, confidenceRules }];
    setCustomPresets(writeCustomPresets(next));
    setPresetName("");
    setSaveOpen(false);
  };

  const deletePreset = (id: string) => {
    setCustomPresets(writeCustomPresets(customPresets.filter((preset) => preset.id !== id)));
  };


  return (
    <div className="mt-8 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="text-sm font-semibold text-foreground"
        >
          Tuning {open ? "▾" : "▸"}
        </button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            buckets {thresholds.lowMax}/{thresholds.mediumMax} · min signals{" "}
            {confidenceRules.minSignals} · window ±{confidenceRules.boundaryWindow}
          </span>
          {!isDefault && (
            <button
              type="button"
              onClick={() => {
                onThresholdsChange(DEFAULT_BUCKET_THRESHOLDS);
                onConfidenceRulesChange(DEFAULT_CONFIDENCE_RULES);
              }}
              className="underline hover:text-foreground"
            >
              Reset to defaults
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Presets:</span>
        {PRESETS.map((preset) => (
          <PresetChip
            key={preset.key}
            active={activePreset?.key === preset.key}
            label={preset.label}
            onClick={() => {
              onThresholdsChange(clampThresholds(preset.thresholds));
              onConfidenceRulesChange(preset.confidenceRules);
            }}
          />
        ))}
        {customPresets.map((preset) => (
          <span key={preset.id} className="inline-flex items-center gap-1">
            <PresetChip
              active={activeCustomPreset?.id === preset.id}
              label={preset.name}
              onClick={() => {
                onThresholdsChange(clampThresholds(preset.thresholds));
                onConfidenceRulesChange(preset.confidenceRules);
              }}
            />
            <button
              type="button"
              onClick={() => deletePreset(preset.id)}
              aria-label={`Delete preset ${preset.name}`}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              ×
            </button>
          </span>
        ))}
        {saveOpen ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCurrentAsPreset();
                if (event.key === "Escape") {
                  setSaveOpen(false);
                  setPresetName("");
                }
              }}
              placeholder="Preset name"
              className="w-32 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={saveCurrentAsPreset}
              className="rounded-full border border-primary bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setSaveOpen(false);
                setPresetName("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            className="rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            + Save current
          </button>
        )}
      </div>


      {open && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ThresholdSlider
            label="Low / medium boundary"
            value={thresholds.lowMax}
            min={0}
            max={100}
            hint="Scores at or above this land in the medium bucket."
            onChange={(value) => onThresholdsChange(clampThresholds({ ...thresholds, lowMax: value }))}
          />
          <ThresholdSlider
            label="Medium / high boundary"
            value={thresholds.mediumMax}
            min={0}
            max={100}
            hint="Scores at or above this land in the high bucket."
            onChange={(value) =>
              onThresholdsChange(clampThresholds({ ...thresholds, mediumMax: value }))
            }
          />
          <ThresholdSlider
            label="Minimum signals for confidence"
            value={confidenceRules.minSignals}
            min={0}
            max={10}
            hint="At or below this many signals, a category is flagged low confidence."
            onChange={(value) => onConfidenceRulesChange({ ...confidenceRules, minSignals: value })}
          />
          <ThresholdSlider
            label="Boundary window (points)"
            value={confidenceRules.boundaryWindow}
            min={0}
            max={25}
            hint="Scores this close to a bucket boundary are flagged low confidence."
            onChange={(value) =>
              onConfidenceRulesChange({ ...confidenceRules, boundaryWindow: value })
            }
          />
        </div>
      )}
    </div>
  );
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

function SortHeader({
  active,
  direction,
  label,
  onClick,
}: {
  active: boolean;
  direction: SortDirection;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-left uppercase tracking-wider"
    >
      <span>{label}</span>
      <span aria-hidden className="text-[10px] leading-none">
        {active ? (direction === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </button>
  );
}

function DeltaValue({ value }: { value: number }) {
  const tone =
    value > 0 ? "text-emerald-500" : value < 0 ? "text-red-500" : "text-muted-foreground";
  const prefix = value > 0 ? "+" : "";

  return <span className={`font-mono text-xs ${tone}`}>{`${prefix}${value}`}</span>;
}

function HistoryRow({
  run,
  active,
  previous,
  onClick,
}: {
  run: TestRunSnapshot;
  active: boolean;
  previous?: TestRunSnapshot;
  onClick: () => void;
}) {
  const comparison = previous ? getSnapshotDelta(run, previous) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        active ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/40"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{formatTestRunDate(run.createdAt)}</div>
          <div className="text-xs text-muted-foreground">{run.totalCases} fixtures</div>
        </div>
        {active && <Badge ok>current</Badge>}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>
          Vibe {run.vibePassCount}/{run.totalCases}
        </span>
        <span>
          AI {run.aiPassCount}/{run.totalCases}
        </span>
        <span>Overall {run.overallPassRate}%</span>
      </div>
      {comparison && (
        <div className="mt-2 flex flex-wrap gap-3">
          <DeltaValue value={comparison.vibePassDelta} />
          <DeltaValue value={comparison.aiPassDelta} />
          <DeltaValue value={comparison.overallPassDelta} />
        </div>
      )}
    </button>
  );
}

function ComparisonRow({
  label,
  current,
  previous,
}: {
  label: string;
  current: TestRunSnapshot;
  previous?: TestRunSnapshot;
}) {
  if (!previous) {
    return null;
  }

  const currentCase = current.cases.find((entry) => entry.id === label);
  const previousCase = previous.cases.find((entry) => entry.id === label);
  if (!currentCase || !previousCase) return null;

  const vibeDelta = currentCase.vibeScore - previousCase.vibeScore;
  const aiDelta = currentCase.aiScore - previousCase.aiScore;
  if (vibeDelta === 0 && aiDelta === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="font-medium">{currentCase.label}</div>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>
          Vibe {previousCase.vibeScore} → {currentCase.vibeScore}
        </span>
        <DeltaValue value={vibeDelta} />
        <span>
          AI {previousCase.aiScore} → {currentCase.aiScore}
        </span>
        <DeltaValue value={aiDelta} />
      </div>
    </div>
  );
}

function TestPage() {
  const results = useMemo(() => runRegressionSuite(), []);
  const currentSummary = useMemo(() => createTestRunSnapshot(results), [results]);
  const [history, setHistory] = useState<TestRunSnapshot[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "ai", direction: "desc" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [bucketThresholds, setBucketThresholds] = useState<BucketThresholds>(
    DEFAULT_BUCKET_THRESHOLDS,
  );
  const [confidenceRules, setConfidenceRules] = useState<ConfidenceRules>(
    DEFAULT_CONFIDENCE_RULES,
  );
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    failedVibe: false,
    failedAi: false,
    lowConfidence: false,
  });

  useEffect(() => {
    const nextHistory = writeTestRunHistory(currentSummary);
    setHistory(nextHistory);
    setSelectedRunId((current) => current ?? nextHistory[0]?.id ?? null);
  }, [currentSummary]);

  const totalDone = results.length;
  const visibleRows = useMemo(
    () =>
      results.map((row) => {
        const vibeSignals = row.signals.filter((signal) => signal.category === "vibe");
        const aiSignals = row.signals.filter((signal) => signal.category === "ai");
        const vibeBucket = classifyBucket(row.vibeScore, bucketThresholds);
        const aiBucket = classifyBucket(row.aiScore, bucketThresholds);

        return {
          ...row,
          vibeBucket,
          aiBucket,
          vibePass: vibeBucket === row.expectedVibe,
          aiPass: aiBucket === row.expectedAi,
          lowConfidence:
            isLowConfidenceWithRules(
              row.vibeScore,
              vibeSignals.length,
              bucketThresholds,
              confidenceRules,
            ) ||
            isLowConfidenceWithRules(
              row.aiScore,
              aiSignals.length,
              bucketThresholds,
              confidenceRules,
            ),
        };
      }),
    [results, bucketThresholds, confidenceRules],
  );
  const vibePass = visibleRows.filter((r) => r.vibePass).length;
  const aiPass = visibleRows.filter((r) => r.aiPass).length;
  const activeRun = history.find((run) => run.id === selectedRunId) ?? history[0] ?? null;
  const activeRunIndex = activeRun ? history.findIndex((run) => run.id === activeRun.id) : -1;
  const previousRun = activeRunIndex >= 0 ? history[activeRunIndex + 1] : undefined;
  const activeComparison = activeRun ? getSnapshotDelta(activeRun, previousRun) : null;
  const changedCases = activeComparison?.changedCases ?? [];

  const filteredRows = visibleRows.filter((row) => {
    if (!filters.failedVibe && !filters.failedAi && !filters.lowConfidence) return true;
    return (
      (filters.failedVibe && !row.vibePass) ||
      (filters.failedAi && !row.aiPass) ||
      (filters.lowConfidence && row.lowConfidence)
    );
  });

  const filteredDone = filteredRows.length;
  const filteredVibePass = filteredRows.filter((row) => row.vibePass).length;
  const filteredAiPass = filteredRows.filter((row) => row.aiPass).length;
  const anyFilter = filters.failedVibe || filters.failedAi || filters.lowConfidence;
  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareRows(a, b, sortConfig)),
    [filteredRows, sortConfig],
  );
  const handleExport = () => {
    const report = buildCsvReport(sortedRows, sortConfig, bucketThresholds, confidenceRules);
    const dateStamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`test-report-${dateStamp}.csv`, report, "text/csv;charset=utf-8");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Home
          </Link>
          <div className="text-xs text-muted-foreground">
            {totalDone}/{totalDone} fixtures complete
          </div>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight">Test mode</h1>
        <p className="mt-2 text-muted-foreground">
          Runs the analyzer against deterministic sample fixtures and checks each score against an
          expected bucket (low &lt; {bucketThresholds.lowMax}, medium {bucketThresholds.lowMax}–
          {bucketThresholds.mediumMax - 1}, high ≥ {bucketThresholds.mediumMax}).
        </p>

        <TuningPanel
          thresholds={bucketThresholds}
          confidenceRules={confidenceRules}
          onThresholdsChange={setBucketThresholds}
          onConfidenceRulesChange={setConfidenceRules}
        />

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Vibe pass</div>
            <div className="mt-1 text-2xl font-semibold">
              {vibePass}/{totalDone}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">AI pass</div>
            <div className="mt-1 text-2xl font-semibold">
              {aiPass}/{totalDone}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Overall</div>
            <div className="mt-1 text-2xl font-semibold">
              {Math.round(((vibePass + aiPass) / (totalDone * 2)) * 100)}%
            </div>
          </div>
        </div>

        <div className="mt-8 space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-sm font-semibold">Run history</div>
            <div className="mt-3 space-y-2">
              {history.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No saved runs yet.
                </div>
              ) : (
                history.map((run, index) => (
                  <HistoryRow
                    key={run.id}
                    run={run}
                    active={run.id === activeRun?.id}
                    previous={history[index + 1]}
                    onClick={() => setSelectedRunId(run.id)}
                  />
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Selected run comparison</div>
                <div className="text-xs text-muted-foreground">
                  {activeRun
                    ? formatTestRunDate(activeRun.createdAt)
                    : "Waiting for history to load"}
                </div>
              </div>
              {activeRun && previousRun ? (
                <div className="text-right text-xs text-muted-foreground">
                  vs {formatTestRunDate(previousRun.createdAt)}
                </div>
              ) : (
                <div className="text-right text-xs text-muted-foreground">No previous run</div>
              )}
            </div>

            {activeRun && activeComparison ? (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Vibe delta
                  </div>
                  <div className="mt-1 text-lg font-semibold">
                    {activeComparison.vibePassDelta >= 0 ? "+" : ""}
                    {activeComparison.vibePassDelta}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    AI delta
                  </div>
                  <div className="mt-1 text-lg font-semibold">
                    {activeComparison.aiPassDelta >= 0 ? "+" : ""}
                    {activeComparison.aiPassDelta}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Pass-rate delta
                  </div>
                  <div className="mt-1 text-lg font-semibold">
                    {activeComparison.overallPassDelta >= 0 ? "+" : ""}
                    {activeComparison.overallPassDelta}%
                  </div>
                </div>
              </div>
            ) : null}

            {activeRun && previousRun ? (
              <div className="mt-4 space-y-2">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Changed fixtures
                </div>
                {changedCases.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                    No score changes from the previous run.
                  </div>
                ) : (
                  changedCases.map((entry) => (
                    <ComparisonRow
                      key={entry.id}
                      label={entry.id}
                      current={activeRun}
                      previous={previousRun}
                    />
                  ))
                )}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                Once you have at least two saved runs, this area will compare Vibe and AI score
                changes between dates.
              </div>
            )}
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
                onClick={() =>
                  setFilters({ failedVibe: false, failedAi: false, lowConfidence: false })
                }
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                clear
              </button>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Showing {filteredRows.length} of {results.length} fixtures
            {anyFilter && filteredDone > 0 && (
              <span className="ml-2 text-foreground">
                filtered pass rate:{" "}
                {Math.round(((filteredVibePass + filteredAiPass) / (filteredDone * 2)) * 100)}%
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">
                  <SortHeader
                    active={sortConfig.key === "sample"}
                    direction={sortConfig.direction}
                    label="Sample"
                    onClick={() =>
                      setSortConfig((current) =>
                        current.key === "sample"
                          ? {
                              key: "sample",
                              direction: current.direction === "asc" ? "desc" : "asc",
                            }
                          : { key: "sample", direction: SORT_DEFAULT_DIRECTIONS.sample },
                      )
                    }
                  />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortHeader
                    active={sortConfig.key === "vibe"}
                    direction={sortConfig.direction}
                    label="Vibe likelihood"
                    onClick={() =>
                      setSortConfig((current) =>
                        current.key === "vibe"
                          ? {
                              key: "vibe",
                              direction: current.direction === "asc" ? "desc" : "asc",
                            }
                          : { key: "vibe", direction: SORT_DEFAULT_DIRECTIONS.vibe },
                      )
                    }
                  />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortHeader
                    active={sortConfig.key === "ai"}
                    direction={sortConfig.direction}
                    label="AI risk"
                    onClick={() =>
                      setSortConfig((current) =>
                        current.key === "ai"
                          ? { key: "ai", direction: current.direction === "asc" ? "desc" : "asc" }
                          : { key: "ai", direction: SORT_DEFAULT_DIRECTIONS.ai },
                      )
                    }
                  />
                </th>
                <th className="px-4 py-3 text-left">
                  <SortHeader
                    active={sortConfig.key === "confidence"}
                    direction={sortConfig.direction}
                    label="Confidence"
                    onClick={() =>
                      setSortConfig((current) =>
                        current.key === "confidence"
                          ? {
                              key: "confidence",
                              direction: current.direction === "asc" ? "desc" : "asc",
                            }
                          : { key: "confidence", direction: SORT_DEFAULT_DIRECTIONS.confidence },
                      )
                    }
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const open = !!expanded[row.id];
                return (
                  <Fragment key={row.id}>
                    <tr className="border-t border-border align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.note}</div>
                        <div className="mt-1 flex gap-3">
                          <button
                            type="button"
                            onClick={() => setExpanded((e) => ({ ...e, [row.id]: !e[row.id] }))}
                            className="text-xs text-muted-foreground underline hover:text-foreground"
                          >
                            {open ? "hide breakdown" : `why? (${row.signals.length} signals)`}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono">{row.vibeScore}</span>
                          <span className="text-xs text-muted-foreground">({row.vibeBucket})</span>
                          <Badge ok={row.vibePass}>{row.vibePass ? "PASS" : "FAIL"}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          expect: {row.expectedVibe}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono">{row.aiScore}</span>
                          <span className="text-xs text-muted-foreground">({row.aiBucket})</span>
                          <Badge ok={row.aiPass}>{row.aiPass ? "PASS" : "FAIL"}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          expect: {row.expectedAi}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className={row.lowConfidence ? "text-amber-500" : "text-emerald-500"}>
                          {row.lowConfidence ? "low confidence" : "ok"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Vibe: {row.confidence.vibe.label} · AI: {row.confidence.ai.label}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-border bg-muted/20">
                        <td colSpan={4} className="px-4 py-4">
                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <Breakdown
                              title="Vibe signals"
                              score={row.vibeScore}
                              expected={row.expectedVibe}
                              ok={row.vibePass}
                              signals={row.signals.filter((signal) => signal.category === "vibe")}
                            />
                            <Breakdown
                              title="AI signals"
                              score={row.aiScore}
                              expected={row.expectedAi}
                              ok={row.aiPass}
                              signals={row.signals.filter((signal) => signal.category === "ai")}
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
          {sortedRows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No fixtures match the selected filters.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
