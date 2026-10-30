import { describe, expect, it, vi } from "vitest";
import piAc from "../src/index.ts";

function harness(options: { enabled?: boolean; reserveTokens?: number; overrideReserve?: number; contextWindow?: number } = {}) {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const commandHandlers: Record<string, (args: string, ctx: any) => unknown> = {};
  const commandCompletions: Record<string, (prefix: string) => any> = {};
  let tokens = 40_000;
  const contextWindow = options.contextWindow ?? 100_000;
  let compactOptions: any;
  let compactModel: any;
  let thinkingLevel = "high";
  const activeModel = { provider: "test", id: "model" };
  const alternateModel = { provider: "other", id: "active" };
  const availableModels = [activeModel, alternateModel];
  let ctx: any;
  const pi: any = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => {
      handlers[name] = handler;
      return () => {};
    },
    registerCommand: (name: string, command: any) => {
      expect(["ac", "autocompact"]).toContain(name);
      commandHandlers[name] = command.handler;
      commandCompletions[name] = command.getArgumentCompletions;
    },
    getSettings: () => ({
      compaction: {
        enabled: options.enabled ?? true,
        reserveTokens: options.reserveTokens ?? 16_384,
        modelOverrides: options.overrideReserve
          ? { "test/model": { reserveTokens: options.overrideReserve } }
          : {},
      },
    }),
    setModel: vi.fn(async (model: any) => {
      ctx.model = model;
      return true;
    }),
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: vi.fn((level: string) => {
      thinkingLevel = level;
    }),
    sendUserMessage: vi.fn(),
  };
  ctx = {
    model: activeModel,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        availableModels.find((model) => model.provider === provider && model.id === id),
      ),
    },
    getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
    compact: vi.fn((value) => {
      compactOptions = value;
      compactModel = ctx.model;
    }),
    hasUI: true,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    abort: vi.fn(),
    ui: { notify: vi.fn() },
  };
  piAc(pi);

  const turn = (
    nextTokens: number,
    canContinue = true,
    pendingMessages: unknown[] = [],
    outcome: "completed" | "aborted" | "error" = "completed",
  ) => {
    tokens = nextTokens;
    handlers.turn_end({ context: { canContinue, pendingMessages }, outcome }, ctx);
  };

  return {
    pi,
    ctx,
    turn,
    command: (args: string, name = "ac") => commandHandlers[name]?.(args, ctx),
    completeArgs: (prefix: string, name = "ac") => commandCompletions[name]?.(prefix) ?? null,
    activeModel,
    alternateModel,
    compactModel: () => compactModel,
    startSession: () => handlers.session_start({}, ctx),
    shutdownSession: () => handlers.session_shutdown({}, ctx),
    startRun: () => {
      ctx.isIdle.mockReturnValue(false);
      return handlers.agent_start({}, ctx);
    },
    settle: (aborted = false) => {
      ctx.isIdle.mockReturnValue(true);
      return handlers.agent_settled({ aborted }, ctx);
    },
    noteCompaction: () => handlers.session_compact({ compactionEntry: { tokensBefore: tokens } }, ctx),
    failCompact: (aborted = false) => {
      handlers.session_compact_failed({ reason: "manual", aborted }, ctx);
      compactOptions?.onError?.(new Error("compaction error"));
    },
    completeCompact: () => {
      handlers.session_compact({ compactionEntry: { tokensBefore: tokens } }, ctx);
      compactOptions?.onComplete?.({});
    },
  };
}

describe("pi-ac lifecycle", () => {
  it("uses Pi's default compaction and queues one continuation", async () => {
    const { pi, ctx, turn, completeCompact } = harness();
    turn(40_000);
    turn(70_000); // The observed 30k growth predicts crossing Pi's 83,616-token threshold.

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.compact.mock.calls[0][0].customInstructions).toBeUndefined();
    completeCompact();
    completeCompact();
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(1));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      "Continue the current task from the compacted context. Do not repeat completed work.",
    );
  });

  it("does not interfere when the turn is complete or messages are queued", () => {
    const finalTurn = harness();
    finalTurn.turn(90_000, false);
    expect(finalTurn.ctx.compact).not.toHaveBeenCalled();

    const queued = harness();
    queued.turn(90_000, true, [{ role: "user" }]);
    expect(queued.ctx.compact).not.toHaveBeenCalled();
  });

  it("leaves an already-crossed Pi-native threshold to Pi", () => {
    const { ctx, turn } = harness();
    turn(84_000);
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("resumes once after a compaction error, then leaves recovery to Pi", async () => {
    const { pi, ctx, turn, failCompact } = harness();
    turn(40_000);
    turn(70_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    failCompact();
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(1));

    turn(80_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("does not queue a continuation after the user aborts compaction", () => {
    const { pi, turn, failCompact } = harness();
    turn(40_000);
    turn(70_000);
    failCompact(true);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("shows the /ac command interface", () => {
    const { ctx, command } = harness();
    command("help");
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("/ac or /ac help");
    expect(messages).toContain("/autocompact              Alias for /ac");
    expect(messages).toContain("Current session:");
    expect(messages).toContain("/ac status");
    expect(messages).toContain("/ac compact");
    expect(messages).toContain("/ac threshold");
    expect(messages).toContain("/ac end-turn");
    expect(messages).toContain("/ac end-turn-delay");
    expect(messages).toContain("/ac compactor");
    expect(messages).toContain("/ac enable | disable");

    command("end-turn 80%");
    command("status");
    const status = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(status).toContain("end-of-turn compaction: 80% of context window (~80K)");
  });

  it("completes /ac subcommands and their common values", () => {
    const { completeArgs } = harness();
    expect(completeArgs("").map((item: any) => item.value)).toContain("status ");
    expect(completeArgs("comp").map((item: any) => item.value)).toEqual(["compact ", "compactor "]);
    expect(completeArgs("compactor c").map((item: any) => item.value)).toEqual([
      "compactor current",
      "compactor clear",
    ]);
    expect(completeArgs("end-turn-delay ").map((item: any) => item.value)).toContain("end-turn-delay 0");
    expect(completeArgs("end-turn ").map((item: any) => item.value)).toContain("end-turn default");
    expect(completeArgs("threshold ").map((item: any) => item.value)).toContain("threshold default");
    expect(completeArgs("unknown")).toBeNull();
  });

  it("supports /autocompact as an alias with matching commands and completions", async () => {
    const { ctx, command, completeArgs } = harness();
    await command("threshold 60", "autocompact");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("Adaptive compaction target set to 60%");

    await command("status", "autocompact");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("adaptive target: 60% or 230K tokens");
    expect(completeArgs("compactor c", "autocompact").map((item: any) => item.value)).toEqual([
      "compactor current",
      "compactor clear",
    ]);
  });

  it("saves the active model as compactor and can clear it", async () => {
    const { ctx, command, activeModel, startSession } = harness();
    await command("compactor current");
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: test/model");

    await command("compactor clear");
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: active model (no switch)");

    await command("compactor current");
    startSession();
    await command("status");
    expect(ctx.model).toBe(activeModel);
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: active model (no switch)");
  });

  it("uses the active model after clearing the compactor", async () => {
    const { pi, ctx, command, alternateModel, completeCompact, compactModel } = harness();
    await command("compactor current");
    await command("compactor clear");
    ctx.model = alternateModel;

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(alternateModel);
    completeCompact();
    await compaction;
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("skips compaction if the saved compactor cannot be selected", async () => {
    const { pi, ctx, command, alternateModel } = harness();
    await command("compactor current");
    ctx.model = alternateModel;
    pi.setModel.mockResolvedValueOnce(false);

    await command("compact");
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
      .toContain("Compactor model is not available: test/model");
  });

  it("can disable and resets the end-of-turn threshold per session", () => {
    const { ctx, command, startSession } = harness();
    command("end-turn-delay 5");
    command("end-turn 120000");
    command("end-turn default");
    command("status");
    let status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("200K tokens or 40% of context window (whichever is higher)");

    command("end-turn off");
    command("status");
    status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("end-of-turn compaction: off");
    expect(status).toContain("end-of-turn delay: 5 minutes");

    command("end-turn 120000");
    startSession();
    command("status");
    status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("end-of-turn compaction: 200K tokens or 40% of context window (whichever is higher)");
    expect(status).toContain("end-of-turn delay: 10 minutes");
  });

  it("enables end-of-turn compaction by default at max(200K, 40%) after ten minutes", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, command, startRun, turn, settle, completeCompact } = harness({ contextWindow: 1_000_000 });
      await command("status");
      const status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
      expect(status).toContain("200K tokens or 40% of context window (whichever is higher) (~400K)");
      expect(status).toContain("end-of-turn delay: 10 minutes");

      startRun();
      turn(400_000, false);
      await settle();
      expect(ctx.compact).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(599_999);
      expect(ctx.compact).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.compact).toHaveBeenCalledTimes(1);
      completeCompact();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("compacts a completed run at an absolute end-of-turn threshold without resuming", async () => {
    const { pi, ctx, command, startRun, turn, settle, completeCompact } = harness();
    command("end-turn 70000");
    command("end-turn-delay 0");
    startRun();
    turn(40_000);
    turn(75_000, false);

    expect(ctx.compact).not.toHaveBeenCalled();
    const settling = settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    completeCompact();
    await settling;
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("delays end-of-turn compaction and rechecks when the delay expires", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, command, startRun, turn, settle, completeCompact } = harness();
      await command("end-turn 70000");
      await command("end-turn-delay 2");
      startRun();
      turn(40_000);
      turn(75_000, false);
      await settle();

      expect(ctx.compact).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(119_999);
      expect(ctx.compact).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.compact).toHaveBeenCalledTimes(1);
      completeCompact();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a delayed end-of-turn compaction when a new run starts", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, command, startRun, turn, settle } = harness();
      await command("end-turn 70000");
      await command("end-turn-delay 1");
      startRun();
      turn(40_000);
      turn(75_000, false);
      await settle();

      startRun();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ctx.compact).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a delayed end-of-turn timer when the session shuts down", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, command, startRun, turn, settle, shutdownSession } = harness();
      await command("end-turn 70000");
      await command("end-turn-delay 1");
      startRun();
      turn(40_000);
      turn(75_000, false);
      await settle();

      shutdownSession();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ctx.compact).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a percentage threshold and the configured compactor at settlement", async () => {
    const { pi, ctx, command, activeModel, alternateModel, startRun, turn, settle, completeCompact, compactModel } = harness();
    await command("compactor current");
    ctx.model = alternateModel;
    await command("end-turn 75%");
    await command("end-turn-delay 0");
    startRun();
    turn(75_000, false);
    const settling = settle();
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(activeModel);
    completeCompact();
    await settling;
    expect(ctx.model).toBe(alternateModel);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("switches to the saved model for manual compaction and restores the active model", async () => {
    const { pi, ctx, command, activeModel, alternateModel, completeCompact, compactModel } = harness();
    await command("compactor current");
    ctx.model = alternateModel;

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(activeModel);
    completeCompact();
    await compaction;

    expect(ctx.model).toBe(alternateModel);
    expect(pi.setModel).toHaveBeenNthCalledWith(1, activeModel);
    expect(pi.setModel).toHaveBeenNthCalledWith(2, alternateModel);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("uses the saved compactor for automatic compaction and resumes on the active model", async () => {
    const { pi, ctx, command, activeModel, alternateModel, startRun, turn, settle, completeCompact, compactModel } = harness();
    await command("compactor current");
    ctx.model = alternateModel;
    startRun();
    turn(40_000);
    turn(70_000);

    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(ctx.compact).not.toHaveBeenCalled();
    const settling = settle(true);
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(activeModel);
    completeCompact();
    await settling;

    expect(ctx.model).toBe(alternateModel);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("skips end-of-turn compaction for aborted or already-compacted runs", async () => {
    const aborted = harness();
    aborted.command("end-turn 80%");
    aborted.startRun();
    aborted.turn(90_000, false, [], "aborted");
    await aborted.settle(true);
    expect(aborted.ctx.compact).not.toHaveBeenCalled();

    const failed = harness();
    failed.command("end-turn 80%");
    failed.startRun();
    failed.turn(90_000, false, [], "error");
    await failed.settle();
    expect(failed.ctx.compact).not.toHaveBeenCalled();

    const alreadyCompacted = harness();
    alreadyCompacted.command("end-turn 80%");
    alreadyCompacted.startRun();
    alreadyCompacted.turn(90_000, false);
    alreadyCompacted.noteCompaction();
    await alreadyCompacted.settle();
    expect(alreadyCompacted.ctx.compact).not.toHaveBeenCalled();

    const compactedThenContinued = harness();
    compactedThenContinued.command("end-turn 80%");
    compactedThenContinued.command("end-turn-delay 0");
    compactedThenContinued.startRun();
    compactedThenContinued.turn(60_000, false);
    compactedThenContinued.noteCompaction();
    compactedThenContinued.turn(90_000, false);
    const settling = compactedThenContinued.settle();
    expect(compactedThenContinued.ctx.compact).toHaveBeenCalledTimes(1);
    compactedThenContinued.completeCompact();
    await settling;

    const queued = harness();
    queued.command("end-turn 80%");
    queued.ctx.hasPendingMessages.mockReturnValue(true);
    queued.startRun();
    queued.turn(90_000, false);
    await queued.settle();
    expect(queued.ctx.compact).not.toHaveBeenCalled();

    const piDisabled = harness({ enabled: false });
    piDisabled.command("end-turn 80%");
    piDisabled.startRun();
    piDisabled.turn(90_000, false);
    await piDisabled.settle();
    expect(piDisabled.ctx.compact).not.toHaveBeenCalled();
  });

  it("disables end-of-turn compaction with /ac disable", async () => {
    const { ctx, command, startRun, turn, settle } = harness();
    command("end-turn 70%");
    command("disable");
    startRun();
    turn(80_000, false);
    await settle();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("sets and restores the default adaptive threshold through /ac threshold", () => {
    const { ctx, command, turn } = harness();
    command("threshold 60");
    turn(40_000);
    turn(59_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    command("threshold default");
    command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0]))
      .toContain("adaptive target: 50% or 230K tokens (whichever is lower; ~50K)");
  });

  it("toggles proactive compaction with /ac enable and disable", () => {
    const { ctx, command, turn } = harness();
    command("disable");
    turn(40_000);
    turn(80_000);
    expect(ctx.compact).not.toHaveBeenCalled();

    command("enable");
    turn(80_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("compacts with Pi's default and resumes only an interrupted task", async () => {
    const active = harness();
    active.ctx.isIdle.mockReturnValue(false);
    const activeCompaction = active.command("compact keep the current plan");
    await vi.waitFor(() => expect(active.ctx.compact).toHaveBeenCalledTimes(1));
    expect(active.ctx.compact.mock.calls[0][0].customInstructions).toBe("keep the current plan");
    active.completeCompact();
    await activeCompaction;
    expect(active.pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const idle = harness();
    const idleCompaction = idle.command("compact");
    await vi.waitFor(() => expect(idle.ctx.compact).toHaveBeenCalledTimes(1));
    idle.completeCompact();
    await idleCompaction;
    expect(idle.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("honors Pi's disabled and model-specific compaction settings", () => {
    const disabled = harness({ enabled: false });
    disabled.turn(40_000);
    disabled.turn(90_000);
    expect(disabled.ctx.compact).not.toHaveBeenCalled();

    const baseline = harness();
    baseline.turn(30_000);
    baseline.turn(39_000);
    expect(baseline.ctx.compact).not.toHaveBeenCalled();

    const overridden = harness({ overrideReserve: 60_000 });
    overridden.turn(30_000);
    overridden.turn(39_000); // Forecast crosses the model override's 40k native threshold.
    expect(overridden.ctx.compact).toHaveBeenCalledTimes(1);
  });
});
