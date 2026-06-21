import test from "node:test";
import assert from "node:assert/strict";

import {
  expectedSharesPerHour,
  formatShareRate,
  formatHashrate,
  hasHardwareGpuDevice,
  hasSoftwareGpuDevice,
  isGpuComputeMode,
  normalizeAppConfig,
  presetPort,
  realMiningStartError,
  sanitizeGpuDeviceId,
  threadsForPreset,
} from "../.test-dist/miningLogic.js";
import {
  derivePetState,
  petStatusFromState,
} from "../.test-dist/domain/petState.js";
import {
  createBlockCandidateEvent,
  createJackpotEvent,
  createShareEvent,
} from "../.test-dist/domain/miningEvents.js";
import {
  calculateProbabilitySnapshot,
  formatProbabilityTime,
} from "../.test-dist/domain/probabilityEngine.js";
import {
  nextJackpotPhase,
  startJackpotSequence,
} from "../.test-dist/domain/jackpotSequence.js";
import { createSimulationEngine } from "../.test-dist/engines/miningEngine.js";
import {
  derivePetCompanionSnapshot,
  petMoodFromStatus,
} from "../.test-dist/pets/companion.js";
import {
  DEFAULT_PET_PROFILE_ID,
  PET_PROFILE_STATUSES,
  builtinPetProfileIds,
  builtinPetProfiles,
  getPetProfile,
  isKnownPetProfileId,
  missingPetStates,
  normalizePetProfileId,
  validatePetManifest,
} from "../.test-dist/pets/profiles.js";

const systemInfo = {
  available_parallelism: 8,
  default_cpu_threads: 1,
  recommended_cpu_threads: 2,
};

const devices = [
  { id: "auto", name: "Auto", simulated: false },
  { id: "gpu-0", name: "Hardware GPU", simulated: false },
  { id: "gpu-1", name: "Software Adapter", simulated: true },
];

function validConfig(overrides = {}) {
  return {
    btc_address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    pool_host: "public-pool.io",
    pool_port: 3333,
    pool_password: "x",
    worker_name: "desk_1",
    cpu_threads: 1,
    performance_preset: "eco",
    real_mining_enabled: false,
    enable_notifications: true,
    notify_on_jackpot: true,
    notify_on_share_accepted: false,
    notify_on_connection_error: true,
    heartbeat_interval: "off",
    notification_channel: "local_windows_toast",
    webhook_url: "",
    compute_mode: "cpu",
    gpu_enabled: false,
    gpu_device_id: null,
    gpu_intensity_percent: 10,
    pet_profile_id: DEFAULT_PET_PROFILE_ID,
    ...overrides,
  };
}

test("pool presets normalize known ports without touching custom pools", () => {
  assert.equal(presetPort("public-pool.io", 21496), 3333);
  assert.equal(presetPort("pool.nerdminer.io", 21496), 3333);
  assert.equal(presetPort("pool.nerdminers.org", 21496), 3333);
  assert.equal(presetPort("example.invalid", 4444), 4444);
});

test("performance presets enforce conservative CPU thread bounds", () => {
  assert.equal(threadsForPreset("eco", systemInfo, 8), 1);
  assert.equal(threadsForPreset("normal", systemInfo, 8), 2);
  assert.equal(threadsForPreset("turbo", systemInfo, 1), 8);
  assert.equal(threadsForPreset("custom", systemInfo, 99), 8);
  assert.equal(threadsForPreset("custom", systemInfo, -4), 1);
  assert.equal(threadsForPreset("turbo", systemInfo, 8, true), 0);
});

test("GPU helpers distinguish hardware from software adapters", () => {
  assert.equal(isGpuComputeMode("cpu"), false);
  assert.equal(isGpuComputeMode("gpu"), true);
  assert.equal(isGpuComputeMode("hybrid"), true);
  assert.equal(hasHardwareGpuDevice(devices), true);
  assert.equal(hasSoftwareGpuDevice(devices), true);
  assert.equal(sanitizeGpuDeviceId("gpu-0", devices), "gpu-0");
  assert.equal(sanitizeGpuDeviceId("gpu-1", devices), null);
  assert.equal(sanitizeGpuDeviceId("auto", devices), null);
  assert.equal(sanitizeGpuDeviceId("missing", devices), null);
});

test("hashrate formatting uses stable units", () => {
  assert.equal(formatHashrate(999), "999 H/s");
  assert.equal(formatHashrate(1_500), "1.50 KH/s");
  assert.equal(formatHashrate(2_500_000), "2.50 MH/s");
});

test("config normalization trims fields and records GPU-only as zero CPU threads", () => {
  const normalized = normalizeAppConfig(
    validConfig({
      btc_address: "  1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa  ",
      pool_host: " PUBLIC-POOL.IO ",
      pool_port: 21496,
      pool_password: " d=1 ",
      worker_name: "  desk_1  ",
      cpu_threads: 99,
      performance_preset: "turbo",
      real_mining_enabled: true,
      notification_channel: "webhook",
      webhook_url: "  https://example.invalid/hook  ",
      compute_mode: "gpu",
      gpu_enabled: false,
      gpu_device_id: "gpu-0",
      gpu_intensity_percent: 250,
    }),
    systemInfo,
    devices,
  );

  assert.equal(normalized.btc_address, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  assert.equal(normalized.pool_host, "PUBLIC-POOL.IO");
  assert.equal(normalized.pool_port, 3333);
  assert.equal(normalized.pool_password, "d=1");
  assert.equal(normalized.worker_name, "desk_1");
  assert.equal(normalized.real_mining_enabled, false);
  assert.equal(normalized.cpu_threads, 0);
  assert.equal(normalized.gpu_enabled, true);
  assert.equal(normalized.gpu_device_id, "gpu-0");
  assert.equal(normalized.gpu_intensity_percent, 100);
  assert.equal(normalized.pet_profile_id, DEFAULT_PET_PROFILE_ID);
  assert.equal(normalized.webhook_url, "https://example.invalid/hook");
});

test("pet profile registry validates manifests and normalizes unknown ids", () => {
  assert.equal(normalizePetProfileId("cyber-miner"), "cyber-miner");
  assert.equal(normalizePetProfileId("missing-profile"), DEFAULT_PET_PROFILE_ID);
  assert.equal(getPetProfile(null).id, DEFAULT_PET_PROFILE_ID);
  assert.equal(isKnownPetProfileId("lucky-cat"), true);
  assert.equal(isKnownPetProfileId("missing-profile"), false);
  assert.deepEqual(builtinPetProfileIds, ["classic-slot", "cyber-miner", "lucky-cat"]);

  const nonObjectValidation = validatePetManifest(null);
  assert.equal(nonObjectValidation.ok, false);
  assert.equal(nonObjectValidation.errors.includes("manifest must be an object"), true);

  for (const profile of builtinPetProfiles) {
    assert.deepEqual(missingPetStates(profile), []);
    assert.deepEqual(validatePetManifest(profile), { ok: true, errors: [] });
    assert.equal(profile.manifestVersion, 1);
    assert.equal(profile.kind, "procedural");
    assert.equal(typeof profile.body.shape, "string");
    assert.equal(typeof profile.body.silhouette, "string");
    assert.equal(typeof profile.body.screenShape, "string");
    assert.equal(typeof profile.body.feet, "string");
    assert.equal(typeof profile.body.idlePose, "string");
    assert.equal(Array.isArray(profile.body.accentMarks), true);
    assert.equal(typeof profile.personality.name, "string");
    assert.equal(typeof profile.personality.voice.jackpot, "string");
    for (const status of PET_PROFILE_STATUSES) {
      assert.equal(typeof profile.states[status].expression, "string");
      assert.equal(profile.states[status].slots.length, 3);
    }
  }

  const invalidManifest = {
    ...getPetProfile("classic-slot"),
    id: "Bad Id",
    palette: {
      ...getPetProfile("classic-slot").palette,
      primary: "orange",
    },
    body: {
      ...getPetProfile("classic-slot").body,
      silhouette: "unknown-body",
      accentMarks: ["bad mark"],
    },
    reels: [["B"], [], ["C"]],
    states: {
      ...getPetProfile("classic-slot").states,
      Mining: {
        ...getPetProfile("classic-slot").states.Mining,
        slots: ["-", "-", ""],
        animation: "teleport",
      },
    },
  };
  const validation = validatePetManifest(invalidManifest);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.includes("id must use lowercase letters, numbers, and dashes"), true);
  assert.equal(validation.errors.includes("palette.primary must be a #RRGGBB color"), true);
  assert.equal(validation.errors.includes("body.silhouette is not supported"), true);
  assert.equal(validation.errors.includes("body.accentMarks must contain class-safe tokens"), true);
  assert.equal(validation.errors.includes("reels.1 must contain symbols"), true);
  assert.equal(validation.errors.includes("states.Mining.slots must contain exactly 3 symbols"), true);
  assert.equal(validation.errors.includes("states.Mining.animation is not supported"), true);
});

test("pet companion snapshot adds mood, care, and personality feedback", () => {
  const profile = getPetProfile("cyber-miner");
  const baseContext = {
    profile,
    petState: "IDLE",
    petStatus: "Sleeping",
    isMining: false,
    realModeEnabled: false,
    computeMode: "cpu",
    connectionStatus: "Stopped",
    latestLog: "Ready",
    lastEvent: null,
    acceptedShares: 0,
    rejectedShares: 0,
    bestDifficulty: 1,
    hashrate: 0,
    luckMeter: 0,
    miningUptimeSeconds: 0,
    appUptimeSeconds: 0,
  };

  const resting = derivePetCompanionSnapshot(baseContext);
  assert.equal(resting.name, "Volt");
  assert.equal(resting.mood, "resting");
  assert.equal(resting.reaction, profile.personality.voice.idle);
  assert.equal(resting.badges[0][0], "MOOD");

  const overdrive = derivePetCompanionSnapshot({
    ...baseContext,
    petState: "MINING_GPU",
    petStatus: "Overdrive",
    isMining: true,
    realModeEnabled: true,
    computeMode: "gpu",
    connectionStatus: "Mining",
    acceptedShares: 3,
    bestDifficulty: 128,
    hashrate: 1_000_000,
    luckMeter: 68,
    miningUptimeSeconds: 45,
  });
  assert.equal(overdrive.mood, "hyped");
  assert.equal(overdrive.badges[2][1], "GPU");
  assert.equal(overdrive.care.focus.value > resting.care.focus.value, true);
  assert.equal(overdrive.care.bond.value > resting.care.bond.value, true);

  const rejected = derivePetCompanionSnapshot({
    ...baseContext,
    petStatus: "Mining",
    lastEvent: createShareEvent("share_rejected", "simulation", "Rejected"),
  });
  assert.equal(rejected.reaction, profile.personality.voice.rejected);

  assert.equal(petMoodFromStatus("Jackpot"), "proud");
  assert.equal(petMoodFromStatus("Connection Error"), "stressed");
});

test("config normalization shares backend port and worker defaults", () => {
  const knownPool = normalizeAppConfig(
    validConfig({
      pool_host: "pool.nerdminers.org",
      pool_port: 21496,
      worker_name: "  ",
    }),
    systemInfo,
    devices,
  );

  assert.equal(knownPool.pool_port, 3333);
  assert.equal(knownPool.worker_name, "btc-lottery-pet");

  const customPool = normalizeAppConfig(
    validConfig({
      pool_host: "example.invalid",
      pool_port: 21496,
    }),
    systemInfo,
    devices,
  );

  assert.equal(customPool.pool_port, 21496);

  const invalidPort = normalizeAppConfig(
    validConfig({
      pool_host: "example.invalid",
      pool_port: 0,
    }),
    systemInfo,
    devices,
  );

  assert.equal(invalidPort.pool_port, 3333);
});

test("real mining start validation catches local configuration mistakes", () => {
  assert.equal(realMiningStartError(validConfig(), devices, true), null);
  assert.equal(
    realMiningStartError(validConfig({ btc_address: "  " }), devices, true),
    "Add a BTC address before starting real mining.",
  );
  assert.equal(
    realMiningStartError(validConfig({ pool_host: "https://public-pool.io/path" }), devices, true),
    "Pool host must be a hostname without spaces, URL scheme, or path.",
  );
  assert.equal(
    realMiningStartError(validConfig({ pool_port: 70000 }), devices, true),
    "Pool port must be between 1 and 65535.",
  );
  assert.equal(
    realMiningStartError(validConfig({ pool_password: `${"x".repeat(129)}` }), devices, true),
    "Pool password must be 128 characters or fewer and cannot contain control characters.",
  );
  assert.equal(
    realMiningStartError(validConfig({ worker_name: "desk.1" }), devices, true),
    "Worker name may contain only letters, numbers, dashes, and underscores.",
  );
  assert.equal(
    realMiningStartError(
      validConfig({ compute_mode: "gpu", gpu_enabled: true }),
      [
        { id: "auto", name: "Auto", simulated: true },
        { id: "gpu-1", name: "Software Adapter", simulated: true },
      ],
      true,
    ),
    "No hardware GPU detected. Switch to CPU or CPU + GPU mode, or update GPU drivers.",
  );
});

test("share rate helpers explain pool difficulty impact", () => {
  const diffOneRate = expectedSharesPerHour(2 ** 32, 1);
  assert.equal(diffOneRate, 3600);
  assert.equal(formatShareRate(diffOneRate), "3,600/h");
  assert.equal(formatShareRate(expectedSharesPerHour(500_000, 100_000)), "<0.001/h");
  assert.equal(formatShareRate(0), "Waiting");
});

test("pet state derives from unified event and jackpot context", () => {
  const baseContext = {
    isMining: false,
    realModeEnabled: false,
    isCoolingDown: false,
    attentionEventType: null,
    jackpotPhase: "idle",
    computeMode: "cpu",
    connectionStatus: "Stopped",
    currentJobId: "",
  };

  assert.equal(derivePetState(baseContext), "IDLE");
  assert.equal(derivePetState({ ...baseContext, isMining: true }), "DREAMING");
  assert.equal(
    derivePetState({ ...baseContext, isMining: true, realModeEnabled: true, connectionStatus: "Connecting" }),
    "MINING_POOL",
  );
  assert.equal(
    derivePetState({
      ...baseContext,
      isMining: true,
      realModeEnabled: true,
      computeMode: "gpu",
      currentJobId: "job-1",
      connectionStatus: "Mining",
    }),
    "MINING_GPU",
  );
  assert.equal(derivePetState({ ...baseContext, attentionEventType: "share_accepted" }), "LUCKY_EVENT");
  assert.equal(derivePetState({ ...baseContext, jackpotPhase: "particles" }), "LUCKY_EVENT");
  assert.equal(
    petStatusFromState("LUCKY_EVENT", { ...baseContext, attentionEventType: "jackpot" }),
    "Jackpot",
  );
});

test("mining events keep block candidates separate from jackpot UI events", () => {
  const block = {
    job_id: "job-1",
    nonce: "00000001",
    ntime: "abcd",
    extranonce2: "00",
    hash: "00ff",
    difficulty: 123,
    timestamp: "2026-06-15T00:00:00Z",
    pool: "public-pool.io:3333",
  };

  const accepted = createShareEvent("share_accepted", "stratum", "Share accepted");
  const candidate = createBlockCandidateEvent("stratum", block);
  const jackpot = createJackpotEvent(block);

  assert.equal(accepted.level, "MID_LEVEL");
  assert.equal(candidate.level, "HIGH_LEVEL");
  assert.equal(candidate.type, "block_candidate");
  assert.equal(jackpot.type, "jackpot");
  assert.notDeepEqual(candidate.payload, jackpot.payload);
});

test("probability engine exposes display-only luck and ETA", () => {
  const snapshot = calculateProbabilitySnapshot({
    currentDifficulty: 1000,
    hashrate: 2 ** 32,
    bestDifficulty: 64,
    acceptedShares: 3,
    rejectedShares: 1,
    miningUptimeSeconds: 3600,
    realModeEnabled: true,
  });

  assert.equal(snapshot.currentDifficulty, 1000);
  assert.equal(snapshot.estimatedTimeToBlockSeconds, 1000);
  assert.equal(snapshot.streakCounter, 2);
  assert.equal(snapshot.luckMeter > 0, true);
  assert.equal(formatProbabilityTime(null), "Waiting");
  assert.equal(formatProbabilityTime(7200), "2 hours");
});

test("jackpot sequence advances through the required presentation phases", () => {
  const block = {
    job_id: "job-1",
    nonce: "00000001",
    ntime: "abcd",
    extranonce2: "00",
    hash: "00ff",
    difficulty: 123,
    timestamp: "2026-06-15T00:00:00Z",
    pool: "public-pool.io:3333",
  };

  const sequence = startJackpotSequence(block, true, "stratum");
  assert.equal(sequence.phase, "detect");
  assert.equal(nextJackpotPhase("detect"), "pause");
  assert.equal(nextJackpotPhase("pause"), "screen_effect");
  assert.equal(nextJackpotPhase("screen_effect"), "particles");
  assert.equal(nextJackpotPhase("particles"), "reveal");
  assert.equal(nextJackpotPhase("reveal"), "resume");
});

test("mining engine facade owns start stop status calls", async () => {
  const calls = [];
  const engine = createSimulationEngine({
    prepareStart: () => calls.push("prepare"),
    startSimulation: () => calls.push("start-sim"),
    startReal: async () => calls.push("start-real"),
    stopSimulation: () => calls.push("stop-sim"),
    stopReal: async () => calls.push("stop-real"),
    status: (kind) => ({
      kind,
      petState: "DREAMING",
      running: true,
      label: "DREAMING",
    }),
  });

  await engine.start();
  await engine.stop();

  assert.deepEqual(calls, ["prepare", "start-sim", "stop-sim"]);
  assert.equal(engine.status().kind, "simulation");
});
