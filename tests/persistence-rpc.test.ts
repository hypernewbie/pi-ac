import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type {
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

type RpcRecord = JsonAgentSessionEvent | RpcExtensionUIRequest;
type NotifyRequest = Extract<RpcExtensionUIRequest, { method: "notify" }>;

const cliPath = path.resolve(
  process.cwd(),
  "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);
const extensionPath = path.resolve(process.cwd(), "src/index.ts");
const args = [
  "--no-session",
  "--offline",
  "--no-approve",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-mcp",
  "--no-context-files",
  "-e",
  extensionPath,
];

async function withClient<T>(
  agentDir: string,
  run: (client: RpcClient, events: RpcRecord[]) => Promise<T>,
  options: { cwd?: string; args?: string[] } = {},
): Promise<T> {
  const client = new RpcClient({
    cliPath,
    cwd: options.cwd ?? process.cwd(),
    env: { PI_CODING_AGENT_DIR: agentDir, HOME: agentDir },
    args: [...args, ...options.args ?? []],
  });
  const events: RpcRecord[] = [];
  const unsubscribe = client.onEvent((event) => events.push(event as RpcRecord));
  try {
    await client.start();
    return await run(client, events);
  } finally {
    unsubscribe();
    await client.stop();
  }
}

function notifications(events: RpcRecord[]): NotifyRequest[] {
  return events.filter(
    (event): event is NotifyRequest => event.type === "extension_ui_request" && event.method === "notify",
  );
}

function expectNoWarningsOrRuns(events: RpcRecord[]): void {
  expect(notifications(events).some(({ notifyType }) => notifyType === "warning" || notifyType === "error"))
    .toBe(false);
  expect(events.some((event) => event.type === "agent_start")).toBe(false);
}

async function expectRestartStatus(
  commands: string[],
  checkSavedFiles: (agentDir: string) => Promise<void>,
  statusFragments: string[],
): Promise<void> {
  await access(cliPath);
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-ac-rpc-"));
  try {
    await withClient(agentDir, async (client, events) => {
      for (const command of commands) expect(await client.prompt(command)).toBe("handled");
      expectNoWarningsOrRuns(events);
      await checkSavedFiles(agentDir);
    });

    await withClient(agentDir, async (client, events) => {
      expect(await client.prompt("/ac status")).toBe("handled");
      const status = notifications(events).map(({ message }) => message).join("\n");
      for (const fragment of statusFragments) expect(status).toContain(fragment);
      expectNoWarningsOrRuns(events);
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

describe("threshold persistence across Pi processes", () => {
  it("saves both thresholds and reports them in a fresh process", async () => {
    await access(cliPath);
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-ac-rpc-"));

    try {
      const disposition = await withClient(agentDir, async (client, events) => {
        const result = await client.prompt("/ac threshold 65");
        expect(result).toBe("handled");
        expect(notifications(events).map(({ message }) => message).join("\n"))
          .toContain("Saved globally for future sessions");
        expectNoWarningsOrRuns(events);
        expect(JSON.parse(await readFile(path.join(agentDir, "pi-ac", "threshold.json"), "utf8")))
          .toEqual({ version: 1, value: 65 });

        expect(await client.prompt("/ac end-turn 75%")).toBe("handled");
        expect(notifications(events).map(({ message }) => message).join("\n"))
          .toContain("75% of context window. Saved globally for future sessions");
        expect(JSON.parse(await readFile(path.join(agentDir, "pi-ac", "end-turn.json"), "utf8")))
          .toEqual({ version: 1, value: { unit: "percent", value: 75 } });
        expectNoWarningsOrRuns(events);
        return result;
      });

      const status = await withClient(agentDir, async (client, events) => {
        const result = await client.prompt("/ac status");
        expect(result).toBe("handled");
        const messages = notifications(events).map(({ message }) => message).join("\n");
        expect(messages).toContain("adaptive target: 65%");
        expect(messages).toContain("end-of-turn compaction: 75% of context window");
        expectNoWarningsOrRuns(events);
        return messages;
      });

      console.info(`RPC persistence: process A=${disposition}; process B reports adaptive target 65% and end-turn 75%`);
      expect(status).toContain("adaptive target: 65%");
      expect(status).toContain("end-of-turn compaction: 75% of context window");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("persists off values as null across Pi processes", async () => {
    await expectRestartStatus(
      ["/ac threshold off", "/ac end-turn off"],
      async (agentDir) => {
        expect(JSON.parse(await readFile(path.join(agentDir, "pi-ac", "threshold.json"), "utf8")))
          .toEqual({ version: 1, value: null });
        expect(JSON.parse(await readFile(path.join(agentDir, "pi-ac", "end-turn.json"), "utf8")))
          .toEqual({ version: 1, value: null });
      },
      ["adaptive target: Pi threshold", "end-of-turn compaction: off"],
    );
  }, 180_000);

  it("removes both overrides for default across Pi processes", async () => {
    await expectRestartStatus(
      ["/ac threshold 65", "/ac end-turn 75%", "/ac threshold default", "/ac end-turn default"],
      async (agentDir) => {
        await expect(readFile(path.join(agentDir, "pi-ac", "threshold.json")))
          .rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(agentDir, "pi-ac", "end-turn.json")))
          .rejects.toMatchObject({ code: "ENOENT" });
      },
      [
        "adaptive target: 50% or 230K tokens (whichever is lower)",
        "end-of-turn compaction: 200K tokens or 40% of context window (whichever is higher)",
      ],
    );
  }, 180_000);

  it("persists an absolute end-of-turn token threshold across Pi processes", async () => {
    await expectRestartStatus(
      ["/ac end-turn 70000"],
      async (agentDir) => {
        expect(JSON.parse(await readFile(path.join(agentDir, "pi-ac", "end-turn.json"), "utf8")))
          .toEqual({ version: 1, value: { unit: "tokens", value: 70_000 } });
      },
      ["end-of-turn compaction: 70,000 tokens"],
    );
  }, 180_000);

  it("persists scoped compactors and restores the session after real summary requests and HTTP failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-ac-compactor-rpc-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const requests: { model: string; effort: string }[] = [];
    let failSummary = false;
    let holdSummary = false;
    const server = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const data = JSON.parse(body);
        requests.push({ model: data.model, effort: data.reasoning_effort });
        if (failSummary && data.model === "summary") {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "test endpoint unavailable" } }));
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (holdSummary && data.model === "summary") {
          response.flushHeaders();
          return;
        }
        const text = data.model === "summary" ? "## Goal\nContinue the test task." : "Turn complete.";
        response.write(`data: ${JSON.stringify({
          id: "test", object: "chat.completion.chunk", model: data.model,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        })}\n\n`);
        response.end(`data: ${JSON.stringify({
          id: "test", object: "chat.completion.chunk", model: data.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\ndata: [DONE]\n\n`);
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback listener");
      await mkdir(agentDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
        providers: {
          "ac-test": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions", apiKey: "local-test-only",
            compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
            models: ["main", "summary"].map((id) => ({ id, reasoning: true, contextWindow: 100_000, maxTokens: 1024 })),
          },
        },
      }));
      await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
        compaction: { keepRecentTokens: 0 }, retry: { enabled: false, maxRetries: 0 },
      }));
      const launch = { cwd, args: ["--approve", "--provider", "ac-test", "--model", "main", "--thinking", "high"] };
      const userPath = path.join(agentDir, "pi-ac.json");
      await withClient(agentDir, async (client, events) => {
        expect(await client.prompt("/ac compactor ac-test/summary low")).toBe("handled");
        expect(JSON.parse(await readFile(userPath, "utf8")))
          .toEqual({ version: 1, model: "ac-test/summary", thinking: "low" });
        expectNoWarningsOrRuns(events);
      }, launch);

      await withClient(agentDir, async (client, events) => {
        expect(await client.prompt("/ac status")).toBe("handled");
        expect(notifications(events).map(({ message }) => message).join("\n"))
          .toContain("compactor thinking: low");
        await client.promptAndWait("First test turn.");
        await client.promptAndWait("Second test turn.");
        expect(await client.prompt("/ac compact")).toBe("handled");
        const summaries = requests.filter(({ model }) => model === "summary");
        expect(summaries.length).toBeGreaterThan(0);
        expect(summaries.every(({ effort }) => effort === "low")).toBe(true);
        expect(requests.filter(({ model }) => model === "main").every(({ effort }) => effort === "high")).toBe(true);
        expect(events.some((event) => event.type === "compaction_end" && event.result !== undefined)).toBe(true);
        const restored = await client.getState();
        expect(restored.model?.id).toBe("main");
        expect(restored.thinkingLevel).toBe("high");

        await client.promptAndWait("Third test turn.");
        failSummary = true;
        expect(await client.prompt("/ac compact")).toBe("handled");
        const afterFailure = await client.getState();
        expect(afterFailure.model?.id).toBe("main");
        expect(afterFailure.thinkingLevel).toBe("high");
        expect(afterFailure.pendingMessageCount).toBe(0);
        expect(requests.filter(({ model }) => model === "summary")).toHaveLength(summaries.length + 1);
        expect(notifications(events).some(({ message }) => message.includes("Compaction failed"))).toBe(true);

        failSummary = false;
        holdSummary = true;
        await client.promptAndWait("Fourth test turn.");
        const countBeforeAbort = requests.length;
        const compacting = client.prompt("/ac compact");
        await vi.waitFor(() => expect(requests.length).toBeGreaterThan(countBeforeAbort), { timeout: 5000 });
        await client.abort();
        expect(await compacting).toBe("handled");
        const afterAbort = await client.getState();
        expect(afterAbort.model?.id).toBe("main");
        expect(afterAbort.thinkingLevel).toBe("high");
        expect(afterAbort.pendingMessageCount).toBe(0);
        expect(requests).toHaveLength(countBeforeAbort + 1);
      }, launch);

      await mkdir(path.join(cwd, ".pi"));
      const projectPath = path.join(cwd, ".pi", "pi-ac.json");
      await withClient(agentDir, async (client) => {
        expect(await client.prompt("/ac compactor current off")).toBe("handled");
        expect(JSON.parse(await readFile(projectPath, "utf8")))
          .toEqual({ version: 1, model: "ac-test/main", thinking: "off" });
        expect(JSON.parse(await readFile(userPath, "utf8")))
          .toEqual({ version: 1, model: "ac-test/summary", thinking: "low" });
      }, launch);
      await withClient(agentDir, async (client, events) => {
        await client.prompt("/ac status");
        expect(notifications(events).map(({ message }) => message).join("\n"))
          .toContain("compactor model: ac-test/main\ncompactor thinking: off");
        await client.prompt("/ac compactor clear");
        await expect(readFile(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
      }, launch);
      await withClient(agentDir, async (client, events) => {
        await client.prompt("/ac status");
        expect(notifications(events).map(({ message }) => message).join("\n"))
          .toContain("compactor model: ac-test/summary\ncompactor thinking: low");
        expectNoWarningsOrRuns(events);
      }, launch);
      console.info("RPC compactor: user/project restart, summary/low, main/high restored after success, HTTP 503, and stalled-stream cancellation");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
