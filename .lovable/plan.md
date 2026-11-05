# AI scan explanations and retry diagnostics

## What will change

- Add an AI explanation action to scan results, grounded only in the analyzer's scores, confidence, evidence signals, source references, and coverage notes. Present the explanation and uncertainty without changing heuristic scores.
- Add a focused retry-diagnostics page where developers paste a retry timeline or E2E report JSON. Validate and bound the input, then return likely causes of repeated throttling and concrete retry-configuration suggestions.
- Add a typed GitHub access mode to scan results (authenticated connector or anonymous public API), including an explicit anonymous-rate-limit warning and clear status after credential fallback.
- Keep both AI Gateway requests server-side, validate inputs, handle final gateway failures clearly, and avoid sending secrets or unrelated source content to the model.

## Validation

- Add focused offline tests for GitHub access-mode labeling and pasted retry-report validation; type-check and run the project test suites.
- Verify an existing scan can request and display an AI explanation, and the retry diagnostics page accepts valid JSON while rejecting malformed input.
- Check the preview build and route metadata after implementation.

## Technical details

- Use the installed `@lovable.dev/ai-gateway` SDK and the workspace-resolved text model/surface; generate and inspect model-specific types before writing calls.
- Implement server-side AI operations in `*.functions.ts`; preserve existing retry/scan behavior and current score computation.
