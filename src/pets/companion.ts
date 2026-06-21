import type { MiningEvent } from "../domain/miningEvents";
import type { PetState, PetStatus } from "../domain/petState";
import type { ComputeMode } from "../miningLogic";
import type { PetProfile } from "./profiles.js";

export type PetMood =
  | "resting"
  | "curious"
  | "focused"
  | "hyped"
  | "proud"
  | "stressed"
  | "recovering";

export interface PetCareMeter {
  label: string;
  value: number;
}

export interface PetCompanionSnapshot {
  profileId: string;
  name: string;
  species: string;
  trait: string;
  favoriteSignal: string;
  mood: PetMood;
  moodLabel: string;
  reaction: string;
  need: string;
  latestSignal: string;
  care: {
    energy: PetCareMeter;
    bond: PetCareMeter;
    focus: PetCareMeter;
  };
  badges: [string, string][];
  ariaLabel: string;
}

export interface PetCompanionContext {
  profile: PetProfile;
  petState: PetState;
  petStatus: PetStatus;
  isMining: boolean;
  realModeEnabled: boolean;
  computeMode: ComputeMode;
  connectionStatus: string;
  latestLog: string;
  lastEvent: MiningEvent | null;
  acceptedShares: number;
  rejectedShares: number;
  bestDifficulty: number;
  hashrate: number;
  luckMeter: number;
  miningUptimeSeconds: number;
  appUptimeSeconds: number;
}

const moodLabels: Record<PetMood, string> = {
  resting: "Resting",
  curious: "Curious",
  focused: "Focused",
  hyped: "Hyped",
  proud: "Proud",
  stressed: "Needs help",
  recovering: "Cooling",
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function compactEventLabel(event: MiningEvent | null) {
  if (!event) {
    return null;
  }

  return event.type.replace(/_/g, " ");
}

export function petMoodFromStatus(status: PetStatus): PetMood {
  switch (status) {
    case "Sleeping":
      return "resting";
    case "Connecting":
      return "curious";
    case "Mining":
      return "focused";
    case "Overdrive":
      return "hyped";
    case "Lucky Flash":
    case "New Best Diff":
    case "Jackpot":
      return "proud";
    case "Cooling Down":
      return "recovering";
    case "Connection Error":
      return "stressed";
  }
}

function reactionForStatus(profile: PetProfile, status: PetStatus, lastEvent: MiningEvent | null) {
  const voice = profile.personality.voice;

  if (lastEvent?.type === "share_rejected") {
    return voice.rejected;
  }

  switch (status) {
    case "Sleeping":
      return voice.idle;
    case "Connecting":
      return voice.connecting;
    case "Mining":
      return voice.mining;
    case "Overdrive":
      return voice.overdrive;
    case "Lucky Flash":
    case "New Best Diff":
      return voice.lucky;
    case "Jackpot":
      return voice.jackpot;
    case "Cooling Down":
      return voice.coolingDown;
    case "Connection Error":
      return voice.error;
  }
}

function needForMood(mood: PetMood, realModeEnabled: boolean, connectionStatus: string) {
  switch (mood) {
    case "resting":
      return "Pick a run or let it idle.";
    case "curious":
      return realModeEnabled ? `Handshake: ${connectionStatus || "Starting"}` : "Simulation is warming up.";
    case "focused":
      return "Keep the run steady.";
    case "hyped":
      return "Watch GPU pressure.";
    case "proud":
      return "Check the latest signal.";
    case "stressed":
      return "Pool, GPU, or network needs attention.";
    case "recovering":
      return "Give the cabinet a moment.";
  }
}

export function derivePetCompanionSnapshot(context: PetCompanionContext): PetCompanionSnapshot {
  const mood = petMoodFromStatus(context.petStatus);
  const accepted = Math.max(0, context.acceptedShares);
  const rejected = Math.max(0, context.rejectedShares);
  const bestDifficultyScore = Math.min(18, Math.log10(Math.max(1, context.bestDifficulty)) * 6);
  const hashrateScore = context.hashrate > 0
    ? Math.min(24, Math.log10(context.hashrate) * 3)
    : 0;
  const miningDrain = context.isMining
    ? Math.min(30, context.miningUptimeSeconds / 90 + (context.computeMode === "gpu" ? 8 : 0))
    : 0;
  const restingGain = context.isMining ? 0 : Math.min(18, context.appUptimeSeconds / 120);

  const energy = clampPercent(
    58 +
      restingGain -
      miningDrain +
      (mood === "hyped" ? 12 : 0) -
      (mood === "stressed" ? 18 : 0) -
      (mood === "recovering" ? 8 : 0),
  );
  const bond = clampPercent(
    36 +
      accepted * 5 -
      rejected * 4 +
      bestDifficultyScore +
      (context.realModeEnabled ? 6 : 0) +
      (mood === "proud" ? 10 : 0),
  );
  const focus = clampPercent(
    (context.isMining ? 48 : 18) +
      hashrateScore +
      context.luckMeter / 4 +
      (mood === "curious" ? 16 : 0) +
      (mood === "hyped" ? 18 : 0) -
      (mood === "stressed" ? 24 : 0),
  );

  const eventSignal = compactEventLabel(context.lastEvent);
  const latestSignal = eventSignal ?? context.latestLog ?? "Ready";
  const modeLabel = context.realModeEnabled
    ? context.computeMode === "hybrid"
      ? "CPU+GPU"
      : context.computeMode.toUpperCase()
    : "SIM";

  return {
    profileId: context.profile.id,
    name: context.profile.personality.name,
    species: context.profile.personality.species,
    trait: context.profile.personality.trait,
    favoriteSignal: context.profile.personality.favoriteSignal,
    mood,
    moodLabel: moodLabels[mood],
    reaction: reactionForStatus(context.profile, context.petStatus, context.lastEvent),
    need: needForMood(mood, context.realModeEnabled, context.connectionStatus),
    latestSignal,
    care: {
      energy: { label: "Energy", value: energy },
      bond: { label: "Bond", value: bond },
      focus: { label: "Focus", value: focus },
    },
    badges: [
      ["MOOD", moodLabels[mood]],
      ["TRAIT", context.profile.personality.trait],
      ["MODE", modeLabel],
    ],
    ariaLabel: `${context.profile.personality.name}, ${moodLabels[mood]} ${context.profile.personality.species}`,
  };
}
