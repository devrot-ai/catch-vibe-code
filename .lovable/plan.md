# Per-scan retry timeline

## What will change

- Extend retry tracking to record each throttled response, the wait before the next attempt, and the outcome of that next attempt in chronological order.
- Add the ordered timeline to both the always-written throttling report and the failure-only E2E scan report.
- Show the timeline in the GitHub Actions summary with timestamps, request path, attempt sequence, throttle reason/status, wait duration, and outcome.
- Include timeline fields in the CSV export for spreadsheet analysis.

## Compatibility and validation

- Introduce a new report schema version because the machine-readable report contract gains required timeline data.
- Keep the existing retry event log for compatibility and enforce consistency between event counts, retry totals, and timeline entries.
- Cap timeline growth alongside the current retry-event cap.

## Tests

- Add deterministic offline coverage for successful recovery, repeated throttling, timeout recovery, final failed outcomes, and exhausted wait budgets.
- Update report schema, CSV, and summary tests, then run the retry unit and coverage suites.
