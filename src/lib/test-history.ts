import { format } from "date-fns";
import type { RegressionCaseResult } from "./regression-suite.ts";

const TEST_HISTORY_KEY = "vibe-detector:test-history";
const TEST_HISTORY_LIMIT = 12;

export interface TestRunCaseSnapshot {
  id: string;
  label: string;
  vibeScore: number;
  aiScore: number;
  vibeBucket: RegressionCaseResult["vibeBucket"];
  aiBucket: RegressionCaseResult["aiBucket"];
  vibePass: boolean;
  aiPass: boolean;
}

export interface TestRunSnapshot {
  id: string;
  createdAt: string;
  signature: string;
  totalCases: number;
  vibePassCount: number;
  aiPassCount: number;
  overallPassRate: number;
  cases: TestRunCaseSnapshot[];
}

export function createTestRunSnapshot(results: RegressionCaseResult[]): TestRunSnapshot {
  const cases = results.map((result) => ({
    id: result.id,
    label: result.label,
    vibeScore: result.vibeScore,
    aiScore: result.aiScore,
    vibeBucket: result.vibeBucket,
    aiBucket: result.aiBucket,
    vibePass: result.vibePass,
    aiPass: result.aiPass,
  }));
  const vibePassCount = cases.filter((entry) => entry.vibePass).length;
  const aiPassCount = cases.filter((entry) => entry.aiPass).length;
  return {
    id: makeSnapshotId(),
    createdAt: new Date().toISOString(),
    signature: buildSignature(cases),
    totalCases: cases.length,
    vibePassCount,
    aiPassCount,
    overallPassRate:
      cases.length === 0
        ? 0
        : Math.round(((vibePassCount + aiPassCount) / (cases.length * 2)) * 100),
    cases,
  };
}

export function readTestRunHistory(): TestRunSnapshot[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(TEST_HISTORY_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as TestRunSnapshot[];
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isValidSnapshot);
  } catch {
    return [];
  }
}

export function writeTestRunHistory(nextRun: TestRunSnapshot): TestRunSnapshot[] {
  if (typeof window === "undefined") return [nextRun];

  const currentHistory = readTestRunHistory();
  const latest = currentHistory[0];

  if (latest?.signature === nextRun.signature) {
    return currentHistory;
  }

  const nextHistory = [nextRun, ...currentHistory].slice(0, TEST_HISTORY_LIMIT);
  window.localStorage.setItem(TEST_HISTORY_KEY, JSON.stringify(nextHistory));
  return nextHistory;
}

export function formatTestRunDate(timestamp: string): string {
  return format(new Date(timestamp), "MMM d, yyyy h:mm a");
}

export function getSnapshotDelta(current: TestRunSnapshot, previous?: TestRunSnapshot | null) {
  if (!previous) {
    return {
      vibePassDelta: current.vibePassCount,
      aiPassDelta: current.aiPassCount,
      overallPassDelta: current.overallPassRate,
      changedCases: current.cases.map((entry) => ({
        id: entry.id,
        label: entry.label,
        vibeDelta: entry.vibeScore,
        aiDelta: entry.aiScore,
      })),
    };
  }

  const previousById = new Map(previous.cases.map((entry) => [entry.id, entry]));
  const changedCases = current.cases
    .map((entry) => {
      const before = previousById.get(entry.id);
      if (!before) {
        return {
          id: entry.id,
          label: entry.label,
          vibeDelta: entry.vibeScore,
          aiDelta: entry.aiScore,
        };
      }

      const vibeDelta = entry.vibeScore - before.vibeScore;
      const aiDelta = entry.aiScore - before.aiScore;
      if (vibeDelta === 0 && aiDelta === 0) return null;

      return {
        id: entry.id,
        label: entry.label,
        vibeDelta,
        aiDelta,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    vibePassDelta: current.vibePassCount - previous.vibePassCount,
    aiPassDelta: current.aiPassCount - previous.aiPassCount,
    overallPassDelta: current.overallPassRate - previous.overallPassRate,
    changedCases,
  };
}

function buildSignature(cases: TestRunCaseSnapshot[]): string {
  return JSON.stringify(
    cases.map(({ id, vibeScore, aiScore, vibeBucket, aiBucket, vibePass, aiPass }) => ({
      id,
      vibeScore,
      aiScore,
      vibeBucket,
      aiBucket,
      vibePass,
      aiPass,
    })),
  );
}

function makeSnapshotId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isValidSnapshot(value: unknown): value is TestRunSnapshot {
  if (!value || typeof value !== "object") return false;

  const snapshot = value as TestRunSnapshot;
  return (
    typeof snapshot.id === "string" &&
    typeof snapshot.createdAt === "string" &&
    typeof snapshot.signature === "string" &&
    typeof snapshot.totalCases === "number" &&
    typeof snapshot.vibePassCount === "number" &&
    typeof snapshot.aiPassCount === "number" &&
    typeof snapshot.overallPassRate === "number" &&
    Array.isArray(snapshot.cases)
  );
}
