import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type {
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

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
): Promise<T> {
  const client = new RpcClient({
    cliPath,
    cwd: process.cwd(),
    env: { PI_CODING_AGENT_DIR: agentDir },
    args,
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
});
