# Versioned retry-report validation and CSV export

## What will change

- Add a versioned JSON Schema for the always-written E2E throttling report. The report will declare its schema version, and retry events will be validated field-by-field so incompatible changes fail visibly.
- Add a validation/export script that reads the report, validates it against the schema, and fails on missing or invalid per-scan retry totals, including retry counts, total wait time, and longest wait.
- Export a spreadsheet-friendly CSV from the validated report. It will include one row per retry event while repeating the scan-level request and throttling totals; scans with no retries will still produce one summary row.
- Run validation and CSV export in GitHub Actions after the E2E test, while preserving the existing missing-secret self-skip behavior.
- Include the CSV beside the JSON files in the failure-only diagnostic artifact.

## Tests and verification

- Add offline tests for valid reports, missing required retry fields, malformed/version-mismatched retry events, CSV escaping, and zero-retry scans.
- Run the focused unit tests and exercise the scripts with generated fixtures.

## Technical details

- Store the schema as a committed JSON Schema with an explicit version identifier and reject unknown versions.
- Make required retry values non-negative numbers/integers and require all reason counters and event fields.
- Keep artifact generation deterministic and avoid adding runtime application dependencies.
