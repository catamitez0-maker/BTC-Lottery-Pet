import type { BlockFoundEvent } from "../miningLogic";
import type { MiningEngineKind } from "../engines/miningEngine";

export type JackpotSequencePhase =
  | "idle"
  | "detect"
  | "pause"
  | "screen_effect"
  | "particles"
  | "reveal"
  | "resume"
  | "complete";

export interface JackpotSequenceSnapshot {
  id: string;
  phase: JackpotSequencePhase;
  block: BlockFoundEvent | null;
  startedAt: number | null;
  wasMining: boolean;
  engineKind: MiningEngineKind | null;
}

export const idleJackpotSequence: JackpotSequenceSnapshot = {
  id: "idle",
  phase: "idle",
  block: null,
  startedAt: null,
  wasMining: false,
  engineKind: null,
};

export function startJackpotSequence(
  block: BlockFoundEvent,
  wasMining: boolean,
  engineKind: MiningEngineKind,
): JackpotSequenceSnapshot {
  return {
    id: `jackpot-${block.timestamp}-${block.job_id}`,
    phase: "detect",
    block,
    startedAt: Date.now(),
    wasMining,
    engineKind,
  };
}

export function nextJackpotPhase(phase: JackpotSequencePhase): JackpotSequencePhase {
  switch (phase) {
    case "idle":
      return "idle";
    case "detect":
      return "pause";
    case "pause":
      return "screen_effect";
    case "screen_effect":
      return "particles";
    case "particles":
      return "reveal";
    case "reveal":
      return "resume";
    case "resume":
      return "complete";
    case "complete":
      return "idle";
  }
}

export function jackpotPhaseDurationMs(phase: JackpotSequencePhase) {
  switch (phase) {
    case "detect":
      return 650;
    case "pause":
      return 650;
    case "screen_effect":
      return 900;
    case "particles":
      return 1200;
    case "reveal":
      return 7000;
    case "resume":
      return null;
    default:
      return null;
  }
}

export function isJackpotOverlayVisible(snapshot: JackpotSequenceSnapshot) {
  return snapshot.phase !== "idle" && snapshot.phase !== "complete" && Boolean(snapshot.block);
}

export function jackpotPhaseLabel(phase: JackpotSequencePhase) {
  switch (phase) {
    case "detect":
      return "Detecting";
    case "pause":
      return "Pausing mining";
    case "screen_effect":
      return "Screen flash";
    case "particles":
      return "Particle burst";
    case "reveal":
      return "Block reveal";
    case "resume":
      return "Resuming";
    case "complete":
      return "Complete";
    case "idle":
      return "Idle";
  }
}
