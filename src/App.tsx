import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState, useRef } from "react";
import Header from "./components/Header";
import PetDisplay from "./components/PetDisplay";
import MetricsGrid from "./components/MetricsGrid";
import SettingsPanel from "./components/SettingsPanel";
import LogTicker from "./components/LogTicker";
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
  ComputeMode,
  GpuBenchmarkResult,
  GpuDevice,
  PetStatus,
  PerformancePreset,
  PoolDiagnosticReport,
  RealMiningStats,
  SimulationStats,
  SystemInfo,
} from "./miningLogic";
export type {
  AppConfig,
  BlockFoundEvent,
  ComputeMode,
  GpuBenchmarkResult,
  GpuDevice,
  HeartbeatInterval,
  NotificationChannel,
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
  const [showWarning, setShowWarning] = useState(false);
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
  const [latestLog, setLatestLog] = useState("[System] Ready");
  const [lastShare, setLastShare] = useState("None");
  const [blockFound, setBlockFound] = useState<BlockFoundEvent | null>(null);
  const [showJackpot, setShowJackpot] = useState(false);

  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [isLucky, setIsLucky] = useState(false);
  const [isNewBest, setIsNewBest] = useState(false);
  const [displayMode, setDisplayMode] = useState<"compact" | "detail">("compact");
  const [systemInfo, setSystemInfo] = useState<SystemInfo>(fallbackSystemInfo);
  const [gpuDevices, setGpuDevices] = useState<GpuDevice[]>(fallbackGpuDevices);
  const [benchmarkResult, setBenchmarkResult] = useState<GpuBenchmarkResult | null>(null);
  const [poolDiagnosticResult, setPoolDiagnosticResult] =
    useState<PoolDiagnosticReport | null>(null);

  const coolingDownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simShareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simLuckyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useLatestRef(config);
  const realStatsRef = useLatestRef(realStats);
  const simulationStatsRef = useLatestRef(simulationStats);
  const appUptimeRef = useLatestRef(appUptime);
  const miningUptimeRef = useLatestRef(miningUptime);
  const simAcceptedRef = useLatestRef(simAccepted);
  const simRejectedRef = useLatestRef(simRejected);
  const realModeEnabledRef = useLatestRef(realModeEnabled);
  const isMiningRef = useLatestRef(isMining);
  const lastConnectionNotificationRef = useRef(0);

  // Component unmount cleanup
  useEffect(() => {
    return () => {
      if (coolingDownTimerRef.current) clearTimeout(coolingDownTimerRef.current);
      if (simShareTimerRef.current) clearTimeout(simShareTimerRef.current);
      if (simLuckyTimerRef.current) clearTimeout(simLuckyTimerRef.current);
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
      setLatestLog(message);

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
        if (shouldSyncRealMining) {
          // Share count is tracked by the backend via mining-stats events.
          // We only trigger the notification here.
          void invoke("notify_share_accepted", {
            settings: notificationSettingsFromConfig(configRef.current),
          }).catch(() => {});
        }
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
  }, []);

  // Listen to Block Candidate Events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;

    listen<BlockFoundEvent>("block-found", (event) => {
      setBlockFound(event.payload);
      setShowJackpot(true);
      setIsLucky(false);
      setIsNewBest(false);
      setLatestLog(`[Jackpot] Block candidate found: job=${event.payload.job_id}, hash=${event.payload.hash}`);
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
  }, []);

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
    simLuckyTimerRef,
    setLatestLog,
    setSimAccepted,
    setSimRejected,
    setSimulationStats,
    setIsLucky,
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
        setIsNewBest(true);
        const timer = setTimeout(() => setIsNewBest(false), 3000);
        prevBestDiffRef.current = activeBestDiff;
        return () => clearTimeout(timer);
      }
      prevBestDiffRef.current = activeBestDiff;
    }
  }, [activeBestDiff, isMining]);

  // Track Real Accepted Shares for Lucky Trigger
  const prevAcceptedSharesRef = useRef(0);

  useEffect(() => {
    if (!isMining || !realModeEnabled) {
      prevAcceptedSharesRef.current = realStats.accepted_shares;
      return;
    }
    if (realStats.accepted_shares > prevAcceptedSharesRef.current) {
      if (prevAcceptedSharesRef.current > 0) {
        setIsLucky(true);
        const timer = setTimeout(() => setIsLucky(false), 3000);
        prevAcceptedSharesRef.current = realStats.accepted_shares;
        return () => clearTimeout(timer);
      }
      prevAcceptedSharesRef.current = realStats.accepted_shares;
    }
  }, [realStats.accepted_shares, isMining, realModeEnabled]);

  const startRealMiningConfirmed = async (realCpuThreads: number) => {
    isMiningRef.current = true;
    setIsMining(true);
    prevAcceptedSharesRef.current = 0;
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
      setRealStats((current) => ({ ...current, connection_status: "Stopped" }));
    }
  };

  const startMining = async () => {
    setErrorMessage(null);
    setMiningUptime(0);
    setIsCoolingDown(false);
    setLastShare("None");
    if (coolingDownTimerRef.current) {
      clearTimeout(coolingDownTimerRef.current);
      coolingDownTimerRef.current = null;
    }

    if (!realModeEnabled) {
      isMiningRef.current = true;
      setIsMining(true);
      setSimAccepted(0);
      setSimRejected(0);
      setSimulationStats((current) => ({
        ...current,
        status: "Mining",
      }));
      return;
    }

    const startError = realMiningStartError(config, gpuDevices, runningInTauri);
    if (startError) {
      setErrorMessage(startError);
      setShowSettings(true);
      return;
    }

    const realCpuThreads = threadsForPreset(
      config.performance_preset,
      systemInfo,
      config.cpu_threads,
      config.compute_mode === "gpu",
    );
    const highCpuRequested =
      realCpuThreads > 0 &&
      (config.performance_preset === "turbo" ||
        realCpuThreads > systemInfo.recommended_cpu_threads);

    if (highCpuRequested) {
      setShowCpuWarning(true);
      return;
    }

    await startRealMiningConfirmed(realCpuThreads);
  };

  const confirmCpuWarning = async () => {
    setShowCpuWarning(false);
    const realCpuThreads = threadsForPreset(
      config.performance_preset,
      systemInfo,
      config.cpu_threads,
      config.compute_mode === "gpu",
    );
    await startRealMiningConfirmed(realCpuThreads);
  };

  const stopMining = async () => {
    isMiningRef.current = false;
    setIsMining(false);
    setIsCoolingDown(true);

    // Clear simulation timers immediately to avoid late logs/flashes after STOP
    if (simShareTimerRef.current) {
      clearTimeout(simShareTimerRef.current);
      simShareTimerRef.current = null;
    }
    if (simLuckyTimerRef.current) {
      clearTimeout(simLuckyTimerRef.current);
      simLuckyTimerRef.current = null;
    }
    setIsLucky(false);
    setIsNewBest(false);

    if (coolingDownTimerRef.current) {
      clearTimeout(coolingDownTimerRef.current);
    }
    coolingDownTimerRef.current = setTimeout(() => {
      setIsCoolingDown(false);
      coolingDownTimerRef.current = null;
    }, 4000);

    if (realModeEnabled) {
      setRealStats((current) => ({
        ...current,
        hashrate: 0,
        connection_status: "Stopped",
      }));

      try {
        await invoke("stop_real_mining");
      } catch (error) {
        if (runningInTauri) {
          setErrorMessage(`Could not stop mining: ${formatError(error)}`);
        }
      }
      return;
    }

    setSimulationStats((current) => ({
      ...current,
      status: "Sleeping",
      hashrate: 0,
    }));
  };

  const disableRealMode = async () => {
    if (isMining) {
      await stopMining();
    }

    setRealModeEnabled(false);
    setErrorMessage(null);
  };

  const toggleRealMode = () => {
    if (isMining) {
      setErrorMessage("Stop mining before changing modes.");
      return;
    }

    if (realModeEnabled) {
      void disableRealMode();
    } else {
      setShowWarning(true);
    }
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
      setLatestLog(`[System] Pool diagnostic: ${result.summary}`);
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
      setLatestLog(`[System] Pool diagnostic: ${result.summary}`);
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
    setLatestLog,
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

  const isConnectionError =
    isMining &&
    realModeEnabled &&
    (realStats.connection_status.startsWith("Retrying") ||
      realStats.connection_status.toLowerCase().includes("error") ||
      realStats.connection_status.toLowerCase().includes("failed"));
  const connectionStatus = realStats.connection_status.toLowerCase();
  const isConnecting =
    isMining &&
    realModeEnabled &&
    !realStats.current_job_id &&
    ["starting", "connecting", "subscribing", "authorizing", "connected", "authorized"].some((status) =>
      connectionStatus.startsWith(status),
    );

  let petStatus: PetStatus;
  if (blockFound) {
    petStatus = "Jackpot";
  } else if (!isMining && !isCoolingDown) {
    petStatus = "Sleeping";
  } else if (isCoolingDown) {
    petStatus = "Cooling Down";
  } else if (isConnectionError) {
    petStatus = "Connection Error";
  } else if (isConnecting) {
    petStatus = "Connecting";
  } else if (isLucky) {
    petStatus = "Lucky Flash";
  } else if (isNewBest) {
    petStatus = "New Best Diff";
  } else if (realModeEnabled && gpuEnabled) {
    petStatus = "Overdrive";
  } else {
    petStatus = "Mining";
  }

  const sharesValue = realModeEnabled
    ? `${realStats.accepted_shares} / ${realStats.rejected_shares}`
    : `${simAccepted} / ${simRejected}`;

  const displayedHashrate = realModeEnabled
    ? formatHashrate(realStats.hashrate)
    : `${simulationStats.hashrate.toFixed(2)} MH/s`;
  const compactComputeMode = realModeEnabled
    ? gpuEnabled ? (config.compute_mode === "hybrid" ? "CPU+GPU" : "GPU") : "CPU"
    : "SIM";
  const statusClassName = petStatus === "Lucky Flash" || petStatus === "Jackpot" ? "flash" : "";
  const isMiningAnimation = petStatus === "Mining" || petStatus === "Overdrive";
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
    <main className={`pet-shell ${displayMode} ${petStatus === "Lucky Flash" || petStatus === "Jackpot" ? "lucky" : ""}`}>
      <Header
        realModeEnabled={realModeEnabled}
        computeMode={config.compute_mode}
        displayMode={displayMode}
        setDisplayMode={setDisplayMode}
        isMining={isMining}
        toggleRealMode={toggleRealMode}
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
        <button
          className={isMining ? "control-button stop" : "control-button start"}
          onClick={isMining ? stopMining : startMining}
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
        {realModeEnabled
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

      {showWarning && (
        <section className="overlay" role="dialog" aria-modal="true" aria-label="Real mining warning">
          <div className="warning-card">
            <p className="eyebrow">EXPLICIT OPT-IN</p>
            <h2>Enable real mining?</h2>
            <p>
              Real mining mode will connect to a mining pool and use your {config.compute_mode === "gpu" ? "GPU" : config.compute_mode === "hybrid" ? "CPU + GPU" : "CPU"} to mine Bitcoin.
              This is for education and lottery-style solo mining only.
            </p>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => setShowWarning(false)} type="button">
                CANCEL
              </button>
              <button
                className="confirm-button"
                onClick={() => {
                  setRealModeEnabled(true);
                  setShowWarning(false);
                }}
                type="button"
              >
                ENABLE
              </button>
            </div>
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

      {showJackpot && blockFound && (
        <section className="overlay jackpot-overlay" role="dialog" aria-modal="true" aria-label="Block candidate found">
          <div className="warning-card jackpot-card">
            <p className="eyebrow">BLOCK CANDIDATE FOUND</p>
            <h2>JACKPOT</h2>
            <p>
              Network target met. The candidate was saved to found_block.json in the app log folder.
            </p>
            <dl>
              <div>
                <dt>Job</dt>
                <dd>{blockFound.job_id}</dd>
              </div>
              <div>
                <dt>Nonce</dt>
                <dd>{blockFound.nonce}</dd>
              </div>
              <div>
                <dt>Pool</dt>
                <dd>{blockFound.pool}</dd>
              </div>
              <div>
                <dt>Difficulty</dt>
                <dd>{formatDifficulty(blockFound.difficulty)}</dd>
              </div>
              <div>
                <dt>Timestamp</dt>
                <dd title={blockFound.timestamp}>{blockFound.timestamp}</dd>
              </div>
              <div>
                <dt>Hash</dt>
                <dd title={blockFound.hash}>{blockFound.hash}</dd>
              </div>
            </dl>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => void openLogs()} type="button">
                OPEN LOGS
              </button>
              <button className="confirm-button" onClick={() => { setShowJackpot(false); setBlockFound(null); }} type="button">
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
