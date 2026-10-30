import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAdaptiveThreshold,
  loadEndOfTurnThreshold,
  saveAdaptiveThreshold,
  saveEndOfTurnThreshold,
} from "../src/threshold-config.ts";
import type { EndOfTurnThreshold } from "../src/policy.ts";

let agentDir: string;
let thresholdDir: string;
let thresholdPath: string;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "pi-ac-threshold-config-"));
  thresholdDir = path.join(agentDir, "pi-ac");
  thresholdPath = path.join(thresholdDir, "threshold.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(agentDir, { recursive: true, force: true });
});

describe("adaptive threshold storage", () => {
  it("round-trips numeric and off values", async () => {
    await saveAdaptiveThreshold(agentDir, 65);
    expect(await loadAdaptiveThreshold(agentDir)).toBe(65);
    expect(await readFile(thresholdPath, "utf8")).toBe('{"version":1,"value":65}\n');

    await saveAdaptiveThreshold(agentDir, null);
    expect(await loadAdaptiveThreshold(agentDir)).toBeNull();
    expect(await readFile(thresholdPath, "utf8")).toBe('{"version":1,"value":null}\n');
  });

  it.each([0.5, 100])("round-trips adaptive boundary value %s", async (value) => {
    await saveAdaptiveThreshold(agentDir, value);
    expect(await loadAdaptiveThreshold(agentDir)).toBe(value);
  });

  it.each([0, -1, 101, Number.NaN, Infinity, "65", true])(
    "rejects invalid adaptive saver input %s",
    async (value) => {
      await expect(saveAdaptiveThreshold(agentDir, value as number)).rejects.toThrow("Invalid threshold value");
    },
  );

  it("stores end-of-turn units without changing the adaptive file", async () => {
    await saveAdaptiveThreshold(agentDir, 65);
    await saveEndOfTurnThreshold(agentDir, { unit: "percent", value: 75 });
    expect(await loadEndOfTurnThreshold(agentDir)).toEqual({ unit: "percent", value: 75 });

    await saveEndOfTurnThreshold(agentDir, { unit: "tokens", value: 70_000 });
    expect(await loadEndOfTurnThreshold(agentDir)).toEqual({ unit: "tokens", value: 70_000 });
    await saveEndOfTurnThreshold(agentDir, null);
    expect(await loadEndOfTurnThreshold(agentDir)).toBeNull();
    expect(await loadAdaptiveThreshold(agentDir)).toBe(65);
  });

  it.each([
    { unit: "tokens", value: 1 },
    { unit: "tokens", value: 70_000 },
    { unit: "tokens", value: Number.MAX_SAFE_INTEGER },
    { unit: "percent", value: 0.5 },
    { unit: "percent", value: 100 },
    null,
  ])("round-trips end-of-turn value %#", async (value) => {
    await saveEndOfTurnThreshold(agentDir, value as EndOfTurnThreshold | null);
    expect(await loadEndOfTurnThreshold(agentDir)).toEqual(value);
  });

  it.each([
    '{"version":1,"value":{"unit":"tokens","value":0}}',
    '{"version":1,"value":{"unit":"tokens","value":-1}}',
    '{"version":1,"value":{"unit":"tokens","value":1.5}}',
    '{"version":1,"value":{"unit":"tokens","value":9007199254740992}}',
    '{"version":1,"value":{"unit":"unknown","value":10}}',
    '{"version":1,"value":{"unit":"percent","value":0}}',
    '{"version":1,"value":{"unit":"percent","value":101}}',
    '{"version":1,"value":{"unit":"percent","value":"75"}}',
  ])("rejects invalid end-of-turn document %s", async (document) => {
    await fs.mkdir(thresholdDir, { recursive: true });
    await writeFile(path.join(thresholdDir, "end-turn.json"), document);
    await expect(loadEndOfTurnThreshold(agentDir)).rejects.toThrow("Invalid threshold data");
  });

  it.each([
    { unit: "tokens", value: 0 },
    { unit: "tokens", value: -1 },
    { unit: "tokens", value: 1.5 },
    { unit: "tokens", value: Number.MAX_SAFE_INTEGER + 1 },
    { unit: "unknown", value: 10 },
    { unit: "percent", value: 0 },
    { unit: "percent", value: 101 },
    { unit: "percent", value: "75" },
  ])("rejects invalid end-of-turn saver input %#", async (value) => {
    await expect(saveEndOfTurnThreshold(agentDir, value as unknown as EndOfTurnThreshold))
      .rejects.toThrow("Invalid threshold value");
  });

  it("returns undefined for a missing file without creating storage", async () => {
    expect(await loadAdaptiveThreshold(agentDir)).toBeUndefined();
    expect(await loadEndOfTurnThreshold(agentDir)).toBeUndefined();
    await saveAdaptiveThreshold(agentDir, undefined);
    await saveAdaptiveThreshold(agentDir, undefined);
    await saveEndOfTurnThreshold(agentDir, undefined);
    await saveEndOfTurnThreshold(agentDir, undefined);
    expect(await readdir(agentDir)).toEqual([]);
  });

  it("removes only the adaptive override for default", async () => {
    await saveAdaptiveThreshold(agentDir, 65);
    await saveEndOfTurnThreshold(agentDir, { unit: "percent", value: 75 });
    const otherFile = path.join(thresholdDir, "end-turn.json");
    const otherContents = await readFile(otherFile, "utf8");

    await saveAdaptiveThreshold(agentDir, undefined);
    await saveAdaptiveThreshold(agentDir, undefined);
    await expect(readFile(thresholdPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(otherFile, "utf8")).toBe(otherContents);
  });

  it.each(["{", "null", "[]", '{"version":1}', '{"value":65}', '{"version":2,"value":65}'])(
    "rejects invalid document %s",
    async (contents) => {
      await fs.mkdir(thresholdDir, { recursive: true });
      await writeFile(thresholdPath, contents);
      await expect(loadAdaptiveThreshold(agentDir)).rejects.toThrow();
    },
  );

  it.each(["0", "-1", "101", '"65"', "true", "1e309"])(
    "rejects invalid stored value %s",
    async (value) => {
      await fs.mkdir(thresholdDir, { recursive: true });
      await writeFile(thresholdPath, `{"version":1,"value":${value}}`);
      await expect(loadAdaptiveThreshold(agentDir)).rejects.toThrow("Invalid threshold data");
    },
  );

  it("does not overwrite an invalid file", async () => {
    await fs.mkdir(thresholdDir, { recursive: true });
    const original = '{"version":2,"value":65}\n';
    await writeFile(thresholdPath, original);

    await expect(saveAdaptiveThreshold(agentDir, 70)).rejects.toThrow("Invalid threshold data");
    await expect(saveAdaptiveThreshold(agentDir, undefined)).rejects.toThrow("Invalid threshold data");
    expect(await readFile(thresholdPath, "utf8")).toBe(original);
  });

  it("does not overwrite or remove an invalid end-of-turn file", async () => {
    await fs.mkdir(thresholdDir, { recursive: true });
    const endTurnPath = path.join(thresholdDir, "end-turn.json");
    const original = '{"version":2,"value":null}\n';
    await writeFile(endTurnPath, original);

    await expect(saveEndOfTurnThreshold(agentDir, { unit: "percent", value: 75 }))
      .rejects.toThrow("Invalid threshold data");
    await expect(saveEndOfTurnThreshold(agentDir, undefined)).rejects.toThrow("Invalid threshold data");
    expect(await readFile(endTurnPath, "utf8")).toBe(original);
  });

  it("reports read failures without treating them as missing", async () => {
    const failure = Object.assign(new Error("blocked"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);

    await expect(loadAdaptiveThreshold(agentDir)).rejects.toThrow("EACCES");
  });

  it("rejects a save when the destination cannot be read", async () => {
    await saveAdaptiveThreshold(agentDir, 50);
    const failure = Object.assign(new Error("blocked"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);

    await expect(saveAdaptiveThreshold(agentDir, 60)).rejects.toThrow("EACCES");
    expect(await readFile(thresholdPath, "utf8")).toBe('{"version":1,"value":50}\n');
  });

  it("preserves the destination and cleans up after a failed write", async () => {
    await saveAdaptiveThreshold(agentDir, 50);
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (filePath, flags, mode) => {
      const handle = await open(filePath, flags, mode);
      vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
      return handle;
    });

    await expect(saveAdaptiveThreshold(agentDir, 60)).rejects.toThrow("ENOSPC");
    expect(await loadAdaptiveThreshold(agentDir)).toBe(50);
    expect(await readdir(thresholdDir)).toEqual(["threshold.json"]);
  });

  it("preserves the destination and cleans up after a failed rename", async () => {
    await saveAdaptiveThreshold(agentDir, 50);
    const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);

    await expect(saveAdaptiveThreshold(agentDir, 60)).rejects.toThrow("EIO");
    expect(await loadAdaptiveThreshold(agentDir)).toBe(50);
    expect(await readdir(thresholdDir)).toEqual(["threshold.json"]);
  });

  it("does not remove a temporary path after exclusive creation reports EEXIST", async () => {
    await saveAdaptiveThreshold(agentDir, 50);
    const failure = Object.assign(new Error("already exists"), { code: "EEXIST" });
    let collisionPath = "";
    vi.spyOn(fs, "open").mockImplementationOnce(async (filePath) => {
      collisionPath = String(filePath);
      await writeFile(collisionPath, "not owned by this save");
      throw failure;
    });

    await expect(saveAdaptiveThreshold(agentDir, 60)).rejects.toThrow("EEXIST");
    expect(await readFile(collisionPath, "utf8")).toBe("not owned by this save");
    expect(await loadAdaptiveThreshold(agentDir)).toBe(50);
  });

  it("preserves a file when default removal fails", async () => {
    await saveAdaptiveThreshold(agentDir, 65);
    const failure = Object.assign(new Error("unlink failed"), { code: "EIO" });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(failure);

    await expect(saveAdaptiveThreshold(agentDir, undefined)).rejects.toThrow("EIO");
    expect(await loadAdaptiveThreshold(agentDir)).toBe(65);
  });

  it("treats ENOTDIR as a storage error rather than a missing override", async () => {
    const blockedAgentDir = path.join(agentDir, "not-a-directory");
    await writeFile(blockedAgentDir, "block");

    await expect(loadAdaptiveThreshold(blockedAgentDir)).rejects.toThrow("ENOTDIR");
  });

  it("serializes same-setting saves and isolates concurrent settings", async () => {
    await Promise.all([
      saveAdaptiveThreshold(agentDir, 60),
      saveAdaptiveThreshold(agentDir, 70),
    ]);
    expect(await loadAdaptiveThreshold(agentDir)).toBe(70);

    await Promise.all([
      saveAdaptiveThreshold(agentDir, 65),
      saveEndOfTurnThreshold(agentDir, { unit: "percent", value: 75 }),
    ]);
    expect(await loadAdaptiveThreshold(agentDir)).toBe(65);
    expect(await loadEndOfTurnThreshold(agentDir)).toEqual({ unit: "percent", value: 75 });
  });
});
