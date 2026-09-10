/**
 * Turn the E2E throttling snapshot into a GitHub Actions step summary so a
 * flaky (slow, retried, throttled) run is visible without downloading the
 * failure artifact.
 */
import { appendFile, readFile } from "node:fs/promises";

const IN = process.env["THROTTLING_JSON"] ?? "test-results/e2e-throttling.json";
const OUT = process.env["GITHUB_STEP_SUMMARY"];

const raw = await readFile(IN, "utf8").catch(() => null);
if (raw === null) {
  console.log(`No throttling snapshot at ${IN} (scan did not run).`);
  process.exit(0);
}

const data = JSON.parse(raw);
const r = data.requests ?? { total: 0, ok: 0, rateLimited: 0, timedOut: 0, blocked: 0, retries: 0 };
const t = data.throttling ?? {
  retries: 0,
  retriesByReason: { "rate-limited": 0, "server-error": 0, timeout: 0 },
  waitedMs: 0,
  longestWaitMs: 0,
  serverHintedWaits: 0,
  budgetExhausted: 0,
};
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const flaky = t.retries > 0 || r.timedOut > 0 || r.rateLimited > 0 || t.budgetExhausted > 0;

const lines = [
  `### ${flaky ? ":warning: Scan throttling (possible flake)" : "Scan throttling"} — ${data.label ?? data.status} (${secs(data.durationMs ?? 0)})`,
  "",
  "| Requests | OK | Blocked | Rate limited | Timed out | Retries | Waited | Longest wait |",
  "|---------:|---:|--------:|-------------:|----------:|--------:|-------:|-------------:|",
  `| ${r.total} | ${r.ok} | ${r.blocked} | ${r.rateLimited} | ${r.timedOut} | ${t.retries} | ${secs(t.waitedMs)} | ${secs(t.longestWaitMs)} |`,
  "",
  `Retries by reason: rate-limited ${t.retriesByReason["rate-limited"]}, server-error ${t.retriesByReason["server-error"]}, timeout ${t.retriesByReason.timeout}. ` +
    `Server-hinted waits: ${t.serverHintedWaits}. Wait budget exhausted: ${t.budgetExhausted}.`,
];

const log = data.retryLog ?? [];
if (log.length > 0) {
  lines.push("", "<details><summary>Retry log</summary>", "");
  lines.push("| # | Path | Attempt | Reason | Status | Hinted | Wait |");
  lines.push("|--:|------|--------:|--------|-------:|-------:|-----:|");
  log.slice(0, 50).forEach((e, i) => {
    lines.push(
      `| ${i + 1} | \`${e.path ?? "-"}\` | ${e.attempt} | ${e.type === "budget-exhausted" ? "budget exhausted" : e.reason} | ${e.status ?? "-"} | ${e.serverHinted ? "yes" : "no"} | ${secs(e.waitMs)} |`,
    );
  });
  if (log.length > 50) lines.push("", `_…and ${log.length - 50} more events (see the artifact)._`);
  lines.push("", "</details>");
}

const text = `${lines.join("\n")}\n`;
if (OUT) await appendFile(OUT, `\n${text}`);
console.log(text);
if (flaky) console.log(`::warning title=Scan throttling::${t.retries} retries, ${r.rateLimited} rate-limited, ${r.timedOut} timed out.`);
