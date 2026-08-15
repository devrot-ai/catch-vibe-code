# Signal-by-signal breakdown on the results page

Upgrade `/scan` from a flat evidence list into a full contribution breakdown, so each Vibe and AI score can be traced back to the individual signals that produced it.

## What changes on the results page

Each of the two evidence panels (Vibe, AI) becomes a breakdown panel:

- Signals sorted by weight, strongest first.
- A relative weight bar per signal showing how much it contributed compared to the strongest signal in that category.
- Percent-of-category contribution next to the `+weight` chip.
- Evidence text and the source reference (file path / URL) kept under each signal.
- A footer line per category: raw weight total, the normalized score it maps to, and the signal count — making clear why 40 raw does not mean a score of 40.

Above the two panels:

- A coverage strip using the existing coverage data: sources read vs attempted, plus any coverage notes (blocked fetch, proxy fallback, truncated tree).
- Confidence pills stay where they are, next to the gauges.

Empty state stays explicit: "No signals fired — score stays at 0, which reads as low."

## Technical notes

- Work is confined to `src/routes/scan.tsx`; detectors and scoring stay unchanged.
- The `Breakdown`/`SignalRow` presentation mirrors the component already used on `/test` (`src/routes/test.tsx` lines 49-108), reworked for the scan context (no expected/PASS-FAIL badge).
- Raw totals come from summing `signal.weight` per category; the normalized score is `data.vibeScore` / `data.aiScore`. Coverage comes from `data.coverage`, rendered only when present.
