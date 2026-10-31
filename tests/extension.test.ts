import fsSync, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piAc from "../src/index.ts";
import { saveAdaptiveThreshold, saveEndOfTurnThreshold } from "../src/threshold-config.ts";

let agentDir: string;
let testAgentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "pi-ac-extension-"));
  testAgentDir = agentDir;
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (agentDir) await rm(agentDir, { recursive: true, force: true });

});

function harness(options: {
  enabled?: boolean;
  reserveTokens?: number;
  overrideReserve?: number;
  contextWindow?: number;
  noContextUsage?: boolean;
  compactorModelFlag?: string;
  compactorThinkingFlag?: string;
  projectTrusted?: boolean;
  cwd?: string;
} = {}) {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const commandHandlers: Record<string, (args: string, ctx: any) => unknown> = {};
  const commandCompletions: Record<string, (prefix: string) => any> = {};
  let tokens = 40_000;
  const contextWindow = options.contextWindow ?? 100_000;
  const cwd = options.cwd ?? join(testAgentDir, "project");
  let compactOptions: any;
  let compactModel: any;
  let compactThinkingLevel: string | undefined;
  let thinkingLevel = "high";
  const activeModel = { provider: "test", id: "model" };
  const alternateModel = { provider: "other", id: "active" };
  const compactorModel = { provider: "summary", id: "fast/model" };
  const limitedModel = { provider: "limited", id: "off-only", supportedThinkingLevels: ["off"] };
  const availableModels = [activeModel, alternateModel, compactorModel, limitedModel];
  const flags: Record<string, string | undefined> = {
    "ac-compactor-model": options.compactorModelFlag,
    "ac-compactor-thinking": options.compactorThinkingFlag,
  };
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
    registerFlag: vi.fn(),
    getFlag: (name: string) => flags[name],
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
      thinkingLevel = model.supportedThinkingLevels?.[0] ?? "medium";
      return true;
    }),
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: vi.fn((level: string) => {
      const supported = (ctx.model as any)?.supportedThinkingLevels as string[] | undefined;
      thinkingLevel = supported && !supported.includes(level) ? "off" : level;
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
    getContextUsage: () => options.noContextUsage
      ? undefined
      : { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
    compact: vi.fn((value) => {
      compactOptions = value;
      compactModel = ctx.model;
      compactThinkingLevel = thinkingLevel;
    }),
    hasUI: true,
    cwd,
    isProjectTrusted: vi.fn(() => options.projectTrusted ?? true),
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
    compactorModel,
    limitedModel,
    compactModel: () => compactModel,
    compactThinkingLevel: () => compactThinkingLevel,
    thinkingLevel: () => thinkingLevel,
    cwd,
    setSessionSelection: (model: any, level: string) => {
      ctx.model = model;
      thinkingLevel = level;
    },
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

  it("shows the /ac command interface", async () => {
    const { ctx, command } = harness();
    await command("help");
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
    expect(messages).toContain("/ac compactor <provider/model> [thinking]");
    expect(messages).toContain("/ac enable | disable");
    expect(messages).toContain("Thresholds save globally");
    expect(messages).toContain("Other running Pi sessions do not update");

    await command("end-turn 80%");
    await command("status");
    const status = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(status).toContain("end-of-turn compaction: 80% of context window (~80K)");
  });

  it("uses defaults without warning or writing when no override exists", async () => {
    const { ctx, startSession } = harness();
    await startSession();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(await fs.readdir(agentDir!)).toEqual([]);
  });

  it("does not save invalid threshold commands", async () => {
    const { ctx, command } = harness();
    await command("threshold 0");
    await command("end-turn 0%");
    await command("status");

    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages.match(/Usage:/g)).toHaveLength(2);
    expect(messages).toContain("adaptive target: 50%");
    expect(messages).toContain("200K tokens or 40% of context window");
    await expect(fs.readFile(path.join(agentDir!, "pi-ac", "threshold.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(agentDir!, "pi-ac", "end-turn.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves off aliases, case handling, and fractional adaptive values", async () => {
    const { ctx, command } = harness();
    await command("threshold 65.5");
    expect(JSON.parse(await fs.readFile(path.join(agentDir!, "pi-ac", "threshold.json"), "utf8")))
      .toEqual({ version: 1, value: 65.5 });
    await command("threshold NoNe");
    await command("end-turn 75%");
    await command("end-turn OFF");
    await command("status");

    const status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("adaptive target: Pi threshold");
    expect(status).toContain("end-of-turn compaction: off");
    expect(JSON.parse(await fs.readFile(path.join(agentDir!, "pi-ac", "threshold.json"), "utf8")))
      .toEqual({ version: 1, value: null });
    expect(JSON.parse(await fs.readFile(path.join(agentDir!, "pi-ac", "end-turn.json"), "utf8")))
      .toEqual({ version: 1, value: null });
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

  it("lets Pi CLI flags override saved compactor config without changing it", async () => {
    const userConfigPath = join(testAgentDir, "pi-ac.json");
    writeFileSync(userConfigPath, JSON.stringify({ version: 1, model: "other/active", thinking: "high" }));
    const {
      ctx,
      command,
      startSession,
      alternateModel,
      compactorModel,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      setSessionSelection,
    } = harness({
      compactorModelFlag: "summary/fast/model",
      compactorThinkingFlag: "low",
    });
    await startSession();
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: summary/fast/model");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor thinking: low");
    expect(JSON.parse(readFileSync(userConfigPath, "utf8"))).toEqual({
      version: 1,
      model: "other/active",
      thinking: "high",
    });

    setSessionSelection(alternateModel, "high");
    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(compactorModel);
    expect(compactThinkingLevel()).toBe("low");
    completeCompact();
    await compaction;
  });

  it("validates CLI flags as values, never slash-command actions", async () => {
    const configPath = join(testAgentDir, "pi-ac.json");
    const original = JSON.stringify({ version: 1, model: "summary/fast/model", thinking: "low" });
    writeFileSync(configPath, original);
    for (const flags of [
      { compactorModelFlag: "clear" },
      { compactorModelFlag: "current" },
      { compactorModelFlag: "summary/fast/model off" },
      { compactorThinkingFlag: "low high" },
      { compactorThinkingFlag: "" },
      { compactorModelFlag: "" },
    ]) {
      const session = harness(flags);
      await session.startSession();
      await session.command("status");
      expect(String(session.ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: active model (no switch)");
      expect(session.ctx.ui.notify.mock.calls.some((call: unknown[]) => call[1] === "warning")).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }

    const thinkingOnly = harness({ compactorThinkingFlag: "off" });
    await thinkingOnly.startSession();
    await thinkingOnly.command("status");
    const status = String(thinkingOnly.ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("compactor model: test/model");
    expect(status).toContain("compactor thinking: off");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("preserves saved config and active selection when a write or clear fails", async () => {
    const session = harness();
    await session.command("compactor summary/fast/model low");
    const configPath = join(testAgentDir, "pi-ac.json");
    const original = readFileSync(configPath, "utf8");
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    for (const operation of ["writeFileSync", "renameSync"] as const) {
      vi.spyOn(fsSync, operation).mockImplementationOnce(() => { throw failure; });
      await session.command("compactor current high");
      await session.command("status");
      expect(String(session.ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: summary/fast/model");
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(await fs.readdir(testAgentDir)).toEqual(["pi-ac.json"]);
    }

    vi.spyOn(fsSync, "unlinkSync").mockImplementationOnce(() => { throw failure; });
    await session.command("compactor clear");
    await session.command("status");
    expect(String(session.ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: summary/fast/model");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const messages = session.ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("Could not save compactor; active value is unchanged");
    expect(messages).toContain("Could not clear saved compactor; active value is unchanged");
  });

  it("preserves malformed saved config and the active compactor on subsequent commands", async () => {
    const session = harness();
    await session.command("compactor summary/fast/model low");
    const configPath = join(testAgentDir, "pi-ac.json");
    const original = '{"version":2,"model":"test/model","newField":"preserve"}';
    writeFileSync(configPath, original);
    await session.command("compactor current");
    await session.command("compactor clear");
    await session.command("status");
    expect(String(session.ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: summary/fast/model");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(session.ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
      .toContain("repair or remove this file manually");
  });

  it("does not touch an unowned temporary path after exclusive creation fails", async () => {
    const session = harness();
    await session.command("compactor summary/fast/model low");
    let collisionPath = "";
    vi.spyOn(fsSync, "openSync").mockImplementationOnce((path) => {
      collisionPath = String(path);
      writeFileSync(collisionPath, "not owned by this save");
      throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    });
    await session.command("compactor current");
    expect(readFileSync(collisionPath, "utf8")).toBe("not owned by this save");
    expect(JSON.parse(readFileSync(join(testAgentDir, "pi-ac.json"), "utf8")))
      .toEqual({ version: 1, model: "summary/fast/model", thinking: "low" });
  });

  it("does not redirect project storage errors to the user-wide config", async () => {
    const session = harness();
    const projectDir = join(session.cwd, ".pi");
    mkdirSync(projectDir, { recursive: true });
    const userPath = join(testAgentDir, "pi-ac.json");
    const original = JSON.stringify({ version: 1, model: "summary/fast/model" });
    writeFileSync(userPath, original);
    const stat = fsSync.statSync;
    vi.spyOn(fsSync, "statSync").mockImplementation(((path: string, ...args: any[]) => {
      if (path === projectDir) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return (stat as any)(path, ...args);
    }) as typeof fsSync.statSync);
    await session.startSession();
    await session.command("compactor current");
    await session.command("status");
    expect(String(session.ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: active model (no switch)");
    expect(readFileSync(userPath, "utf8")).toBe(original);
    expect(session.ctx.ui.notify.mock.calls.some((call: unknown[]) => call[1] === "warning")).toBe(true);
  });

  it("persists the active model across sessions and clears the saved config", async () => {
    const userConfigPath = join(testAgentDir, "pi-ac.json");
    const { ctx, command, activeModel, startSession } = harness();
    await command("compactor current");
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: test/model");
    expect(JSON.parse(readFileSync(userConfigPath, "utf8"))).toEqual({ version: 1, model: "test/model" });

    await command("compactor clear");
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: active model (no switch)");
    expect(existsSync(userConfigPath)).toBe(false);

    await command("compactor current");
    await startSession();
    await command("status");
    expect(ctx.model).toBe(activeModel);
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: test/model");
  });

  it("prefers trusted project config and falls back to the user config after project clear", async () => {
    const userConfigPath = join(testAgentDir, "pi-ac.json");
    writeFileSync(userConfigPath, JSON.stringify({ version: 1, model: "summary/fast/model", thinking: "low" }));
    const first = harness();
    const projectConfigPath = join(first.cwd, ".pi", "pi-ac.json");
    mkdirSync(join(first.cwd, ".pi"), { recursive: true });
    await first.command("compactor limited/off-only off");
    expect(JSON.parse(readFileSync(projectConfigPath, "utf8"))).toEqual({
      version: 1,
      model: "limited/off-only",
      thinking: "off",
    });

    await first.startSession();
    await first.command("status");
    let status = String(first.ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("compactor model: limited/off-only");
    expect(status).toContain("compactor thinking: off");

    await first.command("compactor clear");
    expect(existsSync(projectConfigPath)).toBe(false);
    expect(existsSync(userConfigPath)).toBe(true);

    const reopened = harness();
    await reopened.startSession();
    await reopened.command("status");
    status = String(reopened.ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("compactor model: summary/fast/model");
    expect(status).toContain("compactor thinking: low");
  });

  it("ignores project config when the project is not trusted", async () => {
    writeFileSync(join(testAgentDir, "pi-ac.json"), JSON.stringify({ version: 1, model: "summary/fast/model" }));
    const untrusted = harness();
    const projectConfigDir = join(untrusted.cwd, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, "pi-ac.json"), JSON.stringify({ version: 1, model: "limited/off-only" }));

    const session = harness({ cwd: untrusted.cwd, projectTrusted: false });
    await session.startSession();
    await session.command("status");
    expect(String(session.ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: summary/fast/model");
  });

  it("warns on invalid project config without loading the user override or changing files", async () => {
    writeFileSync(join(testAgentDir, "pi-ac.json"), JSON.stringify({ version: 1, model: "summary/fast/model" }));
    const projectDir = join(testAgentDir, "project", ".pi");
    mkdirSync(projectDir, { recursive: true });
    const configPath = join(projectDir, "pi-ac.json");
    for (const contents of [
      "{broken", "[]", '{"version":2,"model":"test/model"}',
      '{"version":1,"model":"missing/model"}',
      '{"version":1,"model":"test/model","thinking":false}',
      '{"version":1,"model":"test/model","thinking":"not-a-level"}',
    ]) {
      writeFileSync(configPath, contents);
      const session = harness();
      await session.startSession();
      await session.command("status");
      const status = String(session.ctx.ui.notify.mock.calls.at(-1)?.[0]);
      expect(status).toContain("compactor model: active model (no switch)");
      expect(status).toContain("compactor thinking: active session level");
      expect(session.ctx.ui.notify.mock.calls.some((call: unknown[]) => call[1] === "warning")).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(contents);
    }
  });

  it("uses the active model after clear without overwriting later user selection", async () => {
    const { pi, ctx, command, activeModel, alternateModel, completeCompact, compactModel, setSessionSelection, thinkingLevel } = harness();
    await command("compactor current");
    await command("compactor clear");
    ctx.model = alternateModel;

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(alternateModel);
    setSessionSelection(activeModel, "low");
    completeCompact();
    await compaction;
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(ctx.model).toBe(activeModel);
    expect(thinkingLevel()).toBe("low");
  });

  it("falls back to the active model if the saved compactor cannot be selected", async () => {
    const {
      pi,
      ctx,
      command,
      alternateModel,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      setSessionSelection,
    } = harness();
    await command("compactor current");
    setSessionSelection(alternateModel, "medium");
    pi.setModel.mockResolvedValueOnce(false);

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(alternateModel);
    expect(compactThinkingLevel()).toBe("medium");
    expect(ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
      .toContain("WARNING: Could not activate compactor model test/model");
    completeCompact();
    await compaction;
  });

  it("persists thresholds and compactor but resets delay and enable state", async () => {
    const { ctx, command, startSession } = harness();
    await command("end-turn-delay 5");
    await command("end-turn 120000");
    await command("end-turn default");
    await command("status");
    let status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("200K tokens or 40% of context window (whichever is higher)");

    await command("end-turn off");
    await command("status");
    status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("end-of-turn compaction: off");
    expect(status).toContain("end-of-turn delay: 5 minutes");

    await command("end-turn 120000");
    await command("end-turn-delay 5");
    await command("disable");
    await command("compactor current");
    await startSession();
    await command("status");
    status = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("end-of-turn compaction: 120,000 tokens");
    expect(status).toContain("end-of-turn delay: 10 minutes");
    expect(status).toContain("automatic compaction enabled");
    expect(status).toContain("compactor model: test/model");
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
    await command("end-turn 70000");
    await command("end-turn-delay 0");
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

  it("keeps a pending timer after a failed off save and cancels it after a successful save", async () => {
    vi.useFakeTimers();
    try {
      const failedOff = harness();
      await failedOff.command("end-turn 70000");
      await failedOff.command("end-turn-delay 1");
      failedOff.startRun();
      failedOff.turn(40_000);
      failedOff.turn(75_000, false);
      await failedOff.settle();

      const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      vi.spyOn(fs, "open").mockRejectedValueOnce(failure);
      await failedOff.command("end-turn off");
      await failedOff.command("status");
      expect(String(failedOff.ctx.ui.notify.mock.calls.at(-1)?.[0]))
        .toContain("end-of-turn compaction: 70,000 tokens");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(failedOff.ctx.compact).toHaveBeenCalledTimes(1);
      failedOff.completeCompact();

      const successfulOff = harness();
      await successfulOff.command("end-turn 70000");
      await successfulOff.command("end-turn-delay 1");
      successfulOff.startRun();
      successfulOff.turn(40_000);
      successfulOff.turn(75_000, false);
      await successfulOff.settle();
      await successfulOff.command("end-turn off");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(successfulOff.ctx.compact).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured compactor model and thinking at end-of-turn settlement", async () => {
    const {
      pi,
      ctx,
      command,
      activeModel,
      alternateModel,
      startRun,
      turn,
      settle,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      thinkingLevel,
    } = harness();
    await command("compactor current low");
    ctx.model = alternateModel;
    await command("end-turn 75%");
    await command("end-turn-delay 0");
    startRun();
    turn(75_000, false);
    const settling = settle();
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(activeModel);
    expect(compactThinkingLevel()).toBe("low");
    completeCompact();
    await settling;
    expect(ctx.model).toBe(alternateModel);
    expect(thinkingLevel()).toBe("high");
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

  it("configures a model slug and thinking level for manual compaction", async () => {
    const {
      pi,
      ctx,
      command,
      alternateModel,
      compactorModel,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      thinkingLevel,
      setSessionSelection,
    } = harness();
    await command("compactor summary/fast/model low");
    setSessionSelection(alternateModel, "high");

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(compactorModel);
    expect(compactThinkingLevel()).toBe("low");
    completeCompact();
    await compaction;

    expect(ctx.model).toBe(alternateModel);
    expect(thinkingLevel()).toBe("high");
    expect(pi.setModel).toHaveBeenNthCalledWith(1, compactorModel);
    expect(pi.setModel).toHaveBeenNthCalledWith(2, alternateModel);
  });

  it("falls back to the active model for an invalid model slug or thinking level", async () => {
    const {
      ctx,
      command,
      alternateModel,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      setSessionSelection,
    } = harness();
    await command("compactor missing/model high");
    setSessionSelection(alternateModel, "medium");

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(alternateModel);
    expect(compactThinkingLevel()).toBe("medium");
    completeCompact();
    await compaction;
    expect(ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
      .toContain("WARNING: Compactor model slug \"missing/model\" is invalid or unavailable.");

    await command("compactor summary/fast/model not-a-level");
    expect(ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
      .toContain("WARNING: Invalid compactor thinking level.");
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0])).toContain("compactor model: active model (no switch)");
  });

  it("falls back when the requested thinking level is unsupported by the compactor", async () => {
    const {
      ctx,
      command,
      alternateModel,
      limitedModel,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      setSessionSelection,
    } = harness();
    await command("compactor limited/off-only high");
    setSessionSelection(alternateModel, "medium");

    const compaction = command("compact");
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(alternateModel);
    expect(compactThinkingLevel()).toBe("medium");
    expect(ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
      .toContain("WARNING: Thinking level high is not supported by compactor model limited/off-only");
    completeCompact();
    await compaction;
    expect(ctx.model).toBe(alternateModel);
  });

  it("uses a configured thinking level during automatic compaction and restores it", async () => {
    const {
      pi,
      ctx,
      command,
      activeModel,
      startRun,
      turn,
      settle,
      completeCompact,
      compactModel,
      compactThinkingLevel,
      thinkingLevel,
    } = harness();
    await command("compactor current low");
    startRun();
    turn(40_000);
    turn(70_000);

    expect(ctx.abort).toHaveBeenCalledTimes(1);
    const settling = settle(true);
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    expect(compactModel()).toBe(activeModel);
    expect(compactThinkingLevel()).toBe("low");
    completeCompact();
    await settling;
    expect(thinkingLevel()).toBe("high");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("restores selection after compactor failure and never retries cancelled work", async () => {
    for (const aborted of [false, true]) {
      const session = harness();
      await session.command("compactor summary/fast/model low");
      session.startRun();
      const compaction = session.command("compact");
      const settling = session.settle(true);
      await vi.waitFor(() => expect(session.ctx.compact).toHaveBeenCalledTimes(1));
      session.failCompact(aborted);
      await settling;
      await compaction;
      expect(session.ctx.model).toBe(session.activeModel);
      expect(session.thinkingLevel()).toBe("high");
      expect(session.pi.sendUserMessage).toHaveBeenCalledTimes(aborted ? 0 : 1);
      const switches = session.pi.setModel.mock.calls.length;
      session.turn(70_000);
      expect(session.pi.setModel).toHaveBeenCalledTimes(switches);
      expect(session.ctx.compact).toHaveBeenCalledTimes(1);
    }
  });

  it("does not resume if the original model or thinking level cannot be restored", async () => {
    for (const failure of ["model", "thinking"]) {
      const session = harness();
      await session.command("compactor summary/fast/model low");
      session.startRun();
      const compaction = session.command("compact");
      const settling = session.settle(true);
      await vi.waitFor(() => expect(session.ctx.compact).toHaveBeenCalledTimes(1));
      if (failure === "model") session.pi.setModel.mockResolvedValueOnce(false);
      else session.pi.setThinkingLevel.mockImplementation(() => {});
      session.completeCompact();
      await settling;
      await compaction;
      expect(session.pi.sendUserMessage).not.toHaveBeenCalled();
      expect(session.ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n"))
        .toContain(failure === "model" ? "Could not restore test/model" : "Could not restore thinking level high");
    }
  });

  it("ignores old compaction completions after shutdown and resolves deferred commands", async () => {
    const session = harness();
    await session.command("compactor summary/fast/model low");
    session.startRun();
    const deferred = session.command("compact");
    session.shutdownSession();
    await deferred;
    await session.startSession();
    await session.settle(true);
    expect(session.ctx.compact).not.toHaveBeenCalled();

    session.startRun();
    const compaction = session.command("compact");
    const settling = session.settle(true);
    await vi.waitFor(() => expect(session.ctx.compact).toHaveBeenCalledTimes(1));
    session.shutdownSession();
    session.setSessionSelection(session.alternateModel, "medium");
    await session.startSession();
    session.completeCompact();
    await settling;
    await compaction;
    expect(session.ctx.model).toBe(session.alternateModel);
    expect(session.thinkingLevel()).toBe("medium");
    expect(session.pi.sendUserMessage).not.toHaveBeenCalled();
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
    await aborted.command("end-turn 80%");
    aborted.startRun();
    aborted.turn(90_000, false, [], "aborted");
    await aborted.settle(true);
    expect(aborted.ctx.compact).not.toHaveBeenCalled();

    const failed = harness();
    await failed.command("end-turn 80%");
    failed.startRun();
    failed.turn(90_000, false, [], "error");
    await failed.settle();
    expect(failed.ctx.compact).not.toHaveBeenCalled();

    const alreadyCompacted = harness();
    await alreadyCompacted.command("end-turn 80%");
    alreadyCompacted.startRun();
    alreadyCompacted.turn(90_000, false);
    alreadyCompacted.noteCompaction();
    await alreadyCompacted.settle();
    expect(alreadyCompacted.ctx.compact).not.toHaveBeenCalled();

    const compactedThenContinued = harness();
    await compactedThenContinued.command("end-turn 80%");
    await compactedThenContinued.command("end-turn-delay 0");
    compactedThenContinued.startRun();
    compactedThenContinued.turn(60_000, false);
    compactedThenContinued.noteCompaction();
    compactedThenContinued.turn(90_000, false);
    const settling = compactedThenContinued.settle();
    expect(compactedThenContinued.ctx.compact).toHaveBeenCalledTimes(1);
    compactedThenContinued.completeCompact();
    await settling;

    const queued = harness();
    await queued.command("end-turn 80%");
    queued.ctx.hasPendingMessages.mockReturnValue(true);
    queued.startRun();
    queued.turn(90_000, false);
    await queued.settle();
    expect(queued.ctx.compact).not.toHaveBeenCalled();

    const piDisabled = harness({ enabled: false });
    await piDisabled.command("end-turn 80%");
    piDisabled.startRun();
    piDisabled.turn(90_000, false);
    await piDisabled.settle();
    expect(piDisabled.ctx.compact).not.toHaveBeenCalled();
  });

  it("disables end-of-turn compaction with /ac disable", async () => {
    const { ctx, command, startRun, turn, settle } = harness();
    await command("end-turn 70%");
    await command("disable");
    startRun();
    turn(80_000, false);
    await settle();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("sets and restores the default adaptive threshold through /ac threshold", async () => {
    const { ctx, command, turn } = harness();
    await command("threshold 60");
    turn(40_000);
    turn(59_000);
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    await command("threshold default");
    await command("status");
    expect(String(ctx.ui.notify.mock.calls.at(-1)?.[0]))
      .toContain("adaptive target: 50% or 230K tokens (whichever is lower; ~50K)");
  });

  it("loads the saved adaptive threshold and uses it for compaction", async () => {
    await saveAdaptiveThreshold(agentDir!, 65);
    const below = harness();
    await below.startSession();
    below.turn(60_000);
    expect(below.ctx.compact).not.toHaveBeenCalled();

    const atThreshold = harness();
    await atThreshold.startSession();
    atThreshold.turn(65_000);
    expect(atThreshold.ctx.compact).toHaveBeenCalledTimes(1);
    atThreshold.completeCompact();
  });

  it("loads end-of-turn token and percentage thresholds for settlement", async () => {
    await saveEndOfTurnThreshold(agentDir!, { unit: "tokens", value: 70_000 });
    const absolute = harness();
    await absolute.startSession();
    await absolute.command("end-turn-delay 0");
    absolute.startRun();
    absolute.turn(40_000);
    absolute.turn(75_000, false);
    const absoluteSettling = absolute.settle();
    expect(absolute.ctx.compact).toHaveBeenCalledTimes(1);
    absolute.completeCompact();
    await absoluteSettling;

    await saveEndOfTurnThreshold(agentDir!, { unit: "percent", value: 75 });
    const percentage = harness();
    await percentage.startSession();
    await percentage.command("end-turn-delay 0");
    percentage.startRun();
    percentage.turn(40_000);
    percentage.turn(75_000, false);
    const percentageSettling = percentage.settle();
    expect(percentage.ctx.compact).toHaveBeenCalledTimes(1);
    percentage.completeCompact();
    await percentageSettling;
  });

  it("keeps the default end-of-turn minimum but not on custom 40%", async () => {
    const builtIn = harness();
    await builtIn.startSession();
    await builtIn.command("end-turn-delay 0");
    builtIn.startRun();
    builtIn.turn(40_000);
    builtIn.turn(75_000, false);
    await builtIn.settle();
    expect(builtIn.ctx.compact).not.toHaveBeenCalled();

    await saveEndOfTurnThreshold(agentDir!, { unit: "percent", value: 40 });
    const custom = harness();
    await custom.startSession();
    await custom.command("end-turn-delay 0");
    custom.startRun();
    custom.turn(40_000);
    custom.turn(75_000, false);
    const settling = custom.settle();
    expect(custom.ctx.compact).toHaveBeenCalledTimes(1);
    custom.completeCompact();
    await settling;

    const endTurnPath = path.join(agentDir!, "pi-ac", "end-turn.json");
    await writeFile(endTurnPath, '{"version":2,"value":{"unit":"percent","value":40}}');
    const invalid = harness();
    await invalid.startSession();
    await invalid.command("end-turn-delay 0");
    invalid.startRun();
    invalid.turn(40_000);
    invalid.turn(75_000, false);
    await invalid.settle();
    expect(invalid.ctx.compact).not.toHaveBeenCalled();
  });

  it("loads each threshold independently when the other file is invalid", async () => {
    const adaptivePath = path.join(agentDir!, "pi-ac", "threshold.json");
    await mkdir(path.dirname(adaptivePath), { recursive: true });
    await writeFile(adaptivePath, "invalid");
    await saveEndOfTurnThreshold(agentDir!, { unit: "percent", value: 75 });

    const { ctx, command, startSession } = harness({ noContextUsage: true });
    await startSession();
    await command("status");

    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("Could not load adaptive threshold");
    expect(messages).toContain("end-of-turn compaction: 75% of context window");
  });

  it("falls back on one unreadable setting and still loads the other", async () => {
    await saveEndOfTurnThreshold(agentDir!, { unit: "percent", value: 75 });
    const failure = Object.assign(new Error("blocked"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);

    const { ctx, command, startSession } = harness({ noContextUsage: true });
    await startSession();
    await command("status");

    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("Could not load adaptive threshold");
    expect(messages).toContain("adaptive target: 50%");
    expect(messages).toContain("end-of-turn compaction: 75% of context window");
  });

  it("treats ENOTDIR as a startup error and uses complete defaults", async () => {
    const blockedAgentDir = path.join(agentDir!, "not-a-directory");
    await writeFile(blockedAgentDir, "block");
    vi.stubEnv("PI_CODING_AGENT_DIR", blockedAgentDir);
    const { ctx, command, startSession } = harness({ noContextUsage: true });

    await startSession();
    await command("status");
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("ENOTDIR");
    expect(messages).toContain("adaptive target: 50%");
    expect(messages).toContain("200K tokens or 40% of context window");
  });

  it("refuses to mutate a threshold file that became invalid after startup", async () => {
    await saveAdaptiveThreshold(agentDir!, 65);
    const { ctx, command, startSession } = harness({ noContextUsage: true });
    await startSession();
    const adaptivePath = path.join(agentDir!, "pi-ac", "threshold.json");
    await writeFile(adaptivePath, "{broken");

    await command("threshold 70");
    await command("status");
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("repair this file manually");
    expect(messages).toContain("adaptive target: 65%");
    expect(await fs.readFile(adaptivePath, "utf8")).toBe("{broken");
  });

  it("keeps both active thresholds unchanged when saves fail", async () => {
    const { ctx, command } = harness({ noContextUsage: true });
    await command("threshold 65");
    await command("end-turn 40%");
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);

    await command("threshold 80");
    await command("end-turn 75%");
    await command("status");
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("Could not save adaptive threshold; active value is unchanged");
    expect(messages).toContain("Could not save end-of-turn threshold; active value is unchanged");
    expect(messages).toContain("adaptive target: 65%");
    expect(messages).toContain("end-of-turn compaction: 40% of context window");
    expect(messages).not.toContain("adaptive compaction target set to 80%");
    expect(messages).not.toContain("threshold set to 75% of context window. Saved globally");
  });

  it("preserves active values and the default flag when default removal fails", async () => {
    const { ctx, command } = harness({ noContextUsage: true });
    await command("threshold 65");
    await command("end-turn 40%");
    const failure = Object.assign(new Error("unlink failed"), { code: "EIO" });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);

    await command("threshold default");
    await command("end-turn default");
    await command("status");
    const messages = ctx.ui.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(messages).toContain("Could not save adaptive threshold; active value is unchanged");
    expect(messages).toContain("Could not save end-of-turn threshold; active value is unchanged");
    expect(messages).toContain("adaptive target: 65%");
    expect(messages).toContain("end-of-turn compaction: 40% of context window");
    expect(messages).not.toContain("saved override removed");
  });

  it("shows exactly one adaptive target when context usage is unknown", async () => {
    await saveAdaptiveThreshold(agentDir!, 65);
    const { ctx, command, startSession } = harness({ noContextUsage: true });
    await startSession();
    await command("status");

    const adaptiveLines = String(ctx.ui.notify.mock.calls.at(-1)?.[0])
      .split("\n")
      .filter((line) => line.startsWith("adaptive target:"));
    expect(adaptiveLines).toHaveLength(1);
    expect(adaptiveLines[0]).toContain("adaptive target: 65%");
  });

  it("toggles proactive compaction with /ac enable and disable", async () => {
    const { ctx, command, turn } = harness();
    await command("disable");
    turn(40_000);
    turn(80_000);
    expect(ctx.compact).not.toHaveBeenCalled();

    await command("enable");
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
