import { describe, expect, it, vi } from "vitest";
import piAc from "../src/index.ts";

function harness(options: { enabled?: boolean; reserveTokens?: number; overrideReserve?: number } = {}) {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  let commandHandler: ((args: string, ctx: any) => unknown) | undefined;
  let tokens = 40_000;
  let compactOptions: any;
  const pi: any = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => {
      handlers[name] = handler;
      return () => {};
    },
    registerCommand: (name: string, command: any) => {
      expect(name).toBe("ac");
      commandHandler = command.handler;
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
    sendUserMessage: vi.fn(),
  };
  const ctx: any = {
    model: { provider: "test", id: "model" },
    getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: tokens / 1_000 }),
    compact: vi.fn((value) => {
      compactOptions = value;
    }),
    hasUI: true,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
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
    command: (args: string) => commandHandler?.(args, ctx),
    startSession: () => handlers.session_start({}, ctx),
    startRun: () => handlers.agent_start({}, ctx),
    settle: (aborted = false) => handlers.agent_settled({ aborted }, ctx),
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
  it("uses Pi's default compaction and queues one continuation", () => {
    const { pi, ctx, turn, completeCompact } = harness();
    turn(40_000);
    turn(70_000); // The observed 30k growth predicts crossing Pi's 83,616-token threshold.

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.compact.mock.calls[0][0].customInstructions).toBeUndefined();
    completeCompact();
    completeCompact();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
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

  it("resumes once after a compaction error, then leaves recovery to Pi", () => {
    const { pi, ctx, turn, failCompact } = harness();
    turn(40_000);
    turn(70_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    failCompact();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

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
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("/ac status");
    expect(messages).toContain("/ac compact");
    expect(messages).toContain("/ac threshold");
    expect(messages).toContain("/ac end-turn");
    expect(messages).toContain("/ac enable | disable");

    command("end-turn 80%");
    command("status");
    const status = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(status).toContain("end-of-turn compaction: 80% of context window (~80K)");
  });

  it("can disable and resets the end-of-turn threshold per session", () => {
    const { ctx, command, startSession } = harness();
    command("end-turn 120000");
    command("end-turn off");
    command("status");
    let status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("end-of-turn compaction: off");

    command("end-turn 120000");
    startSession();
    command("status");
    status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("end-of-turn compaction: off");
  });

  it("compacts a completed run at an absolute end-of-turn threshold without resuming", async () => {
    const { pi, ctx, command, startRun, turn, settle, completeCompact } = harness();
    command("end-turn 70000");
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

  it("uses a percentage of the current context window at settlement", async () => {
    const { ctx, command, startRun, turn, settle, completeCompact } = harness();
    command("end-turn 75%");
    startRun();
    turn(75_000, false);
    const settling = settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    completeCompact();
    await settling;
  });

  it("keeps end-of-turn compaction opt-in and skips aborted or already-compacted runs", async () => {
    const disabledByDefault = harness();
    disabledByDefault.startRun();
    disabledByDefault.turn(90_000, false);
    await disabledByDefault.settle();
    expect(disabledByDefault.ctx.compact).not.toHaveBeenCalled();

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

  it("sets the adaptive threshold through /ac threshold", () => {
    const { ctx, command, turn } = harness();
    command("threshold 60");
    turn(40_000);
    turn(59_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
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

  it("compacts with Pi's default and resumes only an interrupted task", () => {
    const active = harness();
    active.ctx.isIdle.mockReturnValue(false);
    active.command("compact keep the current plan");
    expect(active.ctx.compact.mock.calls[0][0].customInstructions).toBe("keep the current plan");
    active.completeCompact();
    expect(active.pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const idle = harness();
    idle.command("compact");
    idle.completeCompact();
    expect(idle.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("honors Pi's disabled and model-specific compaction settings", () => {
    const disabled = harness({ enabled: false });
    disabled.turn(40_000);
    disabled.turn(90_000);
    expect(disabled.ctx.compact).not.toHaveBeenCalled();

    const baseline = harness();
    baseline.turn(65_000);
    baseline.turn(68_000);
    expect(baseline.ctx.compact).not.toHaveBeenCalled();

    const overridden = harness({ overrideReserve: 30_000 });
    overridden.turn(65_000);
    overridden.turn(68_000); // Forecast crosses the model override's 70k native threshold.
    expect(overridden.ctx.compact).toHaveBeenCalledTimes(1);
  });
});
