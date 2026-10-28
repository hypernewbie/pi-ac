import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createGrowthHistory,
  DEFAULT_TARGET_PERCENT,
  estimateNextTurnGrowth,
  observeTokens,
  parseEndOfTurnThreshold,
  shouldAutoCompact,
  shouldCompactAtEndOfTurn,
  type EndOfTurnThreshold,
} from "./policy.ts";

const RESUME_PROMPT = "Continue the current task from the compacted context. Do not repeat completed work.";
type CompactionSource = "automatic" | "command" | "end-of-turn" | "Pi";

interface LastCompaction {
  source: CompactionSource;
  tokensBefore: number;
}

export default function piAc(pi: ExtensionAPI): void {
  let growth = createGrowthHistory();
  let autoEnabled = true;
  let compacting = false;
  let stoppedAfterError = false;
  let compactionWasAborted = false;
  let compactionSource: CompactionSource | null = null;
  let lastCompaction: LastCompaction | undefined;
  let targetPercent: number | null = DEFAULT_TARGET_PERCENT;
  let endOfTurnThreshold: EndOfTurnThreshold | null = null;
  let agentRunActive = false;
  let compactedAfterLastTurn = false;
  let lastTurnOutcome: "completed" | "aborted" | "error" | null = null;

  pi.registerCommand("ac", {
    description: "Automatic compaction controls",
    handler: async (args, ctx) => handleCommand(args, ctx),
  });

  pi.on("session_start", () => {
    growth = createGrowthHistory();
    autoEnabled = true;
    compacting = false;
    stoppedAfterError = false;
    compactionWasAborted = false;
    compactionSource = null;
    lastCompaction = undefined;
    targetPercent = DEFAULT_TARGET_PERCENT;
    endOfTurnThreshold = null;
    agentRunActive = false;
    compactedAfterLastTurn = false;
    lastTurnOutcome = null;
  });

  pi.on("agent_start", () => {
    if (!agentRunActive) {
      agentRunActive = true;
      compactedAfterLastTurn = false;
      lastTurnOutcome = null;
    }
  });

  // Wait for Pi's recovery/compaction work to finish before checking the final context.
  pi.on("agent_settled", async (event, ctx) => {
    const alreadyCompacted = compactedAfterLastTurn;
    const completed = lastTurnOutcome === "completed";
    agentRunActive = false;
    compactedAfterLastTurn = false;
    lastTurnOutcome = null;

    if (
      alreadyCompacted ||
      !completed ||
      event.aborted ||
      !autoEnabled ||
      !endOfTurnThreshold ||
      compacting ||
      stoppedAfterError ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      !getCompactionPolicy(ctx).enabled
    ) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    if (!shouldCompactAtEndOfTurn(usage.tokens, usage.contextWindow, endOfTurnThreshold)) return;

    await startCompaction(ctx, { source: "end-of-turn", resume: false });
  });

  pi.on("session_compact", (event) => {
    if (agentRunActive) compactedAfterLastTurn = true;
    growth = createGrowthHistory();
    lastCompaction = {
      source: compactionSource ?? "Pi",
      tokensBefore: event.compactionEntry.tokensBefore,
    };
  });

  pi.on("model_select", () => {
    growth = createGrowthHistory();
  });

  pi.on("session_compact_failed", (event) => {
    if (compacting && event.reason === "manual") compactionWasAborted = event.aborted;
  });

  pi.on("turn_end", (event, ctx) => {
    compactedAfterLastTurn = false;
    lastTurnOutcome = event.outcome;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;

    observeTokens(growth, usage.tokens);
    const predictedGrowth = estimateNextTurnGrowth(growth);
    if (
      !autoEnabled ||
      compacting ||
      stoppedAfterError ||
      !event.context.canContinue ||
      event.context.pendingMessages.length > 0
    ) {
      return;
    }

    if (
      !shouldAutoCompact({
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        policy: getCompactionPolicy(ctx),
        targetPercent,
        predictedGrowth,
      })
    ) {
      return;
    }

    startCompaction(ctx, { source: "automatic", resume: true });
  });

  function handleCommand(args: string, ctx: ExtensionCommandContext): void {
    const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const command = subcommand.toLowerCase();
    const value = rest.join(" ").trim();

    switch (command) {
      case "":
      case "help":
        showHelp(ctx);
        return;
      case "status":
        showStatus(ctx);
        return;
      case "threshold":
        setThreshold(ctx, value);
        return;
      case "end-turn":
        setEndOfTurnThreshold(ctx, value);
        return;
      case "enable":
        autoEnabled = true;
        stoppedAfterError = false;
        growth = createGrowthHistory();
        report(ctx, "Automatic compaction enabled.");
        return;
      case "disable":
        autoEnabled = false;
        report(ctx, "Automatic compaction disabled. Pi's native compaction remains available.");
        return;
      case "compact":
        if (compacting) return;
        startCompaction(ctx, {
          source: "command",
          resume: !ctx.isIdle(),
          customInstructions: value || undefined,
        });
        return;
      default:
        report(ctx, `Unknown /ac command: ${subcommand}`, "warning");
        showHelp(ctx);
    }
  }

  function setThreshold(ctx: ExtensionCommandContext, value: string): void {
    if (!value) {
      showStatus(ctx);
      return;
    }
    if (/^(off|null|none)$/i.test(value)) {
      targetPercent = null;
      report(ctx, "Adaptive percentage target disabled for this session; growth forecasting still uses Pi's threshold.");
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      report(ctx, "Usage: /ac threshold <1-100|off>", "warning");
      return;
    }
    targetPercent = parsed;
    report(ctx, `Adaptive compaction target set to ${parsed}% for this session.`);
  }

  function setEndOfTurnThreshold(ctx: ExtensionCommandContext, value: string): void {
    if (!value) {
      showStatus(ctx);
      return;
    }
    const parsed = parseEndOfTurnThreshold(value);
    if (parsed === undefined) {
      report(ctx, "Usage: /ac end-turn <off|token-count|percent%>", "warning");
      return;
    }
    endOfTurnThreshold = parsed;
    report(
      ctx,
      parsed === null
        ? "End-of-turn compaction disabled for this session."
        : `End-of-turn compaction threshold set to ${formatEndOfTurnThreshold(parsed)} for this session.`,
    );
  }

  function startCompaction(
    ctx: ExtensionContext,
    options: { source: Exclude<CompactionSource, "Pi">; resume: boolean; customInstructions?: string },
  ): Promise<void> {
    if (compacting) return Promise.resolve();
    compacting = true;
    compactionWasAborted = false;
    compactionSource = options.source;
    let finished = false;

    return new Promise((resolve) => {
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        compacting = false;
        compactionSource = null;
        growth = createGrowthHistory();
        if (!success) stoppedAfterError = true;
        if (options.resume && !compactionWasAborted) pi.sendUserMessage(RESUME_PROMPT);
        resolve();
      };

      // Use Pi's summary. Manual compaction stops the current run, so queue one
      // continuation when that run had unfinished work.
      try {
        ctx.compact({
          customInstructions: options.customInstructions,
          onComplete: () => finish(true),
          onError: () => finish(false),
        });
      } catch {
        finish(false);
      }
    });
  }

  function getCompactionPolicy(ctx: ExtensionContext) {
    const compaction = pi.getSettings().compaction;
    const model = ctx.model;
    const modelKey = model ? `${model.provider}/${model.id}` : undefined;
    const override = modelKey ? compaction?.modelOverrides?.[modelKey] : undefined;
    return {
      enabled: compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
      reserveTokens:
        override?.reserveTokens ?? compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    };
  }

  function showHelp(ctx: ExtensionCommandContext): void {
    report(
      ctx,
      [
        "/ac status                 Show context and compaction thresholds",
        "/ac compact [focus]        Run Pi's compaction; resume an interrupted task",
        "/ac threshold <1-100|off>  Set this session's adaptive target",
        "/ac end-turn <off|token-count|percent%>  Set a final compaction threshold",
        "/ac enable | disable        Toggle proactive compaction",
        "/ac help                   Show these commands",
      ].join("\n"),
    );
    showStatus(ctx);
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    const usage = ctx.getContextUsage();
    const policy = getCompactionPolicy(ctx);
    const lines = [
      `pi-ac: ${autoEnabled ? "automatic compaction enabled" : "automatic compaction disabled"}`,
      `context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"}`,
    ];
    lines.push(`end-of-turn compaction: ${formatEndOfTurnThreshold(endOfTurnThreshold, usage?.contextWindow)}`);
    if (usage && usage.contextWindow > 0) {
      const nativeThreshold = Math.max(0, usage.contextWindow - policy.reserveTokens);
      const adaptiveThreshold = targetPercent === null
        ? nativeThreshold
        : Math.min(nativeThreshold, Math.floor((usage.contextWindow * targetPercent) / 100));
      lines.push(
        `adaptive target: ${targetPercent === null ? "Pi threshold" : `${targetPercent}% (~${formatTokens(adaptiveThreshold)})`}`,
      );
      lines.push(`Pi threshold: ~${formatTokens(nativeThreshold)} · reserve ${formatTokens(policy.reserveTokens)}`);
      lines.push(`recent growth forecast: ~${formatTokens(estimateNextTurnGrowth(growth))}`);
    }
    lines.push(`Pi auto-compaction: ${policy.enabled ? "enabled" : "disabled"}`);
    if (compacting) lines.push("compaction: running");
    if (lastCompaction) {
      lines.push(`last compaction: ${lastCompaction.source} · ~${formatTokens(lastCompaction.tokensBefore)} before`);
    }
    report(ctx, lines.join("\n"));
  }
}

function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(`[pi-ac] ${message}`);
}

function formatEndOfTurnThreshold(
  threshold: EndOfTurnThreshold | null,
  contextWindow?: number,
): string {
  if (threshold === null) return "off";
  if (threshold.unit === "tokens") return `${threshold.value.toLocaleString()} tokens`;
  const estimate = contextWindow && contextWindow > 0
    ? ` (~${formatTokens(Math.floor((contextWindow * threshold.value) / 100))})`
    : "";
  return `${threshold.value}% of context window${estimate}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}
