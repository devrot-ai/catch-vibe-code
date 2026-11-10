import { z } from "zod";

const MAX_RETRY_EVENTS = 500;
const MAX_RETRY_REPORT_CHARS = 120_000;

const retryEventSchema = z.object({
  at: z.string().max(80),
  path: z.string().max(1_000).nullable(),
  attempt: z.number().int().min(0).max(100_000),
  type: z.enum(["retry", "budget-exhausted"]),
  reason: z.enum(["rate-limited", "server-error", "timeout"]),
  status: z.number().int().min(100).max(599).nullable(),
  hintedMs: z.number().min(0).max(1_000_000_000).nullable(),
  serverHinted: z.boolean(),
  waitMs: z.number().min(0).max(1_000_000_000),
  budgetSpentMs: z.number().min(0).max(1_000_000_000),
  completedAt: z.string().max(80),
  nextAttempt: z.number().int().min(0).max(100_000).nullable(),
  outcome: z.enum(["recovered", "retrying", "failed", "budget-exhausted"]),
  outcomeStatus: z.number().int().min(100).max(599).nullable(),
});

const scanExplanationInput = z.object({
  target: z.string().min(1).max(500),
  kind: z.enum(["github", "website"]),
  vibeScore: z.number().min(0).max(100),
  aiScore: z.number().min(0).max(100),
  confidence: z.object({
    vibe: z.object({ level: z.enum(["low", "medium", "high"]), detail: z.string().max(300) }),
    ai: z.object({ level: z.enum(["low", "medium", "high"]), detail: z.string().max(300) }),
  }),
  signals: z.array(z.object({
    category: z.enum(["vibe", "ai"]),
    label: z.string().max(200),
    weight: z.number().min(0).max(100),
    evidence: z.string().max(800),
    sourceRef: z.string().max(300).optional(),
  })).max(60),
  coverage: z.object({
    sourcesRead: z.number().int().min(0),
    sourcesAttempted: z.number().int().min(0),
    notes: z.array(z.string().max(400)).max(30),
  }).optional(),
});

export type ScanExplanationInput = z.infer<typeof scanExplanationInput>;

export function validateScanExplanationInput(input: unknown): ScanExplanationInput {
  return scanExplanationInput.parse(input);
}

export type RetryTimelineSummary = {
  events: z.infer<typeof retryEventSchema>[];
  retries: number;
  budgetExhausted: number;
  waitedMs: number;
  longestWaitMs: number;
  serverHintedWaits: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRetryTimeline(rawText: string): RetryTimelineSummary {
  if (rawText.length === 0 || rawText.length > MAX_RETRY_REPORT_CHARS) {
    throw new Error("Paste a JSON timeline or report under 120,000 characters.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("That isn’t valid JSON. Paste a retry timeline or E2E report JSON.");
  }

  let source: unknown;
  if (Array.isArray(parsed)) {
    source = parsed;
  } else if (isRecord(parsed)) {
    const candidates = [parsed.retryTimeline, parsed.retryLog];
    const throttling = isRecord(parsed.throttling) ? parsed.throttling : null;
    if (throttling) candidates.push(throttling.events);
    const present = candidates.filter((candidate) => candidate !== undefined);
    if (present.length > 1 && present.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(present[0]))) {
      throw new Error("The report’s retry timeline fields don’t match each other.");
    }
    source = present[0];
  }

  const events = z.array(retryEventSchema).max(MAX_RETRY_EVENTS).safeParse(source);
  if (!events.success) {
    throw new Error("The JSON must contain a retry timeline with valid event fields (up to 500 events).");
  }

  let previousAt = Number.NEGATIVE_INFINITY;
  for (const event of events.data) {
    const at = Date.parse(event.at);
    const completedAt = Date.parse(event.completedAt);
    if (!Number.isFinite(at) || !Number.isFinite(completedAt) || at < previousAt || completedAt < at) {
      throw new Error("Retry events need valid timestamps in chronological order.");
    }
    previousAt = at;
  }

  const retries = events.data.filter((event) => event.type === "retry");
  return {
    events: events.data,
    retries: retries.length,
    budgetExhausted: events.data.filter((event) => event.outcome === "budget-exhausted").length,
    waitedMs: retries.reduce((sum, event) => sum + event.waitMs, 0),
    longestWaitMs: Math.max(0, ...retries.map((event) => event.waitMs)),
    serverHintedWaits: retries.filter((event) => event.serverHinted).length,
  };
}