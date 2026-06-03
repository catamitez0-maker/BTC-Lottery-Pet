import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState, useRef } from "react";

type PetStatus = "Sleeping" | "Mining" | "Overdrive" | "Lucky Flash" | "Cooling Down" | "Connection Error" | "New Best Diff" | "Jackpot";
type ComputeMode = "cpu" | "gpu_sim" | "gpu_benchmark" | "gpu_real_experimental";

interface AppConfig {
  btc_address: string;
  pool_host: string;
  pool_port: number;
  worker_name: string;
  cpu_limit_percent: number;
  cpu_threads: number;
  real_mining_enabled: boolean;
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
  real_mining_enabled: false,
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

function getPetExpression(status: PetStatus): string {
  switch (status) {
    case "Sleeping":
      return "( -ω- )zzZ";
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

  // Listen to Mining Stats
  useEffect(() => {
    let unlisten = () => {};

    listen<RealMiningStats>("mining-stats", (event) => {
      setRealStats(event.payload);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error) => {
        if (runningInTauri) {
          setErrorMessage(`Could not listen for mining stats: ${formatError(error)}`);
        }
      });

    return () => unlisten();
  }, []);

  // Listen to Mining Logs
  useEffect(() => {
    let unlisten = () => {};

    listen<string>("mining-log", (event) => {
      const message = event.payload;
      setLatestLog(message);

      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes("share submitted") || lowerMessage.includes("share accepted") || lowerMessage.includes("share rejected")) {
        setLastShare(message.replace(/^\[[^\]]+\]\s*/, ""));
      }
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error) => {
        if (runningInTauri) {
          setErrorMessage(`Could not listen for mining logs: ${formatError(error)}`);
        }
      });

    return () => unlisten();
  }, []);

  // Listen to Block Candidate Events
  useEffect(() => {
    let unlisten = () => {};

    listen<BlockFoundEvent>("block-found", (event) => {
      setBlockFound(event.payload);
      setShowJackpot(true);
      setIsLucky(false);
      setIsNewBest(false);
      setLatestLog(`[Jackpot] Block candidate found: job=${event.payload.job_id}, hash=${event.payload.hash}`);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error) => {
        if (runningInTauri) {
          setErrorMessage(`Could not listen for block candidate events: ${formatError(error)}`);
        }
      });

    return () => unlisten();
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

  const gpuSimEnabled = config.compute_mode === "gpu_sim";

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
      const addedHashrate = gpuSimEnabled
        ? (108 + Math.random() * 24) * intensityScale
        : 0.85 + Math.random() * 0.7;

      setSimulationStats((current) => ({
        status: luckyFlash ? "Lucky Flash" : gpuSimEnabled ? "Overdrive" : "Mining",
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
  }, [config.gpu_intensity_percent, gpuSimEnabled, isMining, realModeEnabled]);

  // Track New Best Difficulty
  const activeBestDiff = realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty;
  const [prevBestDiff, setPrevBestDiff] = useState(0);

  useEffect(() => {
    if (!isMining) {
      setPrevBestDiff(activeBestDiff);
      return;
    }
    if (activeBestDiff > prevBestDiff) {
      if (prevBestDiff > 0) {
        setIsNewBest(true);
        const timer = setTimeout(() => setIsNewBest(false), 3000);
        setPrevBestDiff(activeBestDiff);
        return () => clearTimeout(timer);
      }
      setPrevBestDiff(activeBestDiff);
    }
  }, [activeBestDiff, isMining]);

  // Track Real Accepted Shares for Lucky Trigger
  const [prevAcceptedShares, setPrevAcceptedShares] = useState(0);

  useEffect(() => {
    if (!isMining || !realModeEnabled) {
      setPrevAcceptedShares(realStats.accepted_shares);
      return;
    }
    if (realStats.accepted_shares > prevAcceptedShares) {
      if (prevAcceptedShares > 0) {
        setIsLucky(true);
        const timer = setTimeout(() => setIsLucky(false), 3000);
        setPrevAcceptedShares(realStats.accepted_shares);
        return () => clearTimeout(timer);
      }
      setPrevAcceptedShares(realStats.accepted_shares);
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
      if (config.compute_mode === "gpu_benchmark") {
        setErrorMessage("GPU Benchmark does not mine. Open settings and click Run Benchmark.");
        setShowSettings(true);
        return;
      }

      setIsMining(true);
      setSimulationStats((current) => ({
        ...current,
        status: gpuSimEnabled ? "Overdrive" : "Mining",
      }));
      return;
    }

    if (!config.btc_address) {
      setErrorMessage("Add a BTC address before starting real mining.");
      setShowSettings(true);
      return;
    }

    setIsMining(true);
    setRealStats((current) => ({ ...current, connection_status: "Starting" }));

    try {
      await invoke("start_real_mining", {
        settings: {
          poolHost: config.pool_host,
          poolPort: config.pool_port,
          btcAddress: config.btc_address,
          workerName: config.worker_name,
          cpuThreads: config.cpu_threads,
          confirmedCpuUse: true,
        },
      });
    } catch (error) {
      setIsMining(false);
      setErrorMessage(String(error));
      setRealStats((current) => ({ ...current, connection_status: "Stopped" }));
    }
  };

  const stopMining = async () => {
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
      if (config.compute_mode !== "cpu") {
        setErrorMessage("Select CPU compute mode before enabling real mining.");
        setShowSettings(true);
        return;
      }

      setShowWarning(true);
    }
  };

  const saveSettings = async () => {
    setErrorMessage("");

    const cpuThreads = Number(draftConfig.cpu_threads);
    if (
      cpuThreads > systemInfo.recommended_cpu_threads &&
      !window.confirm("High CPU usage may affect your computer. Save this CPU thread count?")
    ) {
      return;
    }

    const settings: AppConfig = {
      ...draftConfig,
      pool_port: Number(draftConfig.pool_port),
      cpu_threads: cpuThreads,
      real_mining_enabled: false,
      compute_mode:
        draftConfig.compute_mode === "gpu_real_experimental"
          ? "cpu"
          : draftConfig.compute_mode,
      gpu_enabled:
        draftConfig.compute_mode === "gpu_sim" ||
        draftConfig.compute_mode === "gpu_benchmark",
      gpu_device_id: draftConfig.compute_mode === "cpu" ? null : draftConfig.gpu_device_id,
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

    setErrorMessage("");
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

  let petStatus: PetStatus;
  if (blockFound) {
    petStatus = "Jackpot";
  } else if (!isMining && !isCoolingDown) {
    petStatus = "Sleeping";
  } else if (isCoolingDown) {
    petStatus = "Cooling Down";
  } else if (isConnectionError) {
    petStatus = "Connection Error";
  } else if (isLucky) {
    petStatus = "Lucky Flash";
  } else if (isNewBest) {
    petStatus = "New Best Diff";
  } else if (gpuSimEnabled && !realModeEnabled) {
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
  const compactComputeMode = realModeEnabled ? "CPU" : gpuSimEnabled ? "GPU SIM" : "CPU";
  const statusClassName = petStatus === "Lucky Flash" || petStatus === "Jackpot" ? "flash" : "";
  const isMiningAnimation = petStatus === "Mining" || petStatus === "Overdrive";
  const displayStatus = petStatus === "Jackpot" ? "JACKPOT" : petStatus;
  const poolStatus = `${config.pool_host}:${config.pool_port}`;
  const authStatus =
    realStats.connection_status === "Authorized" || realStats.connection_status === "Mining"
      ? "Authorized"
      : realStats.connection_status;
  const jobStatus = realStats.current_job_id || "Waiting";
  const metrics = [
    ["HASHRATE", displayedHashrate],
    ["BEST DIFF", formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)],
    ["BLOCK HEIGHT", blockHeight],
    ["SHARES A / R", sharesValue],
    ["APP UPTIME", formatUptime(appUptime)],
    ["MINING UPTIME", formatUptime(miningUptime)],
    ...(gpuSimEnabled
      ? [
          ["GPU", "SIM"],
          ["GPU HASHRATE", displayedHashrate],
          ["GPU INTENSITY", `${config.gpu_intensity_percent}%`],
        ]
      : []),
  ];

  const cpuThreadOptions = useMemo(() => {
    const available = Math.max(1, systemInfo.available_parallelism);
    return Array.from(new Set([1, 2, 4, available]))
      .filter((threads) => threads <= available)
      .sort((left, right) => left - right);
  }, [systemInfo.available_parallelism]);

  return (
    <main className={`pet-shell ${displayMode} ${petStatus === "Lucky Flash" || petStatus === "Jackpot" ? "lucky" : ""}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {realModeEnabled ? "REAL CPU MINING" : gpuSimEnabled ? "GPU SIM MODE" : "SIMULATION MODE"}
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
        {realModeEnabled ? "Explicit CPU mode" : gpuSimEnabled ? "Local GPU simulation" : "Local-only simulation"}
        <button
          className="settings-button"
          disabled={isMining}
          onClick={() => setShowSettings(true)}
          type="button"
        >
          SETTINGS
        </button>
        <span className="cpu">{config.cpu_threads} thread{config.cpu_threads === 1 ? "" : "s"}</span>
      </footer>

      {errorMessage && <p className="error-banner">{errorMessage}</p>}

      {showWarning && (
        <section className="overlay" role="dialog" aria-modal="true" aria-label="Real mining warning">
          <div className="warning-card">
            <p className="eyebrow">EXPLICIT OPT-IN</p>
            <h2>Enable real mining?</h2>
            <p>
              Real mining mode will use your CPU. This is for education and lottery-style solo
              mining only.
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
                CPU THREADS
                <select
                  value={draftConfig.cpu_threads}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, cpu_threads: Number(event.target.value) })
                  }
                >
                  {cpuThreadOptions.map((threads) => (
                    <option key={threads} value={threads}>
                      {threads} thread{threads === 1 ? "" : "s"}
                      {threads === systemInfo.available_parallelism ? " (max)" : ""}
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
                    setDraftConfig({
                      ...draftConfig,
                      compute_mode: computeMode,
                      gpu_enabled: computeMode === "gpu_sim" || computeMode === "gpu_benchmark",
                      gpu_device_id: computeMode === "cpu" ? null : draftConfig.gpu_device_id,
                    });
                  }}
                >
                  <option value="cpu">CPU</option>
                  <option value="gpu_sim">GPU Sim</option>
                  <option value="gpu_benchmark">GPU Benchmark</option>
                  <option value="gpu_real_experimental" disabled>
                    GPU Real Experimental (Coming Soon)
                  </option>
                </select>
              </label>
              <label>
                GPU DEVICE
                <select
                  disabled={draftConfig.compute_mode === "cpu"}
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
              </label>
              <label>
                GPU INTENSITY
                <select
                  disabled={draftConfig.compute_mode === "cpu"}
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
              <div className="compute-status" aria-label="GPU status">
                <span>GPU</span>
                <strong>
                  {draftConfig.compute_mode === "gpu_sim"
                    ? "SIM ENABLED"
                    : draftConfig.compute_mode === "gpu_benchmark"
                      ? "BENCHMARK ENABLED"
                      : "DISABLED"}
                </strong>
              </div>
            </div>
            <div className="benchmark-row">
              <button
                className="secondary-button"
                disabled={draftConfig.compute_mode !== "gpu_benchmark"}
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
                    <span>Mode</span>
                    <strong>{benchmarkResult.simulated ? "GPU Benchmark (simulated)" : "GPU Benchmark"}</strong>
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
              <span>Real CPU mining always starts manually.</span>
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
            <p className="eyebrow">BLOCK CANDIDATE</p>
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
                <dt>Hash</dt>
                <dd title={blockFound.hash}>{blockFound.hash}</dd>
              </div>
            </dl>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => void openLogs()} type="button">
                OPEN LOGS
              </button>
              <button className="confirm-button" onClick={() => setShowJackpot(false)} type="button">
                OK
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
