import type { Signal, SignalCategory } from "./signals";

export interface SignalRule {
  id: string;
  category: SignalCategory;
  label: string;
  weight: number;
  match: (text: string, source: string) => string | null;
}

export function runSignalRules(text: string, source: string, rules: SignalRule[]): Signal[] {
  const signals: Signal[] = [];
  for (const rule of rules) {
    const evidence = rule.match(text, source);
    if (!evidence) continue;
    signals.push({
      id: rule.id,
      category: rule.category,
      label: rule.label,
      weight: rule.weight,
      evidence,
    });
  }
  return signals;
}
