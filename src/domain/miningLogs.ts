import type { MiningEvent } from "./miningEvents";

export type DevLogSource = "system" | "simulation" | "stratum" | "cpu" | "gpu" | "diagnostic";

export interface DevLogEntry {
  id: string;
  timestamp: string;
  source: DevLogSource;
  message: string;
}

export interface PetLogEntry {
  id: string;
  timestamp: string;
  message: string;
}

function entryId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createDevLogEntry(source: DevLogSource, message: string): DevLogEntry {
  return {
    id: entryId("dev"),
    timestamp: new Date().toISOString(),
    source,
    message,
  };
}

export function createPetLogEntry(message: string): PetLogEntry {
  return {
    id: entryId("pet"),
    timestamp: new Date().toISOString(),
    message,
  };
}

export function petLogMessageFromMiningEvent(event: MiningEvent) {
  switch (event.type) {
    case "hash_attempt":
      return null;
    case "share_accepted":
      return "I feel lucky...";
    case "share_rejected":
      return "That pattern slipped away.";
    case "block_candidate":
      return "Something is happening...";
    case "jackpot":
      return "I found a strange pattern...";
  }
}

export function petLogMessageFromRawLog(message: string) {
  const lower = message.toLowerCase();

  if (lower.includes("connected to pool")) {
    return "I found the pool signal.";
  }

  if (lower.includes("worker authorized successfully")) {
    return "The pool knows my name.";
  }

  if (lower.includes("job received")) {
    return "A fresh puzzle arrived.";
  }

  if (lower.includes("connection error")) {
    return "I lost the pool signal.";
  }

  return null;
}

export function latestPetLogMessage(entry: PetLogEntry | null) {
  return entry?.message ?? "Ready to dream.";
}
