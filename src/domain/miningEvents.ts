import type { BlockFoundEvent } from "../miningLogic";

export type MiningEventLevel = "LOW_LEVEL" | "MID_LEVEL" | "HIGH_LEVEL";
export type MiningEventSource = "simulation" | "cpu" | "gpu" | "stratum" | "ui";

export type MiningEvent =
  | {
      level: "LOW_LEVEL";
      type: "hash_attempt";
      source: MiningEventSource;
      timestamp: string;
      payload: {
        count: number;
      };
    }
  | {
      level: "MID_LEVEL";
      type: "share_accepted" | "share_rejected";
      source: MiningEventSource;
      timestamp: string;
      payload: {
        message: string;
      };
    }
  | {
      level: "HIGH_LEVEL";
      type: "block_candidate";
      source: MiningEventSource;
      timestamp: string;
      payload: BlockFoundEvent;
    }
  | {
      level: "HIGH_LEVEL";
      type: "jackpot";
      source: MiningEventSource;
      timestamp: string;
      payload: {
        sequenceId: string;
        block: BlockFoundEvent;
      };
    };

export function createHashAttemptEvent(source: MiningEventSource, count = 1): MiningEvent {
  return {
    level: "LOW_LEVEL",
    type: "hash_attempt",
    source,
    timestamp: new Date().toISOString(),
    payload: { count },
  };
}

export function createShareEvent(
  type: "share_accepted" | "share_rejected",
  source: MiningEventSource,
  message: string,
): MiningEvent {
  return {
    level: "MID_LEVEL",
    type,
    source,
    timestamp: new Date().toISOString(),
    payload: { message },
  };
}

export function createBlockCandidateEvent(source: MiningEventSource, block: BlockFoundEvent): MiningEvent {
  return {
    level: "HIGH_LEVEL",
    type: "block_candidate",
    source,
    timestamp: new Date().toISOString(),
    payload: block,
  };
}

export function createJackpotEvent(block: BlockFoundEvent): MiningEvent {
  return {
    level: "HIGH_LEVEL",
    type: "jackpot",
    source: "ui",
    timestamp: new Date().toISOString(),
    payload: {
      sequenceId: `jackpot-${block.timestamp}-${block.job_id}`,
      block,
    },
  };
}

export function miningEventLabel(event: MiningEvent | null) {
  if (!event) {
    return "Waiting";
  }

  return `${event.level.replace("_LEVEL", "")}: ${event.type.replace(/_/g, " ")}`;
}
