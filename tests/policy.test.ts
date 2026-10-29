import { describe, expect, it } from "vitest";
import {
  createGrowthHistory,
  DEFAULT_END_OF_TURN_MIN_TOKENS,
  DEFAULT_END_OF_TURN_THRESHOLD,
  DEFAULT_TARGET_PERCENT,
  DEFAULT_TARGET_TOKENS,
  estimateNextTurnGrowth,
  observeTokens,
  parseEndOfTurnThreshold,
  shouldAutoCompact,
  shouldCompactAtEndOfTurn,
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

describe("end-of-turn threshold", () => {
  it("parses absolute tokens, percentages, and off", () => {
    expect(parseEndOfTurnThreshold("120000")).toEqual({ unit: "tokens", value: 120_000 });
    expect(parseEndOfTurnThreshold("75.5%")).toEqual({ unit: "percent", value: 75.5 });
    expect(parseEndOfTurnThreshold("off")).toBeNull();
  });

  it("rejects invalid thresholds", () => {
    expect(parseEndOfTurnThreshold("0")).toBeUndefined();
    expect(parseEndOfTurnThreshold("101%")).toBeUndefined();
    expect(parseEndOfTurnThreshold("9007199254740992")).toBeUndefined();
    expect(parseEndOfTurnThreshold("75 %")).toBeUndefined();
  });

  it("checks absolute and percentage thresholds against completed context", () => {
    expect(shouldCompactAtEndOfTurn(80_000, 100_000, { unit: "tokens", value: 80_000 })).toBe(true);
    expect(shouldCompactAtEndOfTurn(79_999, 100_000, { unit: "tokens", value: 80_000 })).toBe(false);
    expect(shouldCompactAtEndOfTurn(75_500, 100_000, { unit: "percent", value: 75.5 })).toBe(true);
    expect(shouldCompactAtEndOfTurn(75_499, 100_000, { unit: "percent", value: 75.5 })).toBe(false);
    expect(shouldCompactAtEndOfTurn(199_999, 400_000, DEFAULT_END_OF_TURN_THRESHOLD, DEFAULT_END_OF_TURN_MIN_TOKENS)).toBe(false);
    expect(shouldCompactAtEndOfTurn(200_000, 400_000, DEFAULT_END_OF_TURN_THRESHOLD, DEFAULT_END_OF_TURN_MIN_TOKENS)).toBe(true);
    expect(shouldCompactAtEndOfTurn(399_999, 1_000_000, DEFAULT_END_OF_TURN_THRESHOLD, DEFAULT_END_OF_TURN_MIN_TOKENS)).toBe(false);
    expect(shouldCompactAtEndOfTurn(400_000, 1_000_000, DEFAULT_END_OF_TURN_THRESHOLD, DEFAULT_END_OF_TURN_MIN_TOKENS)).toBe(true);
    expect(shouldCompactAtEndOfTurn(90_000, 100_000, null)).toBe(false);
  });
});

describe("adaptive compaction threshold", () => {
  it("uses a custom percentage target under the 230K token ceiling", () => {
    expect(
      shouldAutoCompact({ tokens: 80_000, contextWindow: 100_000, policy, targetPercent: 80, predictedGrowth: 0 }),
    ).toBe(true);
    expect(
      shouldAutoCompact({ tokens: 79_999, contextWindow: 100_000, policy, targetPercent: 80, predictedGrowth: 0 }),
    ).toBe(false);
  });

  it("defaults to the lower of 50% of the window and 230K tokens", () => {
    expect(DEFAULT_TARGET_PERCENT).toBe(50);
    expect(DEFAULT_TARGET_TOKENS).toBe(230_000);
    expect(shouldAutoCompact({ tokens: 49_999, contextWindow: 100_000, policy, predictedGrowth: 0 })).toBe(false);
    expect(shouldAutoCompact({ tokens: 50_000, contextWindow: 100_000, policy, predictedGrowth: 0 })).toBe(true);
    expect(shouldAutoCompact({ tokens: 229_999, contextWindow: 1_000_000, policy, predictedGrowth: 0 })).toBe(false);
    expect(shouldAutoCompact({ tokens: 230_000, contextWindow: 1_000_000, policy, predictedGrowth: 0 })).toBe(true);
  });

  it("preempts the native threshold when recent growth predicts crossing the target", () => {
    expect(
      shouldAutoCompact({ tokens: 45_000, contextWindow: 100_000, policy, predictedGrowth: 5_000 }),
    ).toBe(true);
  });

  it("leaves an already-crossed native threshold to Pi", () => {
    expect(
      shouldAutoCompact({ tokens: 83_616, contextWindow: 100_000, policy, predictedGrowth: 0 }),
    ).toBe(false);
  });

  it("honors Pi's per-model reserve by capping the target", () => {
    const modelPolicy = { ...policy, reserveTokens: 60_000 };
    expect(
      shouldAutoCompact({
        tokens: 39_000,
        contextWindow: 100_000,
        policy: modelPolicy,
        predictedGrowth: 0,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompact({
        tokens: 39_000,
        contextWindow: 100_000,
        policy: modelPolicy,
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
