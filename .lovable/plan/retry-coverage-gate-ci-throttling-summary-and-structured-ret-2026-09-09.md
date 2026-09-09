# Retry coverage gate, CI throttling summary, and structured retry logs

## 1. Coverage threshold for the retry logic

Add a dedicated coverage run so a regression that deletes or bypasses retry behaviour fails CI instead of silently passing.

- New script `test:coverage` runs the two retry suites under Bun with coverage enabled and a minimum line/function threshold (start at 90% lines, 90% functions for `src/lib/detectors/retry.ts`).
- Coverage is scoped to the retry module so unrelated detector code cannot dilute the number. Scoping uses Bun's coverage ignore patterns; if the installed Bun version does not support scoping, the run instead emits an lcov file and a tiny checker script reads the retry module's numbers and exits non-zero below the threshold.
- CI gains a "Retry coverage" step that runs it, plus a one-line coverage figure in the run summary.
- The existing `test:unit` command keeps working unchanged for fast local runs.

## 2. Throttling and retry statistics in the GitHub Actions step summary

Today the throttling stats only exist inside the failure artifact, so a run that passed slowly tells you nothing.

- The E2E test always writes `test-results/e2e-throttling.json` (on pass and on fail), containing duration, health status, request counts, and the per-scan throttle stats already collected (retries by reason, total and longest wait, server-hinted waits, exhausted budgets).
- A new workflow step (runs even on failure) turns that file into a markdown table on the run summary, with a heading that flags a run as potentially flaky when there were any retries, timeouts, rate-limited requests, or an exhausted wait budget.
- When the scan self-skipped, the step says so instead of printing an empty table.

Example summary:

```text
### Scan throttling — Complete (3.4s)
| Requests | OK | Rate limited | Timed out | Retries | Waited | Longest wait |
|---------:|---:|-------------:|----------:|--------:|-------:|-------------:|
|       13 | 13 |            0 |         0 |       2 |  1.6s  |        1.0s  |
Retries by reason: rate-limited 2, server-error 0, timeout 0
```

## 3. Structured JSON retry logs in the scan report

- The retry runner gains an optional event callback. Each retry emits one structured record: timestamp, request path, attempt index, reason, HTTP status, whether the wait came from a server hint, hinted wait, actual wait, and running budget spent. Budget exhaustion emits its own record.
- The GitHub client passes the request path into the runner so each event names the endpoint that was throttled.
- The E2E report artifact gains a `retryLog` array of these records (also included in the always-written throttling file), so retry events can be parsed and charted without scraping logs.
- The log is capped (a few hundred events) so a badly throttled run cannot produce an enormous artifact.

## Technical notes

- `src/lib/detectors/retry.ts`: add `RetryEvent` type and `onEvent?: (e: RetryEvent) => void` to `RetryRunnerOptions`; the runner accepts an optional label for the current request. Existing signature stays backwards compatible so `tests/retry-fixture.test.mjs` keeps passing.
- `src/lib/detectors/github.ts`: `makeClient` creates a per-scan event buffer, passes the path label into `run(...)`, and exposes the buffer so `analyzeGithub` can attach it to the result health object.
- `src/lib/detectors/health.ts`: `ScanHealth.throttling` gains `events: RetryEvent[]`.
- `tests/e2e-github.test.mjs`: extract the report builder, always write the throttling file, include `retryLog`, and assert the log is consistent with the retry counters (log length equals retries plus budget-exhaustion records).
- `tests/retry-fixture.test.mjs`: add offline assertions that scripted throttling produces the expected structured events (deterministic, no network).
- `.github/workflows/e2e.yml`: add the coverage step and the always-run throttling summary step; keep the failure-only artifact upload as is.
