# Retry handling for GitHub rate limits

## Goal
Keep the live scan (and the CI end-to-end test) stable when GitHub starts throttling requests, instead of silently dropping sources and reporting a thin, low-confidence result.

## What changes

### 1. Automatic retry with growing waits
Every GitHub request the scanner makes goes through one small helper. That helper gets retry behaviour:

- Retry only when the answer means "try again later": rate limited (429, or 403 with the remaining-quota header at 0), a temporary server error (500/502/503/504), or a network timeout.
- Never retry a real answer: 404, 401/403 for permissions, or anything successful.
- Up to 3 retries, waiting roughly 0.5s, 1s, 2s, each with a small random jitter so parallel requests don't all wake up at once.
- When GitHub tells us exactly when quota resets (`retry-after` or the reset header), honour that instead of the fixed wait, capped at 10 seconds so a run can never stall.
- Total time spent waiting across the whole scan is capped (about 20 seconds) so a throttled run degrades gracefully rather than hitting the CI timeout.

### 2. Honest health reporting
Only the final attempt counts as the request outcome, so the health banner does not inflate its request count. The scan health summary gains a retry count, so a run that succeeded after backoff still reads "complete" but shows how much retrying it took, and a run that exhausted retries still reads "rate-limited".

### 3. Test coverage
The end-to-end test asserts the new retry counter is present and consistent (retries never exceed total requests) and continues to pass when no throttling occurs.

## CI artifact upload
The workflow already uploads the scan report only when the test step fails (`if: failure()`), and the test only writes the report inside its failure path. No change needed; I will re-verify a passing run leaves no artifact behind.

## Technical notes
- Retry logic lives in the `raw()` helper inside `src/lib/detectors/github.ts`, so every call site inherits it with no changes.
- `src/lib/detectors/health.ts` gains a `retries` counter recorded by the client; status thresholds stay as they are.
- Website scanning is untouched.
