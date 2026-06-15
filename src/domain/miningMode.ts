import type { ComputeMode } from "../miningLogic";

export type MiningMode = "dream" | "mining" | "hardcore" | "solo";

export interface MiningModeOption {
  mode: MiningMode;
  title: string;
  label: string;
  description: string;
  computeMode: ComputeMode;
  realModeEnabled: boolean;
}

export const miningModeOptions: MiningModeOption[] = [
  {
    mode: "dream",
    title: "Dream Mode",
    label: "Simulation",
    description: "Play the lottery loop without touching real CPU or GPU mining.",
    computeMode: "cpu",
    realModeEnabled: false,
  },
  {
    mode: "mining",
    title: "Mining Mode",
    label: "CPU",
    description: "Use conservative CPU mining against the configured Stratum pool.",
    computeMode: "cpu",
    realModeEnabled: true,
  },
  {
    mode: "hardcore",
    title: "Hardcore Mode",
    label: "GPU",
    description: "Use GPU mining with the configured intensity limit.",
    computeMode: "gpu",
    realModeEnabled: true,
  },
  {
    mode: "solo",
    title: "Solo Gamble",
    label: "Stratum",
    description: "Connect to the pool as a lottery run with the current worker settings.",
    computeMode: "cpu",
    realModeEnabled: true,
  },
];

export function miningModeOption(mode: MiningMode) {
  return miningModeOptions.find((option) => option.mode === mode) ?? miningModeOptions[0];
}

export function miningModeLabel(mode: MiningMode | null) {
  return mode ? miningModeOption(mode).title : "Choose Mode";
}
