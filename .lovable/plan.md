# Make the vibe / AI detection actually work

The scanner currently only looks at the surface of a project, so most real repos and sites come back with one or two weak signals. This plan rebuilds the detection core so both scores reflect real evidence.

## What's wrong today

Confirmed by reading the detectors:

- **Only the repo root is inspected.** `analyzeGithub` lists `/contents` (root only) and scans at most 3 root-level `.css/.scss/.html` files. Real projects keep everything in `src/`, so the Tailwind, design-token and component-convention signals almost never fire.
- **"Initial commit" is wrong.** It fetches the newest 100 commits and treats the last item in that page as the first commit. For any repo with more than 100 commits that check is meaningless.
- **No source-code prose analysis.** Tutorial-voice detection runs on the README only, never on code comments — one of the strongest AI tells.
- **Slow, serial probing.** Eight separate HTTP requests just to look for AI config files, plus one request per file, all sequential.
- **Scores are a raw sum clipped at 100.** A repo either saturates or stays near zero; there is no notion of "how much of the possible evidence did we actually find".
- **Website analysis is thin.** It parses the raw HTML and 2 stylesheets. Modern SPA shells are nearly empty HTML, so nothing fires; JS bundles and generator/deploy fingerprints are never checked.

## What changes

### 1. Whole-repo structure scan
Replace the root-only listing with one recursive git-tree call (`/git/trees/{branch}?recursive=1`). From that single response derive:
- Framework/tooling files anywhere in the tree (tailwind config, `components.json`, vite config, `src/index.css`/`src/styles.css`).
- shadcn/ui convention: presence and count of `components/ui/*.tsx` files.
- AI config files anywhere in the tree (no more 8 blind probes).
- File-count and directory-shape stats used for the "single-shot scaffold" heuristic.

### 2. Real content sampling
Fetch a bounded set of the most informative files in parallel (package.json, the main CSS entry, `components.json`, 3-5 representative `.tsx` files, README) via the raw contents API, and run detectors over all of them:
- Tailwind utility density and arbitrary-value usage.
- Design-token custom properties + HSL token pattern.
- Code-comment analysis: tutorial voice, restating-the-obvious comments, over-explained JSX section banners, `// TODO: implement` placeholders.

### 3. Fix the commit-history signals
- Get the true first commit by following the `Link: rel="last"` header on `commits?per_page=1`.
- Add: burst pattern (many commits in a very short window), generic commit messages ("Update files", "fix", "changes"), AI-tool keywords, bot/co-authored-by trailers (`Co-Authored-By: Claude`, `lovable-dev[bot]`).
- Add repo-age vs. code-volume ratio (large codebase, very few commits, very short history).

### 4. Real scoring model
Move from "sum and clip" to normalized, category-weighted scoring:
- Each signal declares a weight and the maximum weight it could have contributed.
- Score = achieved / achievable within a category, scaled to 0-100, with diminishing returns so no single signal dominates.
- Coverage is tracked explicitly: if too few sources were readable, the result is reported as "insufficient evidence" instead of a misleading low score.
- Confidence is derived from coverage + signal count + distance from the bucket boundary (existing tunable thresholds on `/test` keep working unchanged).

### 5. Stronger website analysis
- Follow redirects, accept the rendered HTML shell, and additionally fetch up to 2 JS bundles referenced by the page.
- Detect: Tailwind's compiled class fingerprints in CSS, design-token variables, shadcn/radix runtime markers (`data-radix-*`, `data-slot`), Lovable/Vercel/Netlify/Framer/Bolt generator and header fingerprints, `lovable-tagger` artifacts, and AI-ish meta/generator tags.
- Fall back gracefully with a clear reason when a site blocks the fetch, instead of a silent zero.

### 6. Keep the existing surfaces working
`/scan` and `/test` consume `AnalysisResult`; the shape stays the same (new optional fields only), so gauges, evidence lists, breakdowns, filters, presets and thresholds continue to work. Sample expectations in `src/lib/test-samples.ts` are re-checked against the new scoring and adjusted where the old numbers were artifacts of the broken heuristics.

## Technical notes

- Files touched: `src/lib/detectors/github.ts`, `website.ts`, `signals.ts`, `rule-catalog.ts`, `rule-engine.ts`, plus a new `scoring.ts`, and small updates to `test-samples.ts`.
- All GitHub access stays on the existing connector gateway with the current env keys; request budget per scan is capped (~15 requests, parallelized) to stay well inside rate limits.
- Every fetch keeps a timeout and byte cap; failures degrade to a coverage penalty rather than an error.
- Verification: type-check, then run `/test` in a headless browser and confirm the sample repos land in their expected buckets with visible evidence in the "why?" breakdown.
