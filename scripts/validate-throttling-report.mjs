import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

export const REPORT_SCHEMA_VERSION = 1;
const schema = JSON.parse(
  await readFile(new URL("../schemas/e2e-throttling-v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: true, formats: { "date-time": true } });
const validate = ajv.compile(schema);

export function validateThrottlingReport(report) {
  if (report?.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported throttling report schema version ${String(report?.schemaVersion)}; expected ${REPORT_SCHEMA_VERSION}`,
    );
  }
  if (!validate(report)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid throttling report: ${details}`);
  }
  if (report.requests.retries !== report.throttling.retries) {
    throw new Error("Invalid throttling report: request and throttling retry counts differ");
  }
  if (JSON.stringify(report.retryLog) !== JSON.stringify(report.throttling.events)) {
    throw new Error("Invalid throttling report: retryLog and throttling.events differ");
  }
  return report;
}

const columns = [
  "schema_version",
  "generated_at",
  "target",
  "status",
  "label",
  "duration_ms",
  "requests_total",
  "requests_ok",
  "requests_blocked",
  "requests_rate_limited",
  "requests_timed_out",
  "retry_count",
  "retries_rate_limited",
  "retries_server_error",
  "retries_timeout",
  "waited_ms",
  "longest_wait_ms",
  "server_hinted_waits",
  "budget_exhausted",
  "event_index",
  "event_at",
  "event_path",
  "event_attempt",
  "event_type",
  "event_reason",
  "event_status",
  "event_hinted_ms",
  "event_server_hinted",
  "event_wait_ms",
  "event_budget_spent_ms"
];

const csvCell = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function throttlingReportToCsv(input) {
  const report = validateThrottlingReport(input);
  const events = report.retryLog.length > 0 ? report.retryLog : [null];
  const rows = events.map((event, index) => [
    report.schemaVersion,
    report.generatedAt,
    report.target,
    report.status,
    report.label,
    report.durationMs,
    report.requests.total,
    report.requests.ok,
    report.requests.blocked,
    report.requests.rateLimited,
    report.requests.timedOut,
    report.throttling.retries,
    report.throttling.retriesByReason["rate-limited"],
    report.throttling.retriesByReason["server-error"],
    report.throttling.retriesByReason.timeout,
    report.throttling.waitedMs,
    report.throttling.longestWaitMs,
    report.throttling.serverHintedWaits,
    report.throttling.budgetExhausted,
    event ? index + 1 : null,
    event?.at,
    event?.path,
    event?.attempt,
    event?.type,
    event?.reason,
    event?.status,
    event?.hintedMs,
    event?.serverHinted,
    event?.waitMs,
    event?.budgetSpentMs,
  ]);
  return `${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export async function validateAndExport(inputPath, outputPath) {
  const report = JSON.parse(await readFile(inputPath, "utf8"));
  const csv = throttlingReportToCsv(report);
  await writeFile(outputPath, csv);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2] ?? "test-results/e2e-throttling.json";
  const output = process.argv[3] ?? "test-results/e2e-throttling.csv";
  try {
    const report = await validateAndExport(input, output);
    console.log(
      `Validated throttling report schema v${report.schemaVersion}; CSV written to ${output}`,
    );
  } catch (error) {
    console.error(`::error title=Invalid E2E throttling report::${error.message}`);
    process.exit(1);
  }
}