export interface GrowthHistory {
  previousTokens: number | null;
  deltas: number[];
}

export interface CompactionPolicy {
  enabled: boolean;
  reserveTokens: number;
}

export type EndOfTurnThreshold =
  | { unit: "tokens"; value: number }
  | { unit: "percent"; value: number };

export const DEFAULT_TARGET_PERCENT = 50;
export const DEFAULT_TARGET_TOKENS = 230_000;
export const DEFAULT_END_OF_TURN_THRESHOLD: EndOfTurnThreshold = { unit: "percent", value: 40 };
export const DEFAULT_END_OF_TURN_MIN_TOKENS = 200_000;
export const DEFAULT_END_OF_TURN_DELAY_MINUTES = 10;
const MAX_GROWTH_SAMPLES = 5;

export function createGrowthHistory(): GrowthHistory {
  return { previousTokens: null, deltas: [] };
}

export function observeTokens(history: GrowthHistory, tokens: number): void {
  if (!Number.isFinite(tokens)) return;
  if (history.previousTokens !== null && tokens > history.previousTokens) {
    history.deltas.push(tokens - history.previousTokens);
    if (history.deltas.length > MAX_GROWTH_SAMPLES) history.deltas.shift();
  }
  history.previousTokens = tokens;
}

/** Conservative estimate of context growth in one more completed turn. */
export function estimateNextTurnGrowth(history: GrowthHistory): number {
  if (history.deltas.length === 0) return 0;
  const sorted = [...history.deltas].sort((a, b) => a - b);
  const p90Index = Math.ceil(sorted.length * 0.9) - 1;
  return sorted[Math.max(0, p90Index)] ?? 0;
}

/** Parse an end-of-turn token or percentage threshold. Undefined means invalid; null means off. */
export function parseEndOfTurnThreshold(value: string): EndOfTurnThreshold | null | undefined {
  const input = value.trim().toLowerCase();
  if (input === "off") return null;

  if (/^\d+$/.test(input)) {
    const tokens = Number(input);
    return Number.isSafeInteger(tokens) && tokens > 0 ? { unit: "tokens", value: tokens } : undefined;
  }

  const percentMatch = /^(\d+(?:\.\d+)?)%$/.exec(input);
  if (percentMatch) {
    const percent = Number(percentMatch[1]);
    return Number.isFinite(percent) && percent > 0 && percent <= 100
      ? { unit: "percent", value: percent }
      : undefined;
  }

  return undefined;
}

/** Whether completed context has reached an independent end-of-turn threshold. */
export function shouldCompactAtEndOfTurn(
  tokens: number,
  contextWindow: number,
  threshold: EndOfTurnThreshold | null,
  minTokens?: number,
): boolean {
  if (
    threshold === null ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) return false;

  if (minTokens !== undefined && (!Number.isSafeInteger(minTokens) || minTokens <= 0)) return false;

  let thresholdTokens: number;
  if (threshold.unit === "tokens") {
    if (!Number.isSafeInteger(threshold.value) || threshold.value <= 0) return false;
    thresholdTokens = threshold.value;
  } else {
    if (!Number.isFinite(threshold.value) || threshold.value <= 0 || threshold.value > 100) return false;
    thresholdTokens = Math.floor((contextWindow * threshold.value) / 100);
  }
  if (minTokens !== undefined) thresholdTokens = Math.max(thresholdTokens, minTokens);
  return tokens >= thresholdTokens;
}

/**
 * Pi's native threshold is the safety ceiling. The target percentage makes the
 * policy earlier on large windows; observed turn growth can move it earlier
 * again before a fast-growing turn crosses that limit.
 */
export function shouldAutoCompact(args: {
  tokens: number;
  contextWindow: number;
  policy: CompactionPolicy;
  targetPercent?: number | null;
  targetTokens?: number | null;
  predictedGrowth: number;
}): boolean {
  const { tokens, contextWindow, policy, predictedGrowth } = args;
  const targetPercent = args.targetPercent === undefined ? DEFAULT_TARGET_PERCENT : args.targetPercent;
  const targetTokens = args.targetTokens === undefined ? DEFAULT_TARGET_TOKENS : args.targetTokens;
  if (
    !policy.enabled ||
    !Number.isFinite(tokens) ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(policy.reserveTokens) ||
    policy.reserveTokens < 0
  ) return false;
  if (targetPercent !== null && (!Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent > 100)) {
    return false;
  }
  if (targetPercent !== null && targetTokens !== null && (!Number.isSafeInteger(targetTokens) || targetTokens <= 0)) {
    return false;
  }

  const nativeThreshold = Math.max(0, contextWindow - policy.reserveTokens);
  // Let Pi's own automatic compaction handle a threshold that has already been crossed.
  if (tokens >= nativeThreshold) return false;

  const policyThreshold = targetPercent === null
    ? nativeThreshold
    : Math.min(
        nativeThreshold,
        Math.floor((contextWindow * targetPercent) / 100),
        targetTokens ?? Number.MAX_SAFE_INTEGER,
      );
  return tokens + Math.max(0, predictedGrowth) >= policyThreshold;
}
