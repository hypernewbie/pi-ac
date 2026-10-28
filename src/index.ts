import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createGrowthHistory,
  DEFAULT_TARGET_PERCENT,
  estimateNextTurnGrowth,
  observeTokens,
  shouldAutoCompact,
} from "./policy.ts";

const RESUME_PROMPT = "Continue the current task from the compacted context. Do not repeat completed work.";
type CompactionSource = "automatic" | "command" | "Pi";

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
  });

  pi.on("session_compact", (event) => {
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

  function startCompaction(
    ctx: ExtensionContext,
    options: { source: Exclude<CompactionSource, "Pi">; resume: boolean; customInstructions?: string },
  ): void {
    if (compacting) return;
    compacting = true;
    compactionWasAborted = false;
    compactionSource = options.source;
    let finished = false;

    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      compacting = false;
      compactionSource = null;
      growth = createGrowthHistory();
      if (!success) stoppedAfterError = true;
      if (options.resume && !compactionWasAborted) pi.sendUserMessage(RESUME_PROMPT);
    };

    // Use Pi's summary. Manual compaction stops the current run, so queue one
    // continuation when that run had unfinished work.
    ctx.compact({
      customInstructions: options.customInstructions,
      onComplete: () => finish(true),
      onError: () => finish(false),
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
        "/ac status                 Show context and adaptive threshold",
        "/ac compact [focus]        Run Pi's compaction; resume an interrupted task",
        "/ac threshold <1-100|off>  Set this session's adaptive target",
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

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}
