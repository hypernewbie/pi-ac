export interface GrowthHistory {
  previousTokens: number | null;
  deltas: number[];
}

export interface CompactionPolicy {
  enabled: boolean;
  reserveTokens: number;
}

export const DEFAULT_TARGET_PERCENT = 80;
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
  predictedGrowth: number;
}): boolean {
  const { tokens, contextWindow, policy, predictedGrowth } = args;
  const targetPercent = args.targetPercent === undefined ? DEFAULT_TARGET_PERCENT : args.targetPercent;
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

  const nativeThreshold = Math.max(0, contextWindow - policy.reserveTokens);
  // Let Pi's own automatic compaction handle a threshold that has already been crossed.
  if (tokens >= nativeThreshold) return false;

  const policyThreshold = targetPercent === null
    ? nativeThreshold
    : Math.min(nativeThreshold, Math.floor((contextWindow * targetPercent) / 100));
  return tokens + Math.max(0, predictedGrowth) >= policyThreshold;
}
