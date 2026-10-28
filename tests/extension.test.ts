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
    ui: { notify: vi.fn() },
  };
  piAc(pi);

  const turn = (nextTokens: number, canContinue = true, pendingMessages: unknown[] = []) => {
    tokens = nextTokens;
    handlers.turn_end(
      { context: { canContinue, pendingMessages } },
      ctx,
    );
  };

  return {
    pi,
    ctx,
    turn,
    command: (args: string) => commandHandler?.(args, ctx),
    failCompact: (aborted = false) => {
      handlers.session_compact_failed({ reason: "manual", aborted }, ctx);
      compactOptions?.onError?.(new Error("compaction error"));
    },
    completeCompact: () => compactOptions?.onComplete?.({}),
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

  it("registers the /ac interface without a compact command", () => {
    const { ctx, command } = harness();
    command("compact");
    expect(ctx.compact).not.toHaveBeenCalled();
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("/ac status");
    expect(messages).toContain("/ac compress");
    expect(messages).not.toContain("/ac compact");
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

  it("compresses with Pi's default and resumes only an interrupted task", () => {
    const active = harness();
    active.ctx.isIdle.mockReturnValue(false);
    active.command("compress keep the current plan");
    expect(active.ctx.compact.mock.calls[0][0].customInstructions).toBe("keep the current plan");
    active.completeCompact();
    expect(active.pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const idle = harness();
    idle.command("compress");
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
