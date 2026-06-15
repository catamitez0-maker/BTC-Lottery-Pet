import type { PetState } from "../domain/petState";

export type MiningEngineKind = "simulation" | "cpu" | "gpu" | "stratum";

export interface MiningEngineStatus {
  kind: MiningEngineKind;
  petState: PetState;
  running: boolean;
  label: string;
}

export interface MiningEngine {
  kind: MiningEngineKind;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => MiningEngineStatus;
}

export interface MiningEngineLifecycle {
  prepareStart: () => void;
  startSimulation: () => void;
  startReal: (kind: Exclude<MiningEngineKind, "simulation">) => Promise<void>;
  stopSimulation: () => void;
  stopReal: () => Promise<void>;
  status: (kind: MiningEngineKind) => MiningEngineStatus;
}

function createSimulationLifecycleEngine(args: MiningEngineLifecycle): MiningEngine {
  return {
    kind: "simulation",
    start: async () => {
      args.prepareStart();
      args.startSimulation();
    },
    stop: async () => {
      args.stopSimulation();
    },
    status: () => args.status("simulation"),
  };
}

function createRealLifecycleEngine(
  kind: Exclude<MiningEngineKind, "simulation">,
  args: MiningEngineLifecycle,
): MiningEngine {
  return {
    kind,
    start: async () => {
      args.prepareStart();
      await args.startReal(kind);
    },
    stop: async () => {
      await args.stopReal();
    },
    status: () => args.status(kind),
  };
}

export function createSimulationEngine(args: MiningEngineLifecycle): MiningEngine {
  return createSimulationLifecycleEngine(args);
}

export function createCpuMiningEngine(args: MiningEngineLifecycle): MiningEngine {
  return createRealLifecycleEngine("cpu", args);
}

export function createGpuMiningEngine(args: MiningEngineLifecycle): MiningEngine {
  return createRealLifecycleEngine("gpu", args);
}

export function createStratumMiningEngine(args: MiningEngineLifecycle): MiningEngine {
  return createRealLifecycleEngine("stratum", args);
}
