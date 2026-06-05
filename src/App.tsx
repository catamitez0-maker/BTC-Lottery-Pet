import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState, useRef } from "react";

type PetStatus = "Sleeping" | "Connecting" | "Mining" | "Overdrive" | "Lucky Flash" | "Cooling Down" | "Connection Error" | "New Best Diff" | "Jackpot";
type ComputeMode = "cpu" | "gpu" | "hybrid";
type PerformancePreset = "eco" | "normal" | "turbo" | "custom";
type HeartbeatInterval = "off" | "30min" | "1h" | "6h";
type NotificationChannel = "local_windows_toast" | "webhook" | "telegram_bot" | "ntfy_sh";

interface AppConfig {
  btc_address: string;
  pool_host: string;
  pool_port: number;
  worker_name: string;
  cpu_limit_percent: number;
  cpu_threads: number;
  performance_preset: PerformancePreset;
  real_mining_enabled: boolean;
  enable_notifications: boolean;
  notify_on_jackpot: boolean;
  notify_on_share_accepted: boolean;
  notify_on_connection_error: boolean;
  heartbeat_interval: HeartbeatInterval;
  notification_channel: NotificationChannel;
  webhook_url: string;
  compute_mode: ComputeMode;
  gpu_enabled: boolean;
  gpu_device_id: string | null;
  gpu_intensity_percent: number;
}

interface SystemInfo {
  available_parallelism: number;
  default_cpu_threads: number;
  recommended_cpu_threads: number;
}

interface GpuDevice {
  id: string;
  name: string;
  simulated: boolean;
}

interface GpuBenchmarkResult {
  device_id: string;
  device_name: string;
  simulated: boolean;
  gpu_intensity_percent: number;
  hashrate: number;
  duration_ms: number;
  note: string;
}

interface SimulationStats {
  status: PetStatus;
  hashrate: number;
  bestDifficulty: number;
}

interface RealMiningStats {
  hashrate: number;
  accepted_shares: number;
  rejected_shares: number;
  best_difficulty: number;
  current_job_id: string;
  connection_status: string;
}

interface BlockFoundEvent {
  job_id: string;
  nonce: string;
  ntime: string;
  extranonce2: string;
  hash: string;
  difficulty: number;
  timestamp: string;
  pool: string;
}

const fallbackConfig: AppConfig = {
  btc_address: "",
  pool_host: "public-pool.io",
  pool_port: 21496,
  worker_name: "btc-lottery-pet",
  cpu_limit_percent: 10,
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
  current_job_id: "",
  connection_status: "Stopped",
};

const runningInTauri = isTauri();

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function presetPort(poolHost: string, currentPort: number) {
  if (poolHost === "public-pool.io") {
    return 21496;
  }

  if (poolHost === "pool.nerdminers.org") {
    return 3333;
  }

  return currentPort;
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return [hours, minutes, remainingSeconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function formatDifficulty(value: number) {
  return value < 1_000
    ? value.toFixed(4)
    : Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatHashrate(hashrate: number) {
  if (hashrate >= 1_000_000) {
    return `${(hashrate / 1_000_000).toFixed(2)} MH/s`;
  }

  if (hashrate >= 1_000) {
    return `${(hashrate / 1_000).toFixed(2)} KH/s`;
  }

  return `${hashrate.toFixed(0)} H/s`;
}

function threadsForPreset(
  preset: PerformancePreset,
  systemInfo: SystemInfo,
  customThreads: number,
  gpuEnabled = false,
) {
  switch (preset) {
    case "eco":
      return gpuEnabled ? 0 : 1;
    case "normal":
      return gpuEnabled ? 0 : systemInfo.recommended_cpu_threads;
    case "turbo":
      return gpuEnabled
        ? systemInfo.available_parallelism
        : systemInfo.available_parallelism;
    case "custom":
      return Math.min(Math.max(gpuEnabled ? 0 : 1, customThreads), systemInfo.available_parallelism);
  }
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

function notificationSettingsFromConfig(config: AppConfig) {
  return {
    enableNotifications: config.enable_notifications,
    notifyOnJackpot: config.notify_on_jackpot,
    notifyOnShareAccepted: config.notify_on_share_accepted,
    notifyOnConnectionError: config.notify_on_connection_error,
    heartbeatInterval: config.heartbeat_interval,
    notificationChannel: config.notification_channel,
    webhookUrl: config.webhook_url,
  };
}

function heartbeatIntervalMs(interval: HeartbeatInterval) {
  switch (interval) {
    case "30min":
      return 30 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "6h":
      return 6 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function getPetExpression(status: PetStatus): string {
  switch (status) {
    case "Sleeping":
      return "( -ω- )zzZ";
    case "Connecting":
      return "( ._.)";
    case "Cooling Down":
      return "( ~_~ )";
    case "Connection Error":
      return "( x_x )";
    case "Jackpot":
      return "( ₿∀₿ )";
    case "Lucky Flash":
      return "( ★∀★ )";
    case "New Best Diff":
      return "( ≧▽≦ )";
    case "Overdrive":
      return "( >_> )!";
    case "Mining":
      return "( •̀_•́ )";
    default:
      return "( •̀_•́ )";
  }
}

function getSlotChar(status: PetStatus, index: number): string {
  switch (status) {
    case "Sleeping":
      return ["Z", "z", "Z"][index];
    case "Connecting":
      return ["C", "N", "N"][index];
    case "Cooling Down":
      return ["C", "O", "L"][index];
    case "Connection Error":
      return ["E", "R", "R"][index];
    case "Jackpot":
      return ["₿", "₿", "₿"][index];
    case "Lucky Flash":
      return ["₿", "₿", "₿"][index];
    case "New Best Diff":
      return ["B", "S", "T"][index];
    case "Overdrive":
      return ["G", "P", "U"][index];
    default:
      return "-";
  }
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
  const [showSettings, setShowSettings] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [realStats, setRealStats] = useState<RealMiningStats>(idleRealStats);
  const [simulationStats, setSimulationStats] = useState<SimulationStats>({
    status: "Sleeping",
    hashrate: 0,
    bestDifficulty: 0.01,
  });

  const [simAccepted, setSimAccepted] = useState(0);
  const [simRejected, setSimRejected] = useState(0);
  const [blockHeight, setBlockHeight] = useState("Loading...");
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

  const coolingDownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simShareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simLuckyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef(config);
  const realStatsRef = useRef(realStats);
  const simulationStatsRef = useRef(simulationStats);
  const appUptimeRef = useRef(appUptime);
  const miningUptimeRef = useRef(miningUptime);
  const simAcceptedRef = useRef(simAccepted);
  const simRejectedRef = useRef(simRejected);
  const realModeEnabledRef = useRef(realModeEnabled);
  const isMiningRef = useRef(isMining);
  const lastConnectionNotificationRef = useRef(0);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    realStatsRef.current = realStats;
  }, [realStats]);

  useEffect(() => {
    simulationStatsRef.current = simulationStats;
  }, [simulationStats]);

  useEffect(() => {
    appUptimeRef.current = appUptime;
  }, [appUptime]);

  useEffect(() => {
    miningUptimeRef.current = miningUptime;
  }, [miningUptime]);

  useEffect(() => {
    simAcceptedRef.current = simAccepted;
  }, [simAccepted]);

  useEffect(() => {
    simRejectedRef.current = simRejected;
  }, [simRejected]);

  useEffect(() => {
    realModeEnabledRef.current = realModeEnabled;
  }, [realModeEnabled]);

  useEffect(() => {
    isMiningRef.current = isMining;
  }, [isMining]);

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

  // Fetch Block Height
  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;
    let requestSequence = 0;

    const getBlockHeight = async () => {
      const requestId = ++requestSequence;
      const urls = [
        "https://mempool.space/api/blocks/tip/height",
        "https://blockstream.info/api/blocks/tip/height",
        "https://blockchain.info/q/getblockcount"
      ];

      activeController?.abort();

      for (const url of urls) {
        if (disposed || requestId !== requestSequence) {
          return;
        }

        const controller = new AbortController();
        activeController = controller;
        const timeout = window.setTimeout(() => controller.abort(), 5_000);

        try {
          const res = await fetch(url, { signal: controller.signal });
          if (res.ok) {
            const val = await res.text();
            const num = parseInt(val.trim(), 10);
            if (!isNaN(num) && num > 0) {
              if (!disposed && requestId === requestSequence) {
                setBlockHeight(num.toLocaleString());
              }
              return;
            }
          }
        } catch (e) {
          console.warn(`Failed to fetch block height from ${url}:`, e);
        } finally {
          window.clearTimeout(timeout);
          if (activeController === controller) {
            activeController = null;
          }
        }
      }

      if (!disposed && requestId === requestSequence) {
        setBlockHeight("Offline");
      }
    };

    void getBlockHeight();
    const timer = window.setInterval(() => void getBlockHeight(), 30_000);
    return () => {
      disposed = true;
      requestSequence += 1;
      activeController?.abort();
      window.clearInterval(timer);
    };
  }, []);

  // Heartbeat notifications are deliberately coarse-grained to avoid spam.
  useEffect(() => {
    const intervalMs = heartbeatIntervalMs(config.heartbeat_interval);
    if (!config.enable_notifications || intervalMs === null) {
      return;
    }

    const sendHeartbeat = () => {
      const currentConfig = configRef.current;
      const currentRealStats = realStatsRef.current;
      const currentSimulationStats = simulationStatsRef.current;
      const isRealMode = realModeEnabledRef.current;
      const running = isMiningRef.current;
      const uptimeSeconds = running ? miningUptimeRef.current : appUptimeRef.current;

      void invoke("send_heartbeat_notification", {
        settings: notificationSettingsFromConfig(currentConfig),
        snapshot: {
          status: running
            ? isRealMode
              ? currentRealStats.connection_status
              : currentSimulationStats.status
            : "Sleeping",
          hashrate: isRealMode ? currentRealStats.hashrate : currentSimulationStats.hashrate * 1_000_000,
          acceptedShares: isRealMode ? currentRealStats.accepted_shares : simAcceptedRef.current,
          rejectedShares: isRealMode ? currentRealStats.rejected_shares : simRejectedRef.current,
          bestDifficulty: isRealMode
            ? currentRealStats.best_difficulty
            : currentSimulationStats.bestDifficulty,
          uptime: formatUptime(uptimeSeconds),
          pool: `${currentConfig.pool_host}:${currentConfig.pool_port}`,
        },
      }).catch(() => {});
    };

    const timer = window.setInterval(sendHeartbeat, intervalMs);
    return () => window.clearInterval(timer);
  }, [config.enable_notifications, config.heartbeat_interval]);

  const gpuEnabled = config.compute_mode === "gpu" || config.compute_mode === "hybrid";

  // Simulation Mining Loop
  useEffect(() => {
    if (!isMining || realModeEnabled) {
      return;
    }

    const startSecs = new Date().toLocaleTimeString();
    setLatestLog(`[${startSecs}] Connecting to simulation pool...`);
    const t1 = setTimeout(() => {
      setLatestLog(`[${new Date().toLocaleTimeString()}] Connected to simulation pool`);
    }, 600);
    const t2 = setTimeout(() => {
      setLatestLog(`[${new Date().toLocaleTimeString()}] Subscribed to simulation pool`);
    }, 1200);
    const t3 = setTimeout(() => {
      setLatestLog(`[${new Date().toLocaleTimeString()}] Authorized worker successfully`);
    }, 1800);

    const updateStats = () => {
      const rand = Math.random();
      const timeStr = new Date().toLocaleTimeString();

      if (rand < 0.12) {
        const isShareAccepted = Math.random() < 0.95;
        const jobNum = Math.floor(Math.random() * 1000);
        const nonceHex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');

        setLatestLog(`[${timeStr}] Share submitted: job_id=sim-${jobNum}, nonce=${nonceHex}`);

        if (simShareTimerRef.current) {
          clearTimeout(simShareTimerRef.current);
        }
        simShareTimerRef.current = setTimeout(() => {
          if (isShareAccepted) {
            setSimAccepted((a) => a + 1);
            setLatestLog(`[${new Date().toLocaleTimeString()}] Share accepted!`);
            setIsLucky(true);
            if (simLuckyTimerRef.current) {
              clearTimeout(simLuckyTimerRef.current);
            }
            simLuckyTimerRef.current = setTimeout(() => {
              setIsLucky(false);
              simLuckyTimerRef.current = null;
            }, 3000);
          } else {
            setSimRejected((r) => r + 1);
            setLatestLog(`[${new Date().toLocaleTimeString()}] Share rejected. Reason: share target out of range`);
          }
          simShareTimerRef.current = null;
        }, 300);
      } else if (rand < 0.3) {
        const jobNum = Math.floor(Math.random() * 1000);
        setLatestLog(`[${timeStr}] Job received: id=sim-${jobNum}, diff=0.01`);
      }

      const luckyFlash = Math.random() < 0.08;
      const candidateDifficulty = Math.random() * Math.random() * 4_500;
      const intensityScale = config.gpu_intensity_percent / 10;
      const addedHashrate = 0.85 + Math.random() * 0.7;

      setSimulationStats((current) => ({
        status: luckyFlash ? "Lucky Flash" : "Mining",
        hashrate: addedHashrate,
        bestDifficulty: Math.max(current.bestDifficulty, candidateDifficulty),
      }));
    };

    updateStats();
    const timer = window.setInterval(updateStats, 1000);
    return () => {
      window.clearInterval(timer);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      if (simShareTimerRef.current) {
        clearTimeout(simShareTimerRef.current);
        simShareTimerRef.current = null;
      }
      if (simLuckyTimerRef.current) {
        clearTimeout(simLuckyTimerRef.current);
        simLuckyTimerRef.current = null;
      }
      setIsLucky(false);
      setLatestLog(`[${new Date().toLocaleTimeString()}] Mining stopped`);
    };
  }, [config.gpu_intensity_percent, isMining, realModeEnabled]);

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

  const startMining = async () => {
    setErrorMessage("");
    setMiningUptime(0);
    setIsCoolingDown(false);
    setBlockFound(null);
    setShowJackpot(false);
    setLastShare("None");
    if (coolingDownTimerRef.current) {
      clearTimeout(coolingDownTimerRef.current);
      coolingDownTimerRef.current = null;
    }

    if (!realModeEnabled) {
      isMiningRef.current = true;
      setIsMining(true);
      setSimulationStats((current) => ({
        ...current,
        status: "Mining",
      }));
      return;
    }

    if (!config.btc_address) {
      setErrorMessage("Add a BTC address before starting real mining.");
      setShowSettings(true);
      return;
    }

    if (
      (config.performance_preset === "turbo" ||
        config.cpu_threads > systemInfo.recommended_cpu_threads) &&
      !window.confirm("High CPU usage may heat your computer. Continue?")
    ) {
      return;
    }

    isMiningRef.current = true;
    setIsMining(true);
    prevAcceptedSharesRef.current = 0;
    setRealStats((current) => ({
      ...current,
      hashrate: 0,
      accepted_shares: 0,
      rejected_shares: 0,
      current_job_id: "",
      connection_status: "Connecting",
    }));

    try {
      await invoke("start_real_mining", {
        settings: {
          poolHost: config.pool_host,
          poolPort: config.pool_port,
          btcAddress: config.btc_address,
          workerName: config.worker_name,
          cpuThreads: threadsForPreset(
            config.performance_preset,
            systemInfo,
            config.cpu_threads,
            config.gpu_enabled && (config.compute_mode === "gpu" || config.compute_mode === "hybrid"),
          ),
          confirmedCpuUse: true,
          gpuEnabled: config.gpu_enabled,
          gpuDeviceId: config.gpu_device_id,
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
    setBlockFound(null);
    setShowJackpot(false);

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
    setErrorMessage("");
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
    setErrorMessage("");

    const performancePreset = draftConfig.performance_preset;
    const isGpuMode = draftConfig.compute_mode === "gpu" || draftConfig.compute_mode === "hybrid";
    const cpuThreads = threadsForPreset(
      performancePreset,
      systemInfo,
      Number(draftConfig.cpu_threads),
      isGpuMode,
    );

    const settings: AppConfig = {
      ...draftConfig,
      pool_port: Number(draftConfig.pool_port),
      cpu_threads: cpuThreads,
      performance_preset: performancePreset,
      real_mining_enabled: false,
      gpu_enabled: isGpuMode,
      gpu_device_id: isGpuMode ? draftConfig.gpu_device_id : null,
    };

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
    setErrorMessage("");

    try {
      const result = await invoke<GpuBenchmarkResult>("run_gpu_benchmark", {
        gpuDeviceId: draftConfig.gpu_device_id,
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
        device_id: draftConfig.gpu_device_id || "auto",
        device_name:
          gpuDevices.find((device) => device.id === draftConfig.gpu_device_id)?.name || "Auto",
        simulated: true,
        gpu_intensity_percent: gpuIntensityPercent,
        hashrate: 120_000_000 * gpuIntensityPercent / 10,
        duration_ms: 250,
        note: "Simulated benchmark only. No real GPU workload was started.",
      });
    }
  };

  const openLogs = async () => {
    setErrorMessage("");

    try {
      await invoke("open_log_folder");
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not open logs: ${formatError(error)}`);
      } else {
        setErrorMessage("Log folder is available in the desktop app.");
      }
    }
  };

  const copyLogPath = async () => {
    setErrorMessage("");

    try {
      const path = await invoke<string>("get_log_path");
      await navigator.clipboard.writeText(path);
      setLatestLog(`[System] Log path copied: ${path}`);
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not copy log path: ${formatError(error)}`);
      } else {
        setErrorMessage("Log path copy is available in the desktop app.");
      }
    }
  };

  const toggleAlwaysOnTop = async () => {
    setErrorMessage("");

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
  const effectiveCpuThreads = threadsForPreset(
    config.performance_preset,
    systemInfo,
    config.cpu_threads,
    config.gpu_enabled && (config.compute_mode === "gpu" || config.compute_mode === "hybrid"),
  );

  const modeLabel = realModeEnabled
    ? config.compute_mode === "gpu"
      ? "GPU"
      : config.compute_mode === "hybrid"
        ? (effectiveCpuThreads > 0 ? "CPU + GPU" : "GPU")
        : "CPU"
    : "Simulation";

  const resourceMetrics = [
    ["PRESET", performancePresetLabel(config.performance_preset)],
    ["CPU THREADS", `${effectiveCpuThreads}`],
    ["RECOMMENDED", `${systemInfo.recommended_cpu_threads}`],
    ["MODE", modeLabel],
    ...(config.compute_mode !== "cpu" ? [["GPU INTENSITY", `${config.gpu_intensity_percent}%`]] : []),
  ];
  const metrics = [
    ["HASHRATE", displayedHashrate],
    ["BEST DIFF", formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)],
    ["BLOCK HEIGHT", blockHeight],
    ["SHARES A / R", sharesValue],
    ["APP UPTIME", formatUptime(appUptime)],
    ["MINING UPTIME", formatUptime(miningUptime)],
  ];

  const isDraftGpuMode = draftConfig.compute_mode === "gpu" || draftConfig.compute_mode === "hybrid";
  const cpuThreadOptions = useMemo(() => {
    const available = Math.max(1, systemInfo.available_parallelism);
    const rec = systemInfo.recommended_cpu_threads;
    const base = isDraftGpuMode ? [0, 1, 2, rec, 4, available] : [1, 2, rec, 4, available];
    return Array.from(new Set(base))
      .filter((threads) => threads <= available)
      .sort((left, right) => left - right);
  }, [systemInfo.available_parallelism, systemInfo.recommended_cpu_threads, isDraftGpuMode]);

  return (
    <main className={`pet-shell ${displayMode} ${petStatus === "Lucky Flash" || petStatus === "Jackpot" ? "lucky" : ""}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {realModeEnabled
              ? config.compute_mode === "gpu" ? "GPU MINING"
                : config.compute_mode === "hybrid" ? "CPU + GPU MINING"
                : "CPU MINING"
              : "SIMULATION MODE"}
          </p>
          <h1>BTC Lottery Pet</h1>
        </div>
        <div className="header-actions">
          <button
            className={`mode-button ${displayMode === "detail" ? "armed" : ""}`}
            onClick={() => setDisplayMode((mode) => (mode === "compact" ? "detail" : "compact"))}
            title="Toggle compact/detail mode"
            type="button"
          >
            {displayMode === "compact" ? "DETAIL" : "PET"}
          </button>
          <button
            className={`mode-button ${realModeEnabled ? "armed" : ""}`}
            disabled={isMining}
            onClick={toggleRealMode}
            title="Toggle real mining mode"
            type="button"
          >
            {realModeEnabled ? "REAL ON" : "SIM"}
          </button>
          <button
            className={`pin-button ${alwaysOnTop ? "active" : ""}`}
            onClick={toggleAlwaysOnTop}
            title="Toggle always on top"
            type="button"
          >
            {alwaysOnTop ? "PIN" : "FREE"}
          </button>
        </div>
      </header>

      <section className="status-row">
        <div className={`pet-machine-container ${petStatus.toLowerCase().replace(/\s+/g, "-")}`}>
          <div className="pet-machine">
            <div className="pet-lights">
              <span className="light light-1"></span>
              <span className="light light-2"></span>
              <span className="light light-3"></span>
            </div>
            <div className="pet-screen">
              <div className="pet-expression">{getPetExpression(petStatus)}</div>
              <div className="pet-slots">
                <div className="slot-reel reel-1">
                  {isMiningAnimation ? (
                    <div className="reel-strip">
                      <span>₿</span><span>9</span><span>7</span><span>2</span><span>3</span><span>₿</span>
                    </div>
                  ) : (
                    <span>{getSlotChar(petStatus, 0)}</span>
                  )}
                </div>
                <div className="slot-reel reel-2">
                  {isMiningAnimation ? (
                    <div className="reel-strip delay-1">
                      <span>7</span><span>₿</span><span>1</span><span>8</span><span>5</span><span>7</span>
                    </div>
                  ) : (
                    <span>{getSlotChar(petStatus, 1)}</span>
                  )}
                </div>
                <div className="slot-reel reel-3">
                  {isMiningAnimation ? (
                    <div className="reel-strip delay-2">
                      <span>9</span><span>2</span><span>₿</span><span>7</span><span>6</span><span>9</span>
                    </div>
                  ) : (
                    <span>{getSlotChar(petStatus, 2)}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="pet-panel-decor">
              <span className="decor-btn decor-btn-red"></span>
              <span className="decor-btn decor-btn-blue"></span>
            </div>
            <div className="smoke-container">
              <span className="smoke-puff puff-1"></span>
              <span className="smoke-puff puff-2"></span>
            </div>
          </div>
        </div>

        {displayMode === "compact" && (
          <div className="mini-stats-line">
            <span>{compactComputeMode}: {displayedHashrate}</span>
            <span className="divider">|</span>
            <span>D: {formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)}</span>
            <span className="divider">|</span>
            <span>B: {blockHeight}</span>
          </div>
        )}

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

      {displayMode === "detail" && (
        <section className="metrics">
          {metrics.map(([label, value]) => (
            <article key={label}>
              <p className="label">{label}</p>
              <strong title={value}>{value}</strong>
            </article>
          ))}
        </section>
      )}

      {displayMode === "detail" && (
        <section className="resource-status-strip" aria-label="Resource status">
          {resourceMetrics.map(([label, value]) => (
            <span key={label}><b>{label}</b>{value}</span>
          ))}
        </section>
      )}

      {displayMode === "detail" && realModeEnabled && (
        <section className="real-status-strip" aria-label="Real mining connection status">
          <span><b>POOL</b>{poolStatus}</span>
          <span><b>AUTH</b>{authStatus}</span>
          <span><b>JOB</b>{jobStatus}</span>
          <span><b>LAST SHARE</b>{lastShare}</span>
        </section>
      )}

      {displayMode === "detail" && (
        <div className="log-ticker">
          <span className="log-label">LOG:</span>
          <span className="log-text" title={latestLog}>{latestLog}</span>
          <div className="log-actions">
            <button className="mini-button" onClick={() => void openLogs()} type="button">
              OPEN LOGS
            </button>
            <button className="mini-button" onClick={() => void copyLogPath()} type="button">
              COPY LOG PATH
            </button>
          </div>
        </div>
      )}

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

      {errorMessage && <p className="error-banner">{errorMessage}</p>}

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

      {showSettings && (
        <section className="overlay" role="dialog" aria-modal="true" aria-label="Mining settings">
          <div className="settings-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">LOCAL CONFIG</p>
                <h2>Mining settings</h2>
              </div>
              <button className="close-button" onClick={() => setShowSettings(false)} type="button">
                X
              </button>
            </div>
            <div className="form-grid">
              <label>
                BTC ADDRESS
                <input
                  value={draftConfig.btc_address}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, btc_address: event.target.value })
                  }
                  placeholder="bc1..."
                />
              </label>
              <label>
                POOL HOST
                <input
                  list="pool-presets"
                  value={draftConfig.pool_host}
                  onChange={(event) => {
                    const poolHost = event.target.value;
                    setDraftConfig({
                      ...draftConfig,
                      pool_host: poolHost,
                      pool_port: presetPort(poolHost, draftConfig.pool_port),
                    });
                  }}
                />
                <datalist id="pool-presets">
                  <option value="public-pool.io" />
                  <option value="pool.nerdminers.org" />
                </datalist>
              </label>
              <label>
                PORT
                <input
                  type="number"
                  value={draftConfig.pool_port}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, pool_port: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                WORKER
                <input
                  value={draftConfig.worker_name}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, worker_name: event.target.value })
                  }
                />
              </label>
              <label>
                PERFORMANCE PRESET
                <select
                  value={draftConfig.performance_preset}
                  onChange={(event) => {
                    const performancePreset = event.target.value as PerformancePreset;
                    setDraftConfig({
                      ...draftConfig,
                      performance_preset: performancePreset,
                      cpu_threads: threadsForPreset(
                        performancePreset,
                        systemInfo,
                        Number(draftConfig.cpu_threads),
                        draftConfig.compute_mode === "gpu" || draftConfig.compute_mode === "hybrid",
                      ),
                    });
                  }}
                >
                  <option value="eco">
                    Eco - {(draftConfig.compute_mode === "gpu") ? "GPU only" : "1 thread"}
                  </option>
                  <option value="normal">
                    Normal - {(draftConfig.compute_mode === "gpu")
                      ? `GPU + 0 threads`
                      : `${systemInfo.recommended_cpu_threads} threads`}
                  </option>
                  <option value="turbo">
                    Turbo - {systemInfo.available_parallelism} threads
                    {(draftConfig.compute_mode === "gpu" || draftConfig.compute_mode === "hybrid") ? " + GPU" : ""}
                  </option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label>
                CPU THREADS
                <select
                  disabled={draftConfig.performance_preset !== "custom"}
                  value={draftConfig.cpu_threads}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      performance_preset: "custom",
                      cpu_threads: Number(event.target.value),
                    })
                  }
                >
                  {cpuThreadOptions.map((threads) => (
                    <option key={threads} value={threads}>
                      {threads === 0
                        ? "0 threads (GPU only)"
                        : `${threads} thread${threads === 1 ? "" : "s"}${threads === systemInfo.available_parallelism ? " (max)" : ""}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                COMPUTE MODE
                <select
                  value={draftConfig.compute_mode}
                  onChange={(event) => {
                    const computeMode = event.target.value as ComputeMode;
                    const isGpu = computeMode === "gpu" || computeMode === "hybrid";
                    setDraftConfig({
                      ...draftConfig,
                      compute_mode: computeMode,
                      gpu_enabled: isGpu,
                      gpu_device_id: isGpu ? (draftConfig.gpu_device_id || "auto") : null,
                      performance_preset: draftConfig.performance_preset,
                      cpu_threads: threadsForPreset(
                        draftConfig.performance_preset,
                        systemInfo,
                        Number(draftConfig.cpu_threads),
                        computeMode === "gpu" || computeMode === "hybrid",
                      ),
                    });
                  }}
                >
                  <option value="cpu">CPU Only</option>
                  <option value="gpu">GPU Only</option>
                  <option value="hybrid">CPU + GPU</option>
                </select>
              </label>
              {draftConfig.compute_mode !== "cpu" && (
                <>
                  <label>
                    GPU DEVICE
                    <select
                      value={draftConfig.gpu_device_id || "auto"}
                      onChange={(event) =>
                        setDraftConfig({
                          ...draftConfig,
                          gpu_device_id: event.target.value === "auto" ? null : event.target.value,
                        })
                      }
                    >
                      {gpuDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                        </option>
                      ))}
                    </select>
                    {gpuDevices.length <= 1 && (
                      <p className="field-hint warning">
                        ⚠ No compatible GPU detected. Try updating your GPU drivers.
                      </p>
                    )}
                    {gpuDevices.some((d) => d.simulated && d.id !== "auto") && (
                      <p className="field-hint warning">
                        ⚠ Only software GPU (WARP) found — slower than CPU mining.
                      </p>
                    )}
                  </label>
                  <label>
                    GPU INTENSITY
                    <select
                      value={draftConfig.gpu_intensity_percent}
                      onChange={(event) =>
                        setDraftConfig({
                          ...draftConfig,
                          gpu_intensity_percent: Number(event.target.value),
                        })
                      }
                    >
                      {[10, 25, 50, 75, 100].map((intensity) => (
                        <option key={intensity} value={intensity}>
                          {intensity}%
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <div className="compute-status" aria-label="Compute status">
                <span>MODE</span>
                <strong>
                  {draftConfig.compute_mode === "cpu"
                    ? "CPU ONLY"
                    : draftConfig.compute_mode === "gpu"
                      ? "GPU ONLY"
                      : "CPU + GPU"}
                </strong>
              </div>
              <label>
                ENABLE NOTIFICATIONS
                <select
                  value={draftConfig.enable_notifications ? "true" : "false"}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      enable_notifications: event.target.value === "true",
                    })
                  }
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <label>
                NOTIFY JACKPOT
                <select
                  value={draftConfig.notify_on_jackpot ? "true" : "false"}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      notify_on_jackpot: event.target.value === "true",
                    })
                  }
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <label>
                NOTIFY SHARE ACCEPTED
                <select
                  value={draftConfig.notify_on_share_accepted ? "true" : "false"}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      notify_on_share_accepted: event.target.value === "true",
                    })
                  }
                >
                  <option value="false">Disabled</option>
                  <option value="true">Enabled</option>
                </select>
              </label>
              <label>
                NOTIFY CONNECTION ERROR
                <select
                  value={draftConfig.notify_on_connection_error ? "true" : "false"}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      notify_on_connection_error: event.target.value === "true",
                    })
                  }
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <label>
                HEARTBEAT INTERVAL
                <select
                  value={draftConfig.heartbeat_interval}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      heartbeat_interval: event.target.value as HeartbeatInterval,
                    })
                  }
                >
                  <option value="off">Off</option>
                  <option value="30min">30 min</option>
                  <option value="1h">1 hour</option>
                  <option value="6h">6 hours</option>
                </select>
              </label>
              <label>
                NOTIFICATION CHANNEL
                <select
                  value={draftConfig.notification_channel}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      notification_channel: event.target.value as NotificationChannel,
                    })
                  }
                >
                  <option value="local_windows_toast">Local Windows Toast</option>
                  <option value="webhook">Webhook</option>
                  <option value="telegram_bot" disabled>
                    Telegram Bot (Coming Soon)
                  </option>
                  <option value="ntfy_sh" disabled>
                    ntfy.sh (Coming Soon)
                  </option>
                </select>
              </label>
              <label className="full-width">
                WEBHOOK URL
                <input
                  disabled={draftConfig.notification_channel !== "webhook"}
                  value={draftConfig.webhook_url}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, webhook_url: event.target.value })
                  }
                  placeholder="https://example.com/btc-lottery-pet"
                />
              </label>
            </div>
            <div className="benchmark-row">
              <button
                className="secondary-button"
                disabled={draftConfig.compute_mode === "cpu"}
                onClick={() => void runGpuBenchmark()}
                type="button"
              >
                RUN BENCHMARK
              </button>
              {benchmarkResult && (
                <div className="benchmark-result">
                  <div>
                    <span>Device</span>
                    <strong>{benchmarkResult.device_name}</strong>
                  </div>
                  <div>
                    <span>Hashrate</span>
                    <strong>{formatHashrate(benchmarkResult.hashrate)}</strong>
                  </div>
                  <div>
                    <span>Intensity</span>
                    <strong>{benchmarkResult.gpu_intensity_percent}%</strong>
                  </div>
                  <p>{benchmarkResult.note}</p>
                </div>
              )}
            </div>
            <div className="panel-actions">
              <span>Real mining requires the REAL mode toggle.</span>
              <button className="confirm-button" onClick={saveSettings} type="button">
                SAVE
              </button>
            </div>
          </div>
        </section>
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
              <button className="confirm-button" onClick={() => setShowJackpot(false)} type="button">
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
