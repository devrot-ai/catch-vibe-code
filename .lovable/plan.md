# Tuning controls on /test

The scoring logic on the Test mode page already supports adjustable bucket boundaries and low-confidence rules (`classifyBucket`, `isLowConfidenceWithRules`, `clampThresholds`, and the `bucketThresholds` / `confidenceRules` state), but there is no way to change them from the UI — the values are stuck at the defaults (low/medium at 35, medium/high at 65, min 2 signals, 5-point boundary window). This adds the controls.

## What gets added

A "Tuning" panel above the filter chips, collapsed by default, with four controls:

- Low/medium boundary (default 35)
- Medium/high boundary (default 65)
- Minimum signals for confidence (default 2)
- Boundary window in points (default 5)

Each is a slider with a live numeric readout. Changing any value instantly recomputes buckets, PASS/FAIL, low-confidence flags, the pass-rate cards, the filtered pass rate, and the visible rows — no re-run needed.

Additional details:

- The boundaries are kept ordered and in range through the existing clamp helper, so the low boundary can never pass the high one.
- A "Reset to defaults" link restores 35 / 65 / 2 / 5 and appears only when values differ from defaults.
- The descriptive line under the heading ("low < 35, medium 35–64, high ≥ 65") becomes dynamic and reflects the current boundaries.
- The signal-breakdown ("why?") rows and the CSV export already receive the current thresholds, so they follow the new values automatically.

## Technical notes

All changes are confined to `src/routes/test.tsx`:

- New `ThresholdSlider` presentational component (label, range input, value badge).
- New `TuningPanel` component wired to `setBucketThresholds` / `setConfidenceRules`, routing threshold edits through `clampThresholds`.
- Boundary sliders range 0–100 step 1; min-signals 0–10 step 1; boundary window 0–25 step 1.
- Styling uses existing semantic tokens (`border-border`, `bg-card`, `text-muted-foreground`) to match the current page.

## Build fix required first

`src/routes/test.tsx` is currently broken and does not compile (JSX errors around lines 552-685 and 881). A duplicated filter bar and a duplicated table header were pasted into the run-history panel, leaving an orphaned `history.map(...)` fragment with no opening markup, and `<tbody>` is written twice.

The fix, before adding tuning controls:

- Replace the malformed block (the wrapper at line 552 through the stray `key={run.id}`) with the intended run-history panel: a `space-y-4` wrapper, a "Run history" card, an empty state, and `history.map((run, index) => <HistoryRow run active previous={history[index + 1]} onClick=... />)` so the existing closing tags line up.
- Remove the duplicate `<tbody>` opening tag.
- Keep the single filter bar and single results table that already exist further down the file.
