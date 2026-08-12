export interface StoredPreset {
  id: string;
  name: string;
  thresholds: { lowMax: number; mediumMax: number };
  confidenceRules: { minSignals: number; boundaryWindow: number };
}

const CUSTOM_PRESETS_KEY = "vibe-detector:test-custom-presets";

export function readCustomPresets(): StoredPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPreset[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPreset);
  } catch {
    return [];
  }
}

export function writeCustomPresets(presets: StoredPreset[]): StoredPreset[] {
  if (typeof window === "undefined") return presets;
  window.localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  return presets;
}

export function makePresetId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isValidPreset(value: unknown): value is StoredPreset {
  if (!value || typeof value !== "object") return false;
  const preset = value as StoredPreset;
  return (
    typeof preset.id === "string" &&
    typeof preset.name === "string" &&
    !!preset.thresholds &&
    typeof preset.thresholds.lowMax === "number" &&
    typeof preset.thresholds.mediumMax === "number" &&
    !!preset.confidenceRules &&
    typeof preset.confidenceRules.minSignals === "number" &&
    typeof preset.confidenceRules.boundaryWindow === "number"
  );
}
