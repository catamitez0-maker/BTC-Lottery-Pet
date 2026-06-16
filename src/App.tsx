import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Header from "./components/Header";
import PetDisplay from "./components/PetDisplay";
import MetricsGrid from "./components/MetricsGrid";
import SettingsPanel from "./components/SettingsPanel";
import LogTicker from "./components/LogTicker";
import {
  idleJackpotSequence,
  isJackpotOverlayVisible,
  jackpotPhaseDurationMs,
  jackpotPhaseLabel,
  nextJackpotPhase,
  startJackpotSequence,
} from "./domain/jackpotSequence";
import type { JackpotSequenceSnapshot } from "./domain/jackpotSequence";
import {
  createDevLogEntry,
  createPetLogEntry,
  latestPetLogMessage,
  petLogMessageFromMiningEvent,
  petLogMessageFromRawLog,
} from "./domain/miningLogs";
import type { DevLogEntry, PetLogEntry } from "./domain/miningLogs";
import { miningModeLabel, miningModeOption, miningModeOptions } from "./domain/miningMode";
import type { MiningMode } from "./domain/miningMode";
import {
  createBlockCandidateEvent,
  createJackpotEvent,
  createShareEvent,
  miningEventLabel,
} from "./domain/miningEvents";
import type { MiningEvent } from "./domain/miningEvents";
import {
  derivePetState,
  isAnimatedMiningState,
  petStateLabel,
  petStatusFromState,
} from "./domain/petState";
import {
  createCpuMiningEngine as createCpuEngine,
  createGpuMiningEngine as createGpuEngine,
  createSimulationEngine as createSimulationEngineAdapter,
  createStratumMiningEngine as createStratumEngine,
} from "./engines/miningEngine";
import type { MiningEngine, MiningEngineKind, MiningEngineLifecycle } from "./engines/miningEngine";
import {
  calculateProbabilitySnapshot,
  formatProbabilityTime,
} from "./domain/probabilityEngine";
import type { ProbabilitySnapshot } from "./domain/probabilityEngine";
import { formatError, formatUptime } from "./formatting";
import { useBlockHeight } from "./hooks/useBlockHeight";
import { useDiagnosticsActions } from "./hooks/useDiagnosticsActions";
import { useHeartbeatNotifications } from "./hooks/useHeartbeatNotifications";
import { useSimulationMiningSession } from "./hooks/useSimulationMiningSession";
import { notificationSettingsFromConfig } from "./notificationSettings";
import {
  expectedSharesPerHour,
  formatDifficulty,
  formatHashrate,
  formatShareRate,
  hasHardwareGpuDevice,
  hasSoftwareGpuDevice,
  isGpuComputeMode,
  normalizeAppConfig,
  presetPort,
  realMiningStartError,
  sanitizeGpuDeviceId,
  threadsForPreset,
} from "./miningLogic";
import type {
  AppConfig,
  BlockFoundEvent,
  GpuBenchmarkResult,
  GpuDevice,
  PetStatus,
  PerformancePreset,
  PoolDiagnosticReport,
  RealMiningStats,
  SimulationStats,
  SystemInfo,
} from "./miningLogic";

const fallbackConfig: AppConfig = {
  btc_address: "",
  pool_host: "public-pool.io",
  pool_port: 3333,
  pool_password: "x",
  worker_name: "btc-lottery-pet",
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
};

const fallbackSystemInfo: SystemInfo = {
  available_parallelism: Math.max(1, navigator.hardwareConcurrency || 1),
  default_cpu_threads: 1,
  recommended_cpu_threads: Math.min(2, Math.max(1, navigator.hardwareConcurrency || 1)),
};

const fallbackGpuDevices: GpuDevice[] = [
  { id: "auto", name: "Auto", simulated: true },
  { id: "simulated-gpu", name: "Simulated GPU", simulated: true },
];

const idleRealStats: RealMiningStats = {
  hashrate: 0,
  accepted_shares: 0,
  rejected_shares: 0,
  best_difficulty: 0,
  share_difficulty: 0,
  current_job_id: "",
  connection_status: "Stopped",
  gpu_backend: "",
  gpu_device_name: "",
  gpu_dispatch_size: 0,
  gpu_dispatch_ms: 0,
  gpu_throttle_ms: 0,
};

const runningInTauri = isTauri();

function formatDispatchSize(dispatchSize: number) {
  if (!dispatchSize) {
    return "Waiting";
  }

  return Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(dispatchSize);
}

function performancePresetLabel(preset: PerformancePreset) {
  switch (preset) {
    case "eco":
      return "Eco";
    case "normal":
      return "Normal";
    case "turbo":
      return "Turbo";
    case "custom":
      return "Custom";
  }
}

function useLatestRef<T>(val: T) {
  const ref = useRef(val);
  ref.current = val;
  return ref;
}

function App() {
  const [isMining, setIsMining] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [appUptime, setAppUptime] = useState(0);
  const [miningUptime, setMiningUptime] = useState(0);
  const [config, setConfig] = useState<AppConfig>(fallbackConfig);
  const [draftConfig, setDraftConfig] = useState<AppConfig>(fallbackConfig);
  const [realModeEnabled, setRealModeEnabled] = useState(false);
  const [selectedMiningMode, setSelectedMiningMode] = useState<MiningMode | null>(null);
  const [showModeSelection, setShowModeSelection] = useState(true);
  const [showCpuWarning, setShowCpuWarning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [realStats, setRealStats] = useState<RealMiningStats>(idleRealStats);
  const [simulationStats, setSimulationStats] = useState<SimulationStats>({
    status: "Sleeping",
    hashrate: 0,
    bestDifficulty: 0.01,
  });

  const [simAccepted, setSimAccepted] = useState(0);
  const [simRejected, setSimRejected] = useState(0);
  const blockHeight = useBlockHeight();
  const [latestLog, setLatestLog] = useState("Ready to dream.");
  const [petLogs, setPetLogs] = useState<PetLogEntry[]>([]);
  const [devLogs, setDevLogs] = useState<DevLogEntry[]>([]);
  const [lastMiningEvent, setLastMiningEvent] = useState<MiningEvent | null>(null);
  const [attentionEvent, setAttentionEvent] = useState<MiningEvent | null>(null);
  const [lastShare, setLastShare] = useState("None");
  const [jackpotSequence, setJackpotSequence] =
    useState<JackpotSequenceSnapshot>(idleJackpotSequence);

  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [displayMode, setDisplayMode] = useState<"compact" | "detail">("compact");
  const [systemInfo, setSystemInfo] = useState<SystemInfo>(fallbackSystemInfo);
  const [gpuDevices, setGpuDevices] = useState<GpuDevice[]>(fallbackGpuDevices);
  const [benchmarkResult, setBenchmarkResult] = useState<GpuBenchmarkResult | null>(null);
  const [poolDiagnosticResult, setPoolDiagnosticResult] =
    useState<PoolDiagnosticReport | null>(null);

  const coolingDownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simShareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useLatestRef(config);
  const realStatsRef = useLatestRef(realStats);
  const simulationStatsRef = useLatestRef(simulationStats);
  const appUptimeRef = useLatestRef(appUptime);
  const miningUptimeRef = useLatestRef(miningUptime);
  const simAcceptedRef = useLatestRef(simAccepted);
  const simRejectedRef = useLatestRef(simRejected);
  const realModeEnabledRef = useLatestRef(realModeEnabled);
  const isMiningRef = useLatestRef(isMining);
  const selectedMiningModeRef = useLatestRef(selectedMiningMode);
  const lastConnectionNotificationRef = useRef(0);
  const appendPetLog = useCallback((message: string) => {
    const entry = createPetLogEntry(message);
    setPetLogs((current) => [entry, ...current].slice(0, 20));
    setLatestLog(latestPetLogMessage(entry));
  }, []);
  const appendDevLog = useCallback((source: DevLogEntry["source"], message: string) => {
    const entry = createDevLogEntry(source, message);
    setDevLogs((current) => [entry, ...current].slice(0, 80));
  }, []);
  const emitMiningEvent = useCallback((event: MiningEvent) => {
    if (event.level !== "LOW_LEVEL") {
      setLastMiningEvent(event);
      if (event.type === "share_accepted" || event.type === "block_candidate" || event.type === "jackpot") {
        setAttentionEvent(event);
      }

      const petMessage = petLogMessageFromMiningEvent(event);
      if (petMessage) {
        appendPetLog(petMessage);
      }
    }
  }, [appendPetLog]);

  // Component unmount cleanup
  useEffect(() => {
    return () => {
      if (coolingDownTimerRef.current) clearTimeout(coolingDownTimerRef.current);
      if (simShareTimerRef.current) clearTimeout(simShareTimerRef.current);
    };
  }, []);

  // App Uptime Timer
  useEffect(() => {
    const timer = window.setInterval(() => {
      setAppUptime((value) => value + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Mining Uptime Timer
  useEffect(() => {
    if (!isMining) return;
    const timer = window.setInterval(() => {
      setMiningUptime((value) => value + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [isMining]);

  // Load Config
  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((loadedConfig) => {
        setConfig(loadedConfig);
        setDraftConfig(loadedConfig);
      })
      .catch((error) => {
        setConfig(fallbackConfig);
        setDraftConfig(fallbackConfig);

        if (runningInTauri) {
          setErrorMessage(`Could not load settings: ${formatError(error)}`);
        }
      });
  }, []);

  // Browser preview uses conservative fallbacks; Tauri supplies the local values.
  useEffect(() => {
    invoke<SystemInfo>("get_system_info")
      .then(setSystemInfo)
      .catch(() => setSystemInfo(fallbackSystemInfo));

    invoke<GpuDevice[]>("get_gpu_devices")
      .then(setGpuDevices)
      .catch(() => setGpuDevices(fallbackGpuDevices));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;

    listen<RealMiningStats>("mining-stats", (event) => {
      if (
        event.payload.connection_status === "GPU unavailable" &&
        isMiningRef.current &&
        realModeEnabledRef.current
      ) {
        isMiningRef.current = false;
        setIsMining(false);
        setErrorMessage("GPU mining unavailable. Check GPU drivers or switch Compute Mode.");
      }

      setRealStats((current) => {
        if (!isMiningRef.current || !realModeEnabledRef.current) {
          return event.payload;
        }

        if (event.payload.connection_status === "Stopped") {
          return current;
        }

        return {
          ...event.payload,
          accepted_shares: Math.max(current.accepted_shares, event.payload.accepted_shares),
          rejected_shares: Math.max(current.rejected_shares, event.payload.rejected_shares),
        };
      });
    })
      .then((cleanup) => {
        if (unmounted) { cleanup(); } else { unlisten = cleanup; }
      })
      .catch((error) => {
        if (runningInTauri) {
          setErrorMessage(`Could not listen for mining stats: ${formatError(error)}`);
        }
      });

    return () => { unmounted = true; unlisten?.(); };
  }, []);

  // Listen to Mining Logs
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;

    listen<string>("mining-log", (event) => {
      const message = event.payload;
      const cleanMessage = message.replace(/^\[[^\]]+\]\s*/, "");
      appendDevLog("stratum", message);
      const petMessage = petLogMessageFromRawLog(message);
      if (petMessage) {
        appendPetLog(petMessage);
      }

      const lowerMessage = message.toLowerCase();
      const shouldSyncRealMining = isMiningRef.current && realModeEnabledRef.current;
      if (lowerMessage.includes("share submitted") || lowerMessage.includes("share accepted") || lowerMessage.includes("share rejected")) {
        setLastShare(cleanMessage);
      }

      if (shouldSyncRealMining && lowerMessage.includes("connected to pool")) {
        setRealStats((current) => ({ ...current, connection_status: "Connected" }));
      } else if (shouldSyncRealMining && lowerMessage.includes("worker authorized successfully")) {
        setRealStats((current) => ({ ...current, connection_status: "Authorized" }));
      } else if (shouldSyncRealMining && lowerMessage.includes("job received")) {
        const jobMatch = cleanMessage.match(/Job received: id=([^,]+)/);
        setRealStats((current) => ({
          ...current,
          current_job_id: jobMatch?.[1] ?? current.current_job_id,
          connection_status: "Mining",
        }));
      }

      if (lowerMessage.includes("share accepted")) {
        emitMiningEvent(createShareEvent("share_accepted", "stratum", cleanMessage));
        if (shouldSyncRealMining) {
          // Share count is tracked by the backend via mining-stats events.
          // We only trigger the notification here.
          void invoke("notify_share_accepted", {
            settings: notificationSettingsFromConfig(configRef.current),
          }).catch(() => {});
        }
      } else if (lowerMessage.includes("share rejected")) {
        emitMiningEvent(createShareEvent("share_rejected", "stratum", cleanMessage));
      }

      if (lowerMessage.includes("connection error")) {
        if (shouldSyncRealMining) {
          setRealStats((current) => ({ ...current, connection_status: "Connection Error" }));
        }
        const now = Date.now();
        if (now - lastConnectionNotificationRef.current > 60_000) {
          lastConnectionNotificationRef.current = now;
          void invoke("notify_connection_error", {
            settings: notificationSettingsFromConfig(configRef.current),
            status: cleanMessage,
          }).catch(() => {});
        }
      }
    })
      .then((cleanup) => {
        if (unmounted) { cleanup(); } else { unlisten = cleanup; }
      })
      .catch((error) => {
        if (runningInTauri) {
          setErrorMessage(`Could not listen for mining logs: ${formatError(error)}`);
        }
      });

    return () => { unmounted = true; unlisten?.(); };
  }, [appendDevLog, appendPetLog, emitMiningEvent]);

  // Listen to Block Candidate Events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;

    listen<BlockFoundEvent>("block-found", (event) => {
      const wasMining = isMiningRef.current;
      const engineKind: MiningEngineKind = selectedMiningModeRef.current === "solo"
        ? "stratum"
        : !realModeEnabledRef.current
          ? "simulation"
          : isGpuComputeMode(configRef.current.compute_mode)
            ? "gpu"
            : "cpu";

      emitMiningEvent(createBlockCandidateEvent("stratum", event.payload));
      emitMiningEvent(createJackpotEvent(event.payload));
      appendDevLog("stratum", `Block candidate found: job=${event.payload.job_id}, hash=${event.payload.hash}`);
      setJackpotSequence(startJackpotSequence(event.payload, wasMining, engineKind));

      if (wasMining && realModeEnabledRef.current) {
        isMiningRef.current = false;
        setIsMining(false);
        setRealStats((current) => ({
          ...current,
          hashrate: 0,
          connection_status: "Jackpot pause",
        }));
        void invoke("stop_real_mining").catch((error) => {
          appendDevLog("stratum", `Jackpot pause failed: ${formatError(error)}`);
        });
      }

      void invoke("notify_jackpot", {
        settings: notificationSettingsFromConfig(configRef.current),
        event: {
          pool: event.payload.pool,
          jobId: event.payload.job_id,
          hash: event.payload.hash,
          difficulty: event.payload.difficulty,
          timestamp: event.payload.timestamp,
        },
      }).catch(() => {});
    })
      .then((cleanup) => {
        if (unmounted) { cleanup(); } else { unlisten = cleanup; }
      })
      .catch((error) => {
        if (runningInTauri) {
          setErrorMessage(`Could not listen for block candidate events: ${formatError(error)}`);
        }
      });

    return () => { unmounted = true; unlisten?.(); };
  }, [appendDevLog, emitMiningEvent, configRef, isMiningRef, realModeEnabledRef, selectedMiningModeRef]);

  useHeartbeatNotifications({
    config,
    configRef,
    realStatsRef,
    simulationStatsRef,
    appUptimeRef,
    miningUptimeRef,
    simAcceptedRef,
    simRejectedRef,
    realModeEnabledRef,
    isMiningRef,
  });

  const gpuEnabled = isGpuComputeMode(config.compute_mode);

  useSimulationMiningSession({
    isMining,
    realModeEnabled,
    restartKey: config.gpu_intensity_percent,
    simShareTimerRef,
    setLatestLog,
    setSimAccepted,
    setSimRejected,
    setSimulationStats,
    emitMiningEvent,
    appendDevLog,
  });

  // Track New Best Difficulty
  const activeBestDiff = realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty;
  const prevBestDiffRef = useRef(0);

  useEffect(() => {
    if (!isMining) {
      prevBestDiffRef.current = activeBestDiff;
      return;
    }
    if (activeBestDiff > prevBestDiffRef.current) {
      if (prevBestDiffRef.current > 0) {
        appendPetLog("I found a sharper pattern.");
        prevBestDiffRef.current = activeBestDiff;
        return;
      }
      prevBestDiffRef.current = activeBestDiff;
    }
  }, [activeBestDiff, appendPetLog, isMining]);

  const startRealMiningConfirmed = async (realCpuThreads: number) => {
    isMiningRef.current = true;
    setIsMining(true);
    setRealStats((current) => ({
      ...current,
      hashrate: 0,
      accepted_shares: 0,
      rejected_shares: 0,
      share_difficulty: 0,
      current_job_id: "",
      connection_status: "Connecting",
      gpu_backend: "",
      gpu_device_name: "",
      gpu_dispatch_size: 0,
      gpu_dispatch_ms: 0,
      gpu_throttle_ms: 0,
    }));

    try {
      appendDevLog("stratum", `Starting real mining on ${config.pool_host}:${config.pool_port}`);
      await invoke("start_real_mining", {
        settings: {
          poolHost: config.pool_host,
          poolPort: config.pool_port,
          poolPassword: config.pool_password,
          btcAddress: config.btc_address,
          workerName: config.worker_name,
          cpuThreads: realCpuThreads,
          confirmedCpuUse: true,
          gpuEnabled,
          gpuDeviceId: sanitizeGpuDeviceId(config.gpu_device_id, gpuDevices),
          gpuIntensityPercent: config.gpu_intensity_percent,
        },
      });
    } catch (error) {
      isMiningRef.current = false;
      setIsMining(false);
      setErrorMessage(String(error));
      appendDevLog("stratum", `Start real mining failed: ${formatError(error)}`);
      setRealStats((current) => ({ ...current, connection_status: "Connection Error" }));
    }
  };

  const prepareMiningStart = () => {
    setErrorMessage(null);
    setMiningUptime(0);
    setIsCoolingDown(false);
    setLastShare("None");
    setAttentionEvent(null);
    if (coolingDownTimerRef.current) {
      clearTimeout(coolingDownTimerRef.current);
      coolingDownTimerRef.current = null;
    }
  };

  const startSimulationSession = () => {
    isMiningRef.current = true;
    setIsMining(true);
    setSimAccepted(0);
    setSimRejected(0);
    appendPetLog("I am dreaming of hashes.");
    setSimulationStats((current) => ({
      ...current,
      status: "Mining",
    }));
  };

  const realCpuThreadsForConfig = () => threadsForPreset(
    config.performance_preset,
    systemInfo,
    config.cpu_threads,
    config.compute_mode === "gpu",
  );

  const startRealMiningSession = async (kind: Exclude<MiningEngineKind, "simulation">) => {
    const startError = realMiningStartError(config, gpuDevices, runningInTauri);
    if (startError) {
      setErrorMessage(startError);
      setShowSettings(true);
      return;
    }

    const realCpuThreads = realCpuThreadsForConfig();
    const highCpuRequested =
      realCpuThreads > 0 &&
      (config.performance_preset === "turbo" ||
        realCpuThreads > systemInfo.recommended_cpu_threads);

    if (highCpuRequested) {
      setShowCpuWarning(true);
      return;
    }

    appendPetLog(kind === "gpu" ? "The GPU is warming up." : "I am listening for pool work.");
    await startRealMiningConfirmed(realCpuThreads);
  };

  const confirmCpuWarning = async () => {
    setShowCpuWarning(false);
    await startRealMiningConfirmed(realCpuThreadsForConfig());
  };

  const beginMiningCooldown = () => {
    isMiningRef.current = false;
    setIsMining(false);
    setIsCoolingDown(true);

    // Clear simulation timers immediately to avoid late logs/flashes after STOP
    if (simShareTimerRef.current) {
      clearTimeout(simShareTimerRef.current);
      simShareTimerRef.current = null;
    }
    setAttentionEvent(null);

    if (coolingDownTimerRef.current) {
      clearTimeout(coolingDownTimerRef.current);
    }
    coolingDownTimerRef.current = setTimeout(() => {
      setIsCoolingDown(false);
      coolingDownTimerRef.current = null;
    }, 4000);
  };

  const stopSimulationSession = () => {
    beginMiningCooldown();
    appendPetLog("Dream mode is cooling down.");
    setSimulationStats((current) => ({
      ...current,
      status: "Sleeping",
      hashrate: 0,
    }));
  };

  const stopRealMiningSession = async () => {
    beginMiningCooldown();
    appendPetLog("I am stepping away from the pool.");
    setRealStats((current) => ({
      ...current,
      hashrate: 0,
      connection_status: "Stopped",
    }));

    try {
      appendDevLog("stratum", "Stopping real mining");
      await invoke("stop_real_mining");
    } catch (error) {
      appendDevLog("stratum", `Stop real mining failed: ${formatError(error)}`);
      if (runningInTauri) {
        setErrorMessage(`Could not stop mining: ${formatError(error)}`);
      }
    }
  };

  const openModeSelection = () => {
    if (isMining) {
      setErrorMessage("Stop mining before changing modes.");
      return;
    }

    setShowModeSelection(true);
  };

  const selectMiningMode = (mode: MiningMode) => {
    if (isMining) {
      setErrorMessage("Stop mining before changing modes.");
      return;
    }

    const option = miningModeOption(mode);
    setSelectedMiningMode(mode);
    setShowModeSelection(false);
    setRealModeEnabled(option.realModeEnabled);
    setErrorMessage(null);
    appendPetLog(`${option.title} selected.`);

    const applyModeConfig = (current: AppConfig): AppConfig => ({
      ...current,
      compute_mode: option.computeMode,
      gpu_enabled: option.computeMode !== "cpu",
      real_mining_enabled: option.realModeEnabled,
    });

    setConfig(applyModeConfig);
    setDraftConfig(applyModeConfig);
  };

  const saveSettings = async () => {
    setErrorMessage(null);

    const settings = normalizeAppConfig(draftConfig, systemInfo, gpuDevices);

    try {
      const savedSettings = await invoke<AppConfig>("save_config", { config: settings });
      setConfig(savedSettings);
      setDraftConfig(savedSettings);
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not save settings: ${formatError(error)}`);
        return;
      }

      setConfig(settings);
      setDraftConfig(settings);
    }

    setShowSettings(false);
  };

  const runGpuBenchmark = async () => {
    setErrorMessage(null);
    const gpuDeviceId = sanitizeGpuDeviceId(draftConfig.gpu_device_id, gpuDevices);

    try {
      const result = await invoke<GpuBenchmarkResult>("run_gpu_benchmark", {
        gpuDeviceId,
        gpuIntensityPercent: Number(draftConfig.gpu_intensity_percent),
      });
      setBenchmarkResult(result);
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not run GPU benchmark: ${formatError(error)}`);
        return;
      }

      const gpuIntensityPercent = Number(draftConfig.gpu_intensity_percent);
      setBenchmarkResult({
        device_id: gpuDeviceId || "auto",
        device_name:
          gpuDevices.find((device) => device.id === gpuDeviceId)?.name || "Auto",
        simulated: true,
        gpu_intensity_percent: gpuIntensityPercent,
        hashrate: 120_000_000 * gpuIntensityPercent / 10,
        duration_ms: 250,
        note: "Simulated benchmark only. No real GPU workload was started.",
        generated_at: new Date().toISOString(),
      });
    }
  };

  const runPoolDiagnostic = async () => {
    setErrorMessage(null);
    setPoolDiagnosticResult(null);

    const settings = normalizeAppConfig(draftConfig, systemInfo, gpuDevices);

    try {
      const result = await invoke<PoolDiagnosticReport>("diagnose_pool_connection", {
        settings: {
          poolHost: settings.pool_host,
          poolPort: settings.pool_port,
          poolPassword: settings.pool_password,
          btcAddress: settings.btc_address,
          workerName: settings.worker_name,
        },
      });
      setPoolDiagnosticResult(result);
      appendDevLog("diagnostic", `Pool diagnostic: ${result.summary}`);
      appendPetLog("Pool diagnostic finished.");
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not run pool diagnostic: ${formatError(error)}`);
        return;
      }

      const result: PoolDiagnosticReport = {
        generated_at: new Date().toISOString(),
        pool: `${settings.pool_host}:${settings.pool_port}`,
        steps: [
          {
            name: "DESKTOP",
            status: "skipped",
            message: "Pool diagnostics require the desktop runtime.",
            duration_ms: 0,
          },
        ],
        summary: "Desktop runtime required for pool diagnostics.",
      };
      setPoolDiagnosticResult(result);
      appendDevLog("diagnostic", `Pool diagnostic: ${result.summary}`);
      appendPetLog("Pool diagnostic needs the desktop app.");
    }
  };

  const {
    openLogs,
    copyLogPath,
    copyDiagnostics,
    saveDiagnostics,
  } = useDiagnosticsActions({
    runningInTauri,
    setErrorMessage,
    setPetLogMessage: appendPetLog,
    getDevLogSnapshot: () => devLogs
      .slice(0, 40)
      .map((entry) => `[${entry.timestamp}] ${entry.source}: ${entry.message}`)
      .join("\n"),
  });

  const toggleAlwaysOnTop = async () => {
    setErrorMessage(null);

    const nextValue = !alwaysOnTop;

    try {
      await invoke("set_window_always_on_top", { alwaysOnTop: nextValue });
      setAlwaysOnTop(nextValue);
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not update always-on-top: ${formatError(error)}`);
        return;
      }

      setAlwaysOnTop(nextValue);
    }
  };

  const petStateContext = {
    isMining,
    realModeEnabled,
    isCoolingDown,
    attentionEventType: attentionEvent?.type ?? null,
    jackpotPhase: jackpotSequence.phase,
    computeMode: config.compute_mode,
    connectionStatus: realStats.connection_status,
    currentJobId: realStats.current_job_id,
  };
  const petState = derivePetState(petStateContext);
  const petStatus: PetStatus = petStatusFromState(petState, petStateContext);

  const engineLifecycle: MiningEngineLifecycle = {
    prepareStart: prepareMiningStart,
    startSimulation: startSimulationSession,
    startReal: startRealMiningSession,
    stopSimulation: stopSimulationSession,
    stopReal: stopRealMiningSession,
    status: (kind: MiningEngineKind) => ({
      kind,
      petState,
      running: isMining,
      label: petStateLabel(petState),
    }),
  };
  const miningEngine: MiningEngine = !realModeEnabled
    ? createSimulationEngineAdapter(engineLifecycle)
    : selectedMiningMode === "solo"
      ? createStratumEngine(engineLifecycle)
      : config.compute_mode === "cpu"
        ? createCpuEngine(engineLifecycle)
      : config.compute_mode === "gpu"
        ? createGpuEngine(engineLifecycle)
        : createGpuEngine(engineLifecycle);
  const miningEngineStatus = miningEngine.status();

  useEffect(() => {
    if (!attentionEvent) {
      return;
    }

    const timer = window.setTimeout(() => setAttentionEvent(null), 3000);
    return () => window.clearTimeout(timer);
  }, [attentionEvent]);

  useEffect(() => {
    const duration = jackpotPhaseDurationMs(jackpotSequence.phase);
    if (duration === null) {
      return;
    }

    const sequenceId = jackpotSequence.id;
    const timer = window.setTimeout(() => {
      setJackpotSequence((current) => (
        current.id === sequenceId
          ? { ...current, phase: nextJackpotPhase(current.phase) }
          : current
      ));
    }, duration);

    return () => window.clearTimeout(timer);
  }, [jackpotSequence.id, jackpotSequence.phase]);

  useEffect(() => {
    if (jackpotSequence.phase !== "resume") {
      return;
    }

    let cancelled = false;
    const resumeMining = async () => {
      if (jackpotSequence.wasMining && jackpotSequence.engineKind) {
        if (jackpotSequence.engineKind === "simulation") {
          startSimulationSession();
        } else {
          await startRealMiningConfirmed(realCpuThreadsForConfig());
        }
      }

      if (!cancelled) {
        setJackpotSequence((current) => (
          current.id === jackpotSequence.id
            ? { ...current, phase: "complete" }
            : current
        ));
      }
    };

    void resumeMining();
    return () => {
      cancelled = true;
    };
  }, [
    jackpotSequence.engineKind,
    jackpotSequence.id,
    jackpotSequence.phase,
    jackpotSequence.wasMining,
  ]);

  const dismissJackpotSequence = () => {
    setJackpotSequence((current) => (
      current.phase === "idle" || current.phase === "complete"
        ? idleJackpotSequence
        : { ...current, phase: "resume" }
    ));
  };
  const jackpotVisible = isJackpotOverlayVisible(jackpotSequence);
  const jackpotBlock = jackpotSequence.block;

  const sharesValue = realModeEnabled
    ? `${realStats.accepted_shares} / ${realStats.rejected_shares}`
    : `${simAccepted} / ${simRejected}`;

  const displayedHashrate = realModeEnabled
    ? formatHashrate(realStats.hashrate)
    : `${simulationStats.hashrate.toFixed(2)} MH/s`;
  const probabilitySnapshot: ProbabilitySnapshot = calculateProbabilitySnapshot({
    currentDifficulty: null,
    hashrate: realModeEnabled ? realStats.hashrate : simulationStats.hashrate * 1_000_000,
    bestDifficulty: activeBestDiff,
    acceptedShares: realModeEnabled ? realStats.accepted_shares : simAccepted,
    rejectedShares: realModeEnabled ? realStats.rejected_shares : simRejected,
    miningUptimeSeconds: miningUptime,
    realModeEnabled,
  });
  const compactComputeMode = realModeEnabled
    ? gpuEnabled ? (config.compute_mode === "hybrid" ? "CPU+GPU" : "GPU") : "CPU"
    : "SIM";
  const statusClassName = petState === "LUCKY_EVENT" ? "flash" : "";
  const isMiningAnimation = isAnimatedMiningState(petState);
  const displayStatus = petStatus === "Jackpot" ? "JACKPOT" : petStatus;
  const poolStatus = `${config.pool_host}:${config.pool_port}`;
  const authStatus =
    realStats.connection_status === "Authorized" || realStats.connection_status === "Mining"
      ? "Authorized"
      : realStats.connection_status;
  const jobStatus = realStats.current_job_id || "Waiting";
  const shareDifficultyValue = realModeEnabled && realStats.share_difficulty > 0
    ? formatDifficulty(realStats.share_difficulty)
    : "Waiting";
  const shareRateValue = realModeEnabled
    ? formatShareRate(expectedSharesPerHour(realStats.hashrate, realStats.share_difficulty))
    : "SIM";
  const currentDifficultyValue = probabilitySnapshot.currentDifficulty
    ? formatDifficulty(probabilitySnapshot.currentDifficulty)
    : "Waiting";
  const effectiveCpuThreads = threadsForPreset(
    config.performance_preset,
    systemInfo,
    config.cpu_threads,
    config.compute_mode === "gpu",
  );

  const modeLabel = realModeEnabled
    ? config.compute_mode === "gpu"
      ? "GPU"
      : config.compute_mode === "hybrid"
        ? (effectiveCpuThreads > 0 ? "CPU + GPU" : "GPU")
        : "CPU"
    : "Simulation";

  const gpuConfigMetrics: [string, string][] =
    config.compute_mode !== "cpu" ? [["GPU LIMIT", `${config.gpu_intensity_percent}%`]] : [];
  const gpuRuntimeMetrics: [string, string][] = realModeEnabled && gpuEnabled
    ? [
        ["GPU BACKEND", realStats.gpu_backend || "Starting"],
        ["GPU DEVICE", realStats.gpu_device_name || "Detecting"],
        [
          "GPU DISPATCH",
          realStats.gpu_dispatch_size
            ? `${formatDispatchSize(realStats.gpu_dispatch_size)} / ${realStats.gpu_dispatch_ms}ms`
            : "Waiting",
        ],
        ["GPU THROTTLE", realStats.gpu_throttle_ms ? `${realStats.gpu_throttle_ms}ms` : "Off"],
      ]
    : [];

  const resourceMetrics: [string, string][] = [
    ["MODE SELECT", miningModeLabel(selectedMiningMode)],
    ["ENGINE", miningEngineStatus.kind.toUpperCase()],
    ["PET STATE", miningEngineStatus.label],
    ["EVENT", miningEventLabel(lastMiningEvent)],
    ["PET LOGS", `${petLogs.length}`],
    ["DEV LOGS", `${devLogs.length}`],
    ["PRESET", performancePresetLabel(config.performance_preset)],
    ["CPU THREADS", `${effectiveCpuThreads}`],
    ["RECOMMENDED", `${systemInfo.recommended_cpu_threads}`],
    ["MODE", modeLabel],
    ...gpuConfigMetrics,
    ...gpuRuntimeMetrics,
  ];
  const metrics: [string, string][] = [
    ["HASHRATE", displayedHashrate],
    ["BEST DIFF", formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)],
    ["LUCK", `${probabilitySnapshot.luckMeter}%`],
    ["STREAK", `${probabilitySnapshot.streakCounter}`],
    ["NET DIFF", currentDifficultyValue],
    ["ETA BLOCK", formatProbabilityTime(probabilitySnapshot.estimatedTimeToBlockSeconds)],
    ["POOL DIFF", shareDifficultyValue],
    ["SHARES/H", shareRateValue],
    ["BLOCK HEIGHT", blockHeight],
    ["SHARES A / R", sharesValue],
    ["APP UPTIME", formatUptime(appUptime)],
    ["MINING UPTIME", formatUptime(miningUptime)],
  ];

  const isDraftGpuOnly = draftConfig.compute_mode === "gpu";
  const hardwareGpuAvailable = hasHardwareGpuDevice(gpuDevices);
  const softwareGpuAvailable = hasSoftwareGpuDevice(gpuDevices);
  const draftEffectiveCpuThreads = threadsForPreset(
    draftConfig.performance_preset,
    systemInfo,
    Number(draftConfig.cpu_threads),
    isDraftGpuOnly,
  );
  const cpuThreadOptions = useMemo(() => {
    const available = Math.max(1, systemInfo.available_parallelism);
    const rec = systemInfo.recommended_cpu_threads;
    const base = isDraftGpuOnly ? [0] : [1, 2, rec, draftEffectiveCpuThreads, 4, available];
    return Array.from(new Set(base))
      .filter((threads) => threads <= available && (isDraftGpuOnly ? threads === 0 : threads >= 1))
      .sort((left, right) => left - right);
  }, [
    draftEffectiveCpuThreads,
    systemInfo.available_parallelism,
    systemInfo.recommended_cpu_threads,
    isDraftGpuOnly,
  ]);

  return (
    <main className={`pet-shell ${displayMode} ${petState === "LUCKY_EVENT" ? "lucky" : ""} jackpot-${jackpotSequence.phase}`}>
      <Header
        realModeEnabled={realModeEnabled}
        computeMode={config.compute_mode}
        displayMode={displayMode}
        setDisplayMode={setDisplayMode}
        isMining={isMining}
        openModeSelection={openModeSelection}
        alwaysOnTop={alwaysOnTop}
        toggleAlwaysOnTop={toggleAlwaysOnTop}
      />

      <section className="status-row">
        <PetDisplay
          petStatus={petStatus}
          isMiningAnimation={isMiningAnimation}
          displayMode={displayMode}
          compactComputeMode={compactComputeMode}
          displayedHashrate={displayedHashrate}
          realModeEnabled={realModeEnabled}
          realStats={realStats}
          simulationStats={simulationStats}
          blockHeight={blockHeight}
          formatDifficulty={formatDifficulty}
        />

        <div className="status-copy">
          <p className="label">STATUS</p>
          <p className={`status ${statusClassName}`} title={petStatus}>
            {displayStatus}
          </p>
        </div>
        <div className="luck-meter" title="Display-only luck meter">
          <span>LUCK</span>
          <b>{probabilitySnapshot.luckMeter}%</b>
          <div>
            <i style={{ width: `${probabilitySnapshot.luckMeter}%` }} />
          </div>
        </div>
        <button
          className={isMining ? "control-button stop" : "control-button start"}
          disabled={!selectedMiningMode}
          onClick={isMining ? miningEngine.stop : miningEngine.start}
          type="button"
        >
          {isMining ? "STOP" : "START"}
        </button>
      </section>

      <MetricsGrid
        displayMode={displayMode}
        realModeEnabled={realModeEnabled}
        metrics={metrics}
        resourceMetrics={resourceMetrics}
        poolStatus={poolStatus}
        authStatus={authStatus}
        jobStatus={jobStatus}
        lastShare={lastShare}
      />

      <LogTicker
        displayMode={displayMode}
        latestLog={latestLog}
        openLogs={openLogs}
        copyLogPath={copyLogPath}
        copyDiagnostics={copyDiagnostics}
        saveDiagnostics={saveDiagnostics}
      />

      <footer>
        <span className={`dot ${realModeEnabled ? "armed" : ""}`} />
        {miningModeLabel(selectedMiningMode)} · {realModeEnabled
          ? config.compute_mode === "gpu"
            ? "GPU real mining"
            : config.compute_mode === "hybrid"
              ? (effectiveCpuThreads > 0 ? "CPU + GPU real mining" : "GPU real mining")
              : "CPU real mining"
          : "Simulation"}
        <button
          className="settings-button"
          disabled={isMining}
          onClick={() => setShowSettings(true)}
          type="button"
        >
          SETTINGS
        </button>
        <span className="cpu">{effectiveCpuThreads} thread{effectiveCpuThreads === 1 ? "" : "s"}</span>
      </footer>

      {errorMessage && (
        <p className="error-banner" onClick={() => setErrorMessage(null)} title="Click to dismiss">
          {errorMessage}
        </p>
      )}

      {showModeSelection && (
        <section className="overlay mode-selection-overlay" role="dialog" aria-modal="true" aria-label="Choose mining mode">
          <div className="warning-card mode-selection-card">
            <p className="eyebrow">CHOOSE MODE</p>
            <h2>BTC Lottery Pet</h2>
            <div className="mode-selection-grid">
              {miningModeOptions.map((option) => (
                <button
                  className="mode-choice"
                  key={option.mode}
                  onClick={() => selectMiningMode(option.mode)}
                  type="button"
                >
                  <span>{option.title}</span>
                  <b>{option.label}</b>
                  <small>{option.description}</small>
                </button>
              ))}
            </div>
            {selectedMiningMode && (
              <div className="panel-actions mode-selection-actions">
                <button className="secondary-button" onClick={() => setShowModeSelection(false)} type="button">
                  KEEP CURRENT
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {showCpuWarning && (
        <section className="overlay" role="dialog" aria-modal="true" aria-label="High CPU warning">
          <div className="warning-card">
            <p className="eyebrow">CPU WARNING</p>
            <h2>High CPU usage</h2>
            <p>
              High CPU usage may heat your computer. Are you sure you want to continue?
            </p>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => setShowCpuWarning(false)} type="button">
                CANCEL
              </button>
              <button
                className="confirm-button"
                onClick={() => void confirmCpuWarning()}
                type="button"
              >
                CONTINUE
              </button>
            </div>
          </div>
        </section>
      )}

      {showSettings && (
        <SettingsPanel
          draftConfig={draftConfig}
          setDraftConfig={setDraftConfig}
          setShowSettings={setShowSettings}
          saveSettings={saveSettings}
          runGpuBenchmark={runGpuBenchmark}
          runPoolDiagnostic={runPoolDiagnostic}
          benchmarkResult={benchmarkResult}
          poolDiagnosticResult={poolDiagnosticResult}
          gpuDevices={gpuDevices}
          systemInfo={systemInfo}
          formatHashrate={formatHashrate}
          sanitizeGpuDeviceId={sanitizeGpuDeviceId}
          presetPort={presetPort}
          threadsForPreset={threadsForPreset}
          isGpuComputeMode={isGpuComputeMode}
          hasHardwareGpuDevice={hasHardwareGpuDevice}
          hasSoftwareGpuDevice={hasSoftwareGpuDevice}
        />
      )}

      {jackpotVisible && jackpotBlock && (
        <section className="overlay jackpot-overlay" role="dialog" aria-modal="true" aria-label="Block candidate found">
          <div className="jackpot-particles" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="warning-card jackpot-card">
            <p className="eyebrow">{jackpotPhaseLabel(jackpotSequence.phase)}</p>
            <h2>JACKPOT</h2>
            <p>
              Network target met. The candidate was saved to found_block.json in the app log folder.
            </p>
            <dl>
              <div>
                <dt>Job</dt>
                <dd>{jackpotBlock.job_id}</dd>
              </div>
              <div>
                <dt>Nonce</dt>
                <dd>{jackpotBlock.nonce}</dd>
              </div>
              <div>
                <dt>Pool</dt>
                <dd>{jackpotBlock.pool}</dd>
              </div>
              <div>
                <dt>Difficulty</dt>
                <dd>{formatDifficulty(jackpotBlock.difficulty)}</dd>
              </div>
              <div>
                <dt>Timestamp</dt>
                <dd title={jackpotBlock.timestamp}>{jackpotBlock.timestamp}</dd>
              </div>
              <div>
                <dt>Hash</dt>
                <dd title={jackpotBlock.hash}>{jackpotBlock.hash}</dd>
              </div>
            </dl>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => void openLogs()} type="button">
                OPEN LOGS
              </button>
              <button className="confirm-button" onClick={dismissJackpotSequence} type="button">
                DISMISS
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
