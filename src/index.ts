import { DEFAULT_COMPACTION_SETTINGS, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createGrowthHistory,
  DEFAULT_END_OF_TURN_DELAY_MINUTES,
  DEFAULT_END_OF_TURN_MIN_TOKENS,
  DEFAULT_END_OF_TURN_THRESHOLD,
  DEFAULT_TARGET_PERCENT,
  DEFAULT_TARGET_TOKENS,
  estimateNextTurnGrowth,
  observeTokens,
  parseEndOfTurnThreshold,
  shouldAutoCompact,
  shouldCompactAtEndOfTurn,
  type EndOfTurnThreshold,
} from "./policy.ts";
import {
  loadAdaptiveThreshold,
  loadEndOfTurnThreshold,
  saveAdaptiveThreshold,
  saveEndOfTurnThreshold,
} from "./threshold-config.ts";

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
    { value: "default", description: "Restore the 50% or 230K-token target" },
    { value: "off", description: "Use Pi's native threshold only" },
    { value: "50", description: "Set a 50% target" },
    { value: "60", description: "Set a 60% target" },
    { value: "70", description: "Set a 70% target" },
    { value: "80", description: "Set an 80% target" },
    { value: "90", description: "Set a 90% target" },
    { value: "100", description: "Set a 100% target" },
  ],
  "end-turn": [
    { value: "default", description: "Restore the higher of 200K tokens or 40%" },
    { value: "off", description: "Disable end-of-turn compaction" },
    { value: "80%", description: "Compact at 80% of the context window" },
    { value: "90%", description: "Compact at 90% of the context window" },
    { value: "120000", description: "Compact at 120,000 tokens" },
  ],
  "end-turn-delay": [
    { value: "0", description: "Compact immediately" },
    { value: "1", description: "Wait 1 minute" },
    { value: "5", description: "Wait 5 minutes" },
    { value: "10", description: "Wait 10 minutes (default)" },
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
  let endOfTurnThreshold: EndOfTurnThreshold | null = { ...DEFAULT_END_OF_TURN_THRESHOLD };
  let endOfTurnUsesDefault = true;
  let endOfTurnDelayMinutes = DEFAULT_END_OF_TURN_DELAY_MINUTES;
  let endOfTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let compactorModel: ModelReference | null = null;
  let pendingCompaction: PendingCompaction | undefined;
  let agentRunActive = false;
  let compactedAfterLastTurn = false;
  let lastTurnOutcome: "completed" | "aborted" | "error" | null = null;

  const acCommand = {
    description: "Show help, check status, and manage context compaction",
    getArgumentCompletions: getAcArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => handleCommand(args, ctx),
  };
  pi.registerCommand("ac", acCommand);
  pi.registerCommand("autocompact", acCommand);

  pi.on("session_start", async (_event, ctx) => {
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
    endOfTurnThreshold = { ...DEFAULT_END_OF_TURN_THRESHOLD };
    endOfTurnUsesDefault = true;
    endOfTurnDelayMinutes = DEFAULT_END_OF_TURN_DELAY_MINUTES;
    compactorModel = null;
    agentRunActive = false;
    compactedAfterLastTurn = false;
    lastTurnOutcome = null;
    try {
      const savedTarget = await loadAdaptiveThreshold(getAgentDir());
      if (savedTarget !== undefined) targetPercent = savedTarget;
    } catch (error) {
      report(ctx, `Could not load adaptive threshold; using the built-in default. ${errorMessage(error)}`, "warning");
    }
    try {
      const savedEndOfTurn = await loadEndOfTurnThreshold(getAgentDir());
      if (savedEndOfTurn !== undefined) {
        endOfTurnThreshold = savedEndOfTurn;
        endOfTurnUsesDefault = false;
      }
    } catch (error) {
      endOfTurnThreshold = { ...DEFAULT_END_OF_TURN_THRESHOLD };
      endOfTurnUsesDefault = true;
      report(ctx, `Could not load end-of-turn threshold; using the built-in default. ${errorMessage(error)}`, "warning");
    }
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
        await setThreshold(ctx, value);
        return;
      case "end-turn":
        await setEndOfTurnThreshold(ctx, value);
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

  async function setThreshold(ctx: ExtensionCommandContext, value: string): Promise<void> {
    if (!value) {
      showStatus(ctx);
      return;
    }
    let nextValue: number | null;
    let savedValue: number | null | undefined;
    let successMessage: string;
    if (/^default$/i.test(value)) {
      nextValue = DEFAULT_TARGET_PERCENT;
      savedValue = undefined;
      successMessage = "Adaptive target reset to the built-in default; saved override removed for this and future sessions.";
    } else if (/^(off|null|none)$/i.test(value)) {
      nextValue = null;
      savedValue = null;
      successMessage = "Adaptive percentage target disabled; growth forecasting still uses Pi's threshold. Saved globally for future sessions.";
    } else {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
        report(ctx, "Usage: /ac threshold <default|1-100|off>", "warning");
        return;
      }
      nextValue = parsed;
      savedValue = parsed;
      successMessage = `Adaptive compaction target set to ${parsed}%, capped at 230,000 tokens. Saved globally for future sessions.`;
    }

    try {
      await saveAdaptiveThreshold(getAgentDir(), savedValue);
    } catch (error) {
      report(ctx, `Could not save adaptive threshold; active value is unchanged. ${errorMessage(error)}`, "warning");
      return;
    }
    targetPercent = nextValue;
    report(ctx, successMessage);
  }

  async function setEndOfTurnThreshold(ctx: ExtensionCommandContext, value: string): Promise<void> {
    if (!value) {
      showStatus(ctx);
      return;
    }

    let nextValue: EndOfTurnThreshold | null;
    let savedValue: EndOfTurnThreshold | null | undefined;
    let usesDefault: boolean;
    let successMessage: string;
    if (/^default$/i.test(value)) {
      nextValue = { ...DEFAULT_END_OF_TURN_THRESHOLD };
      savedValue = undefined;
      usesDefault = true;
      successMessage = "End-of-turn compaction reset to the built-in default; saved override removed for this and future sessions.";
    } else {
      const parsed = parseEndOfTurnThreshold(value);
      if (parsed === undefined) {
        report(ctx, "Usage: /ac end-turn <default|off|token-count|percent%>", "warning");
        return;
      }
      nextValue = parsed;
      savedValue = parsed;
      usesDefault = false;
      successMessage = parsed === null
        ? "End-of-turn compaction disabled. Saved globally for future sessions."
        : `End-of-turn compaction threshold set to ${formatEndOfTurnThreshold(parsed)}. Saved globally for future sessions.`;
    }

    try {
      await saveEndOfTurnThreshold(getAgentDir(), savedValue);
    } catch (error) {
      report(ctx, `Could not save end-of-turn threshold; active value is unchanged. ${errorMessage(error)}`, "warning");
      return;
    }
    endOfTurnThreshold = nextValue;
    endOfTurnUsesDefault = usesDefault;
    if (nextValue === null) cancelEndOfTurnTimer();
    report(ctx, successMessage);
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
      shouldCompactAtEndOfTurn(
        usage.tokens,
        usage.contextWindow,
        endOfTurnThreshold,
        endOfTurnUsesDefault ? DEFAULT_END_OF_TURN_MIN_TOKENS : undefined,
      );
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
      "/autocompact              Alias for /ac",
      "/ac compact [focus]       Compact now; resume interrupted work",
      "/ac status                Show context and compaction settings",
      "/ac threshold <default|1-100|off> Set and save global adaptive target; off uses Pi's threshold",
      "/ac end-turn <default|token-count|percent%|off> Set and save global final-run threshold",
      "/ac end-turn-delay <minutes>   Wait before final compaction; default 10, 0 is immediate",
      "/ac compactor current    Save the active model for summaries",
      "/ac compactor clear      Use the active model for each summary",
      "/ac enable | disable     Toggle proactive compaction",
      "",
      "Defaults: adaptive min(230K, 50%); end-turn max(200K, 40%) after 10 minutes",
      "Thresholds save globally; delay, enable state, and compactor model are session-only.",
      "Other running Pi sessions do not update when a threshold changes.",
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
    lines.push(`end-of-turn compaction: ${formatEndOfTurnThreshold(
      endOfTurnThreshold,
      usage?.contextWindow,
      endOfTurnUsesDefault ? DEFAULT_END_OF_TURN_MIN_TOKENS : undefined,
    )}`);
    lines.push(`end-of-turn delay: ${formatEndOfTurnDelay(endOfTurnDelayMinutes)}`);
    lines.push(`compactor model: ${compactorModel ? formatModelReference(compactorModel) : "active model (no switch)"}`);
    if (usage && usage.contextWindow > 0) {
      const nativeThreshold = Math.max(0, usage.contextWindow - policy.reserveTokens);
      const adaptiveThreshold = targetPercent === null
        ? nativeThreshold
        : Math.min(
            nativeThreshold,
            Math.floor((usage.contextWindow * targetPercent) / 100),
            DEFAULT_TARGET_TOKENS,
          );
      lines.push(
        `adaptive target: ${targetPercent === null
          ? "Pi threshold"
          : `${targetPercent}% or ${formatTokens(DEFAULT_TARGET_TOKENS)} tokens (whichever is lower; ~${formatTokens(adaptiveThreshold)})`}`,
      );
      lines.push(`Pi threshold: ~${formatTokens(nativeThreshold)} · reserve ${formatTokens(policy.reserveTokens)}`);
      lines.push(`recent growth forecast: ~${formatTokens(estimateNextTurnGrowth(growth))}`);
    } else {
      lines.push(`adaptive target: ${targetPercent === null ? "Pi threshold" : `${targetPercent}% or ${formatTokens(DEFAULT_TARGET_TOKENS)} tokens (whichever is lower)`}`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  minTokens?: number,
): string {
  if (threshold === null) return "off";
  if (threshold.unit === "tokens") return `${threshold.value.toLocaleString()} tokens`;
  const percentTokens = contextWindow && contextWindow > 0
    ? Math.floor((contextWindow * threshold.value) / 100)
    : undefined;
  const effectiveTokens = percentTokens === undefined
    ? undefined
    : Math.max(percentTokens, minTokens ?? 0);
  const estimate = effectiveTokens === undefined ? "" : ` (~${formatTokens(effectiveTokens)})`;
  const description = minTokens === undefined
    ? `${threshold.value}% of context window`
    : `${formatTokens(minTokens)} tokens or ${threshold.value}% of context window (whichever is higher)`;
  return `${description}${estimate}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}
