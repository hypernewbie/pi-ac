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
const AC_COMMANDS = [
  { name: "help", description: "Show help and current session status" },
  { name: "status", description: "Show context usage and compaction settings" },
  { name: "compact", description: "Compact now; resume interrupted work" },
  { name: "threshold", description: "Set the adaptive target" },
  { name: "end-turn", description: "Set the end-of-turn token threshold" },
  { name: "end-turn-delay", description: "Set the end-of-turn delay in minutes" },
  { name: "compactor", description: "Save or clear the summary model" },
  { name: "enable", description: "Enable proactive compaction" },
  { name: "disable", description: "Disable proactive compaction" },
] as const;
const AC_ARGUMENTS: Record<string, { value: string; description: string }[]> = {
  threshold: [
    { value: "off", description: "Use Pi's native threshold only" },
    { value: "50", description: "Set a 50% target" },
    { value: "60", description: "Set a 60% target" },
    { value: "70", description: "Set a 70% target" },
    { value: "80", description: "Set an 80% target" },
    { value: "90", description: "Set a 90% target" },
    { value: "100", description: "Set a 100% target" },
  ],
  "end-turn": [
    { value: "off", description: "Disable end-of-turn compaction" },
    { value: "80%", description: "Compact at 80% of the context window" },
    { value: "90%", description: "Compact at 90% of the context window" },
    { value: "120000", description: "Compact at 120,000 tokens" },
  ],
  "end-turn-delay": [
    { value: "0", description: "Compact immediately" },
    { value: "1", description: "Wait 1 minute" },
    { value: "5", description: "Wait 5 minutes" },
    { value: "10", description: "Wait 10 minutes" },
  ],
  compactor: [
    { value: "current", description: "Save the active model for summaries" },
    { value: "clear", description: "Use the active model for summaries" },
  ],
};
type CompactionSource = "automatic" | "command" | "end-of-turn" | "Pi";

interface LastCompaction {
  source: CompactionSource;
  tokensBefore: number;
}

interface ModelReference {
  provider: string;
  id: string;
}

interface CompactionRequest {
  source: Exclude<CompactionSource, "Pi">;
  resume: boolean;
  customInstructions?: string;
}

interface PendingCompaction {
  request: CompactionRequest;
  compactor: ModelReference;
  originalModel: ExtensionContext["model"];
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  resolve: () => void;
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
  let endOfTurnDelayMinutes = 0;
  let endOfTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let compactorModel: ModelReference | null = null;
  let pendingCompaction: PendingCompaction | undefined;
  let agentRunActive = false;
  let compactedAfterLastTurn = false;
  let lastTurnOutcome: "completed" | "aborted" | "error" | null = null;

  pi.registerCommand("ac", {
    description: "Show help, check status, and manage context compaction",
    getArgumentCompletions: getAcArgumentCompletions,
    handler: async (args, ctx) => handleCommand(args, ctx),
  });

  pi.on("session_start", () => {
    cancelEndOfTurnTimer();
    pendingCompaction?.resolve();
    pendingCompaction = undefined;
    growth = createGrowthHistory();
    autoEnabled = true;
    compacting = false;
    stoppedAfterError = false;
    compactionWasAborted = false;
    compactionSource = null;
    lastCompaction = undefined;
    targetPercent = DEFAULT_TARGET_PERCENT;
    endOfTurnThreshold = null;
    endOfTurnDelayMinutes = 0;
    compactorModel = null;
    agentRunActive = false;
    compactedAfterLastTurn = false;
    lastTurnOutcome = null;
  });

  pi.on("session_shutdown", () => {
    cancelEndOfTurnTimer();
  });

  pi.on("agent_start", () => {
    cancelEndOfTurnTimer();
    if (!agentRunActive) {
      agentRunActive = true;
      compactedAfterLastTurn = false;
      lastTurnOutcome = null;
    }
  });

  // Wait for Pi's recovery/compaction work to finish before checking the final context.
  pi.on("agent_settled", async (event, ctx) => {
    if (pendingCompaction) {
      const pending = pendingCompaction;
      const alreadyCompacted = compactedAfterLastTurn;
      pendingCompaction = undefined;
      agentRunActive = false;
      compactedAfterLastTurn = false;
      lastTurnOutcome = null;
      if (alreadyCompacted) {
        finishCompaction(true, pending.request, true);
        pending.resolve();
        return;
      }
      try {
        await performCompaction(
          ctx,
          pending.request,
          pending.compactor,
          pending.originalModel,
          pending.thinkingLevel,
        );
      } finally {
        pending.resolve();
      }
      return;
    }

    const alreadyCompacted = compactedAfterLastTurn;
    const completed = lastTurnOutcome === "completed";
    agentRunActive = false;
    compactedAfterLastTurn = false;
    lastTurnOutcome = null;

    if (alreadyCompacted || !completed || event.aborted || !isEndOfTurnCompactionReady(ctx)) return;

    await scheduleEndOfTurnCompaction(ctx);
  });

  pi.on("session_compact", (event) => {
    cancelEndOfTurnTimer();
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

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
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
      case "end-turn-delay":
        setEndOfTurnDelay(ctx, value);
        return;
      case "compactor":
        setCompactor(ctx, value);
        return;
      case "enable":
        autoEnabled = true;
        stoppedAfterError = false;
        growth = createGrowthHistory();
        report(ctx, "Automatic compaction enabled.");
        return;
      case "disable":
        autoEnabled = false;
        cancelEndOfTurnTimer();
        report(ctx, "Automatic compaction disabled. Pi's native compaction remains available.");
        return;
      case "compact":
        if (compacting) return;
        await startCompaction(ctx, {
          source: "command",
          resume: !ctx.isIdle(),
          customInstructions: value || undefined,
        });
        return;
      default:
        showHelp(ctx, `Unknown /ac command: ${subcommand}`);
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
    if (parsed === null) cancelEndOfTurnTimer();
    report(
      ctx,
      parsed === null
        ? "End-of-turn compaction disabled for this session."
        : `End-of-turn compaction threshold set to ${formatEndOfTurnThreshold(parsed)} for this session.`,
    );
  }

  function setEndOfTurnDelay(ctx: ExtensionCommandContext, value: string): void {
    if (!value) {
      showStatus(ctx);
      return;
    }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
      report(ctx, "Usage: /ac end-turn-delay <minutes> (0 = immediate)", "warning");
      return;
    }
    const parsed = Number(value);
    const delayMs = parsed * 60_000;
    if (!Number.isFinite(parsed) || delayMs > 2_147_483_647) {
      report(ctx, "End-of-turn delay must be between 0 and 35,791.39 minutes.", "warning");
      return;
    }
    const reschedulePending = endOfTurnTimer !== undefined;
    if (reschedulePending) cancelEndOfTurnTimer();
    endOfTurnDelayMinutes = parsed;
    report(
      ctx,
      parsed === 0
        ? "End-of-turn compaction delay set to 0 minutes (immediate)."
        : `End-of-turn compaction delay set to ${parsed} minute${parsed === 1 ? "" : "s"}.`,
    );
    if (reschedulePending && isEndOfTurnCompactionReady(ctx)) {
      void scheduleEndOfTurnCompaction(ctx).catch((error) => {
        report(ctx, `Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    }
  }

  function setCompactor(ctx: ExtensionCommandContext, value: string): void {
    const action = value.toLowerCase();
    if (!action) {
      showStatus(ctx);
      return;
    }
    if (action === "clear") {
      compactorModel = null;
      report(ctx, "Compactor cleared; compaction will use the active model.");
      return;
    }
    if (action !== "current") {
      report(ctx, "Usage: /ac compactor <current|clear>", "warning");
      return;
    }
    if (!ctx.model) {
      report(ctx, "No active model is available to save as the compactor.", "warning");
      return;
    }
    compactorModel = { provider: ctx.model.provider, id: ctx.model.id };
    report(ctx, `Compactor set to ${formatModelReference(compactorModel)} for this session.`);
  }

  function isEndOfTurnCompactionReady(ctx: ExtensionContext): boolean {
    if (
      agentRunActive ||
      !autoEnabled ||
      !endOfTurnThreshold ||
      compacting ||
      stoppedAfterError ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      !getCompactionPolicy(ctx).enabled
    ) return false;

    const usage = ctx.getContextUsage();
    return usage !== undefined && usage.tokens !== null &&
      shouldCompactAtEndOfTurn(usage.tokens, usage.contextWindow, endOfTurnThreshold);
  }

  function scheduleEndOfTurnCompaction(ctx: ExtensionContext): Promise<void> {
    cancelEndOfTurnTimer();
    const request: CompactionRequest = { source: "end-of-turn", resume: false };
    if (endOfTurnDelayMinutes === 0) return startCompaction(ctx, request);

    endOfTurnTimer = setTimeout(() => {
      endOfTurnTimer = undefined;
      if (!isEndOfTurnCompactionReady(ctx)) return;
      void startCompaction(ctx, request).catch((error) => {
        report(ctx, `Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
    }, endOfTurnDelayMinutes * 60_000);
    return Promise.resolve();
  }

  function cancelEndOfTurnTimer(): void {
    if (endOfTurnTimer === undefined) return;
    clearTimeout(endOfTurnTimer);
    endOfTurnTimer = undefined;
  }

  function startCompaction(ctx: ExtensionContext, request: CompactionRequest): Promise<void> {
    cancelEndOfTurnTimer();
    if (compacting) return Promise.resolve();
    compacting = true;
    compactionWasAborted = false;

    const compactor = compactorModel ? { ...compactorModel } : null;
    const originalModel = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    if (compactor && !originalModel) {
      report(ctx, "No active model is available to restore after compaction; request skipped.", "warning");
      finishCompaction(false, request, false);
      return Promise.resolve();
    }

    const needsSwitch = compactor !== null && !sameModel(originalModel, compactor);
    if (needsSwitch && !ctx.isIdle()) {
      // Stop the active run before changing models, then resume after compaction.
      return new Promise((resolve) => {
        pendingCompaction = { request, compactor, originalModel, thinkingLevel, resolve };
        ctx.abort();
      });
    }

    return performCompaction(ctx, request, compactor, originalModel, thinkingLevel);
  }

  async function performCompaction(
    ctx: ExtensionContext,
    request: CompactionRequest,
    compactor: ModelReference | null,
    originalModel: ExtensionContext["model"],
    thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  ): Promise<void> {
    let success = false;
    let canResume = true;
    let errorMessage: string | undefined;

    try {
      if (compactor) {
        if (!originalModel) throw new Error("No active model to restore to.");
        if (!sameModel(originalModel, compactor)) {
          const model = ctx.modelRegistry.find(compactor.provider, compactor.id);
          if (!model) throw new Error(`Compactor model not found: ${formatModelReference(compactor)}`);
          const selected = await pi.setModel(model);
          if (!selected) throw new Error(`Compactor model is not available: ${formatModelReference(compactor)}`);
        }
      }

      compactionSource = request.source;
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = (compacted: boolean, error?: Error) => {
          if (finished) return;
          finished = true;
          success = compacted;
          if (error) errorMessage = error.message;
          resolve();
        };
        ctx.compact({
          customInstructions: request.customInstructions,
          onComplete: () => finish(true),
          onError: (error) => finish(false, error),
        });
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (originalModel && !sameModel(ctx.model, originalModel)) {
        try {
          const restored = await pi.setModel(originalModel);
          if (!restored) throw new Error(`Could not restore ${originalModel.provider}/${originalModel.id}`);
          pi.setThinkingLevel(thinkingLevel);
        } catch (error) {
          canResume = false;
          success = false;
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }

      if (errorMessage && !compactionWasAborted) report(ctx, `Compaction failed: ${errorMessage}`, "warning");
      finishCompaction(success, request, canResume);
    }
  }

  function finishCompaction(requestSucceeded: boolean, request: CompactionRequest, canResume: boolean): void {
    compacting = false;
    compactionSource = null;
    growth = createGrowthHistory();
    if (!requestSucceeded) stoppedAfterError = true;
    if (request.resume && canResume && !compactionWasAborted) pi.sendUserMessage(RESUME_PROMPT);
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

  function showHelp(ctx: ExtensionCommandContext, warning?: string): void {
    const lines = [
      "pi-ac: context compaction controls",
      "",
      "Usage: /ac [help] or /ac <command> [arguments]",
      "",
      "/ac or /ac help           Show this guide and current session status",
      "/ac compact [focus]       Compact now; resume interrupted work",
      "/ac status                Show context and compaction settings",
      "/ac threshold <1-100|off> Set adaptive target; off uses Pi's threshold",
      "/ac end-turn <token-count|percent%|off> Set final-run threshold (off by default)",
      "/ac end-turn-delay <minutes>   Wait before final compaction; 0 is immediate",
      "/ac compactor current    Save the active model for summaries",
      "/ac compactor clear      Use the active model for each summary",
      "/ac enable | disable     Toggle proactive compaction",
      "",
      "Examples: /ac threshold 80 · /ac end-turn 120000 · /ac end-turn-delay 5",
      "",
      "Current session:",
      ...getStatusLines(ctx),
    ];
    if (warning) lines.unshift(warning, "");
    report(ctx, lines.join("\n"), warning ? "warning" : "info");
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    report(ctx, getStatusLines(ctx).join("\n"));
  }

  function getStatusLines(ctx: ExtensionContext): string[] {
    const usage = ctx.getContextUsage();
    const policy = getCompactionPolicy(ctx);
    const lines = [
      `pi-ac: ${autoEnabled ? "automatic compaction enabled" : "automatic compaction disabled"}`,
      `context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"}`,
    ];
    lines.push(`end-of-turn compaction: ${formatEndOfTurnThreshold(endOfTurnThreshold, usage?.contextWindow)}`);
    lines.push(`end-of-turn delay: ${formatEndOfTurnDelay(endOfTurnDelayMinutes)}`);
    lines.push(`compactor model: ${compactorModel ? formatModelReference(compactorModel) : "active model (no switch)"}`);
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
    return lines;
  }
}

function getAcArgumentCompletions(prefix: string) {
  const normalized = prefix.trimStart();
  const separator = normalized.indexOf(" ");
  if (separator === -1) {
    const commandPrefix = normalized.toLowerCase();
    const matches = AC_COMMANDS.filter((command) => command.name.startsWith(commandPrefix));
    return matches.length > 0
      ? matches.map((command) => ({
          value: `${command.name} `,
          label: command.name,
          description: command.description,
        }))
      : null;
  }

  const command = normalized.slice(0, separator).toLowerCase();
  const argumentPrefix = normalized.slice(separator + 1).trimStart().toLowerCase();
  const options = AC_ARGUMENTS[command];
  if (!options) return null;
  const matches = options.filter((option) => option.value.toLowerCase().startsWith(argumentPrefix));
  return matches.length > 0
    ? matches.map((option) => ({
        value: `${command} ${option.value}`,
        label: option.value,
        description: option.description,
      }))
    : null;
}

function report(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(`[pi-ac] ${message}`);
}

function sameModel(
  left: { provider: string; id: string } | null | undefined,
  right: { provider: string; id: string } | null | undefined,
): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function formatModelReference(model: ModelReference): string {
  return `${model.provider}/${model.id}`;
}

function formatEndOfTurnDelay(minutes: number): string {
  return minutes === 0 ? "0 minutes (immediate)" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
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
