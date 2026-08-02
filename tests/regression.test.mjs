import assert from "node:assert/strict";
import test from "node:test";

import { runRegressionSuite } from "../src/lib/regression-suite.ts";

test("deterministic regression suite stays green", () => {
  const results = runRegressionSuite();
  assert.ok(results.length > 0, "expected at least one regression case");

  for (const result of results) {
    assert.equal(
      result.vibePass,
      true,
      `${result.label} expected vibe ${result.expectedVibe} but got ${result.vibeScore} (${result.vibeBucket})`,
    );
    assert.equal(
      result.aiPass,
      true,
      `${result.label} expected AI ${result.expectedAi} but got ${result.aiScore} (${result.aiBucket})`,
    );
  }
});
