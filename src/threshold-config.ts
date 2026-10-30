import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { EndOfTurnThreshold } from "./policy.ts";
interface StoredThreshold<T> {
  version: 1;
  value: T;
}

export async function loadAdaptiveThreshold(agentDir: string): Promise<number | null | undefined> {
  return loadThreshold(path.join(agentDir, "pi-ac", "threshold.json"), isAdaptiveThreshold);
}

export async function saveAdaptiveThreshold(
  agentDir: string,
  value: number | null | undefined,
): Promise<void> {
  return saveThreshold(path.join(agentDir, "pi-ac", "threshold.json"), value, isAdaptiveThreshold);
}

export async function loadEndOfTurnThreshold(
  agentDir: string,
): Promise<EndOfTurnThreshold | null | undefined> {
  return loadThreshold(path.join(agentDir, "pi-ac", "end-turn.json"), isEndOfTurnThreshold);
}

export async function saveEndOfTurnThreshold(
  agentDir: string,
  value: EndOfTurnThreshold | null | undefined,
): Promise<void> {
  return saveThreshold(path.join(agentDir, "pi-ac", "end-turn.json"), value, isEndOfTurnThreshold);
}

async function loadThreshold<T>(filePath: string, isValue: (value: unknown) => value is T): Promise<T | undefined> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw storageError("read", filePath, error);
  }

  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}; repair this file manually`);
  }

  if (
    !isRecord(document) ||
    document.version !== 1 ||
    !Object.hasOwn(document, "value") ||
    !isValue(document.value)
  ) {
    throw new Error(`Invalid threshold data in ${filePath}; repair this file manually`);
  }
  return document.value;
}

async function saveThreshold<T>(
  filePath: string,
  value: T | null | undefined,
  isValue: (value: unknown) => value is T,
): Promise<void> {
  if (value !== undefined && value !== null && !isValue(value)) {
    throw new Error(`Invalid threshold value for ${filePath}`);
  }

  try {
    await withFileMutationQueue(filePath, async () => {
      const current = await loadThreshold(filePath, isValue);
      if (value === undefined) {
        if (current === undefined) return;
        try {
          await fs.unlink(filePath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        return;
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${randomUUID()}.tmp`,
      );
      let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let ownsTemporaryFile = false;
      try {
        fileHandle = await fs.open(temporaryPath, "wx", 0o600);
        ownsTemporaryFile = true;
        const contents = `${JSON.stringify({ version: 1, value } satisfies StoredThreshold<typeof value>)}\n`;
        await fileHandle.writeFile(contents, "utf8");
        await fileHandle.close();
        fileHandle = undefined;
        await fs.rename(temporaryPath, filePath);
        ownsTemporaryFile = false;
      } catch (error) {
        if (fileHandle) {
          try {
            await fileHandle.close();
          } catch {
            // Preserve the original write or rename error.
          }
        }
        if (ownsTemporaryFile) {
          try {
            await fs.unlink(temporaryPath);
          } catch {
            // Preserve the original write or rename error.
          }
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid ")) throw error;
    throw storageError("save", filePath, error);
  }
}

function isAdaptiveThreshold(value: unknown): value is number | null {
  return value === null || (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 100
  );
}

function isEndOfTurnThreshold(value: unknown): value is EndOfTurnThreshold | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.unit === "tokens") {
    return typeof value.value === "number" && Number.isSafeInteger(value.value) && value.value > 0;
  }
  return value.unit === "percent" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.value > 0 &&
    value.value <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? errorCode(error.cause) : undefined;
}

function storageError(action: string, filePath: string, cause: unknown): Error {
  const code = errorCode(cause);
  return new Error(`Cannot ${action} ${filePath}${code ? ` (${code})` : ""}`, { cause });
}
