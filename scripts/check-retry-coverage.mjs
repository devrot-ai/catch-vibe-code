/**
 * Coverage gate for the retry logic.
 *
 * Reads the lcov file produced by `bun test --coverage --coverage-reporter=lcov`
 * and fails when the retry module drops below the configured thresholds, so a
 * regression that removes or bypasses retry behaviour cannot pass CI.
 *
 * Thresholds can be overridden with RETRY_COVERAGE_LINES / RETRY_COVERAGE_FUNCS
 * (percentages, 0-100).
 */
import { readFile } from "node:fs/promises";

const LCOV_PATH = process.env["RETRY_COVERAGE_LCOV"] ?? "coverage/lcov.info";
const TARGET = "src/lib/detectors/retry.ts";
const MIN_LINES = Number(process.env["RETRY_COVERAGE_LINES"] ?? 90);
const MIN_FUNCS = Number(process.env["RETRY_COVERAGE_FUNCS"] ?? 90);

function parseLcov(text) {
  const records = [];
  let current = null;
  for (const line of text.split("\n")) {
    const [tag, value] = line.split(":");
    if (tag === "SF") current = { file: value.trim(), lf: 0, lh: 0, fnf: 0, fnh: 0 };
    else if (!current) continue;
    else if (tag === "LF") current.lf = Number(value);
    else if (tag === "LH") current.lh = Number(value);
    else if (tag === "FNF") current.fnf = Number(value);
    else if (tag === "FNH") current.fnh = Number(value);
    else if (line.trim() === "end_of_record") {
      records.push(current);
      current = null;
    }
  }
  return records;
}

const text = await readFile(LCOV_PATH, "utf8").catch(() => null);
if (text === null) {
  console.error(`Retry coverage check failed: no coverage file at ${LCOV_PATH}`);
  process.exit(1);
}

const record = parseLcov(text).find((r) => r.file.replaceAll("\\", "/").endsWith(TARGET));
if (!record) {
  console.error(`Retry coverage check failed: ${TARGET} is not in ${LCOV_PATH}`);
  process.exit(1);
}

const pct = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);
const lines = pct(record.lh, record.lf);
const funcs = pct(record.fnh, record.fnf);
const fmt = (n) => `${n.toFixed(1)}%`;
const summary = `${TARGET}: lines ${fmt(lines)} (min ${MIN_LINES}%), functions ${fmt(funcs)} (min ${MIN_FUNCS}%)`;

if (process.env["GITHUB_STEP_SUMMARY"]) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env["GITHUB_STEP_SUMMARY"], `\n**Retry coverage** — ${summary}\n`);
}

if (lines < MIN_LINES || funcs < MIN_FUNCS) {
  console.error(`::error title=Retry coverage below threshold::${summary}`);
  process.exit(1);
}
console.log(`Retry coverage OK — ${summary}`);
