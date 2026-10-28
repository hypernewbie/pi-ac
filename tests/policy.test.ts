import { describe, expect, it } from "vitest";
import {
  createGrowthHistory,
  estimateNextTurnGrowth,
  observeTokens,
  shouldAutoCompact,
} from "../src/policy.ts";

const policy = { enabled: true, reserveTokens: 16_384 };

describe("turn-growth forecast", () => {
  it("records only positive context growth", () => {
    const history = createGrowthHistory();
    observeTokens(history, 20_000);
    observeTokens(history, 30_000);
    observeTokens(history, 28_000);
    observeTokens(history, 40_000);
    expect(history.deltas).toEqual([10_000, 12_000]);
  });

  it("uses a conservative high-percentile estimate", () => {
    const history = createGrowthHistory();
    history.deltas = [2_000, 5_000, 8_000, 11_000, 50_000];
    expect(estimateNextTurnGrowth(history)).toBe(50_000);
  });

  it("keeps only the latest five growth samples", () => {
    const history = createGrowthHistory();
    for (let i = 0; i < 8; i++) observeTokens(history, i * 10_000);
    expect(history.deltas).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
  });
});

describe("adaptive compaction threshold", () => {
  it("uses the configured target as the earlier threshold", () => {
    expect(
      shouldAutoCompact({ tokens: 80_000, contextWindow: 100_000, policy, predictedGrowth: 0 }),
    ).toBe(true);
    expect(
      shouldAutoCompact({ tokens: 79_999, contextWindow: 100_000, policy, predictedGrowth: 0 }),
    ).toBe(false);
  });

  it("preempts the native threshold when recent growth predicts crossing it", () => {
    expect(
      shouldAutoCompact({ tokens: 70_000, contextWindow: 100_000, policy, predictedGrowth: 20_000 }),
    ).toBe(true);
  });

  it("leaves an already-crossed native threshold to Pi", () => {
    expect(
      shouldAutoCompact({ tokens: 83_616, contextWindow: 100_000, policy, predictedGrowth: 0 }),
    ).toBe(false);
  });

  it("honors Pi's per-model reserve by capping the target", () => {
    expect(
      shouldAutoCompact({
        tokens: 70_000,
        contextWindow: 100_000,
        policy: { ...policy, reserveTokens: 30_000 },
        predictedGrowth: 0,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompact({
        tokens: 69_000,
        contextWindow: 100_000,
        policy: { ...policy, reserveTokens: 30_000 },
        predictedGrowth: 1_000,
      }),
    ).toBe(true);
  });

  it("respects Pi's disabled auto-compaction setting", () => {
    expect(
      shouldAutoCompact({ tokens: 90_000, contextWindow: 100_000, policy: { ...policy, enabled: false }, predictedGrowth: 0 }),
    ).toBe(false);
  });

  it("rejects invalid policy percentages and missing measurements", () => {
    expect(
      shouldAutoCompact({ tokens: 90_000, contextWindow: 100_000, policy, targetPercent: 0, predictedGrowth: 0 }),
    ).toBe(false);
    expect(
      shouldAutoCompact({ tokens: Number.NaN, contextWindow: 100_000, policy, predictedGrowth: 0 }),
    ).toBe(false);
    expect(
      shouldAutoCompact({ tokens: 90_000, contextWindow: 0, policy, predictedGrowth: 0 }),
    ).toBe(false);
    expect(
      shouldAutoCompact({ tokens: 90_000, contextWindow: 100_000, policy: { ...policy, reserveTokens: Number.NaN }, predictedGrowth: 0 }),
    ).toBe(false);
  });
});
