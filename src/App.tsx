import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useRef } from "react";

type PetStatus = "Sleeping" | "Mining" | "Lucky Flash" | "Cooling Down" | "Connection Error" | "New Best Diff";

interface AppConfig {
  btc_address: string;
  pool_host: string;
  pool_port: number;
  worker_name: string;
  cpu_limit_percent: number;
  cpu_threads: number;
  real_mining_enabled: boolean;
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

const fallbackConfig: AppConfig = {
  btc_address: "",
  pool_host: "public-pool.io",
  pool_port: 21496,
  worker_name: "btc-lottery-pet",
  cpu_limit_percent: 10,
  cpu_threads: 1,
  real_mining_enabled: false,
};

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
    case "Lucky Flash":
      return "( ★∀★ )";
    case "New Best Diff":
      return "( ≧▽≦ )";
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
    case "Lucky Flash":
      return ["₿", "₿", "₿"][index];
    case "New Best Diff":
      return ["B", "S", "T"][index];
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

  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [isLucky, setIsLucky] = useState(false);
  const [isNewBest, setIsNewBest] = useState(false);
  const [displayMode, setDisplayMode] = useState<"compact" | "detail">("compact");

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
      setLatestLog(event.payload);
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
  }, [isMining, realModeEnabled]);

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
    if (coolingDownTimerRef.current) {
      clearTimeout(coolingDownTimerRef.current);
      coolingDownTimerRef.current = null;
    }

    if (!realModeEnabled) {
      setIsMining(true);
      setSimulationStats((current) => ({ ...current, status: "Mining" }));
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
      setShowWarning(true);
    }
  };

  const saveSettings = async () => {
    setErrorMessage("");

    const settings = {
      ...draftConfig,
      pool_port: Number(draftConfig.pool_port),
      cpu_threads: Number(draftConfig.cpu_threads),
      real_mining_enabled: false,
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
  if (!isMining && !isCoolingDown) {
    petStatus = "Sleeping";
  } else if (isCoolingDown) {
    petStatus = "Cooling Down";
  } else if (isConnectionError) {
    petStatus = "Connection Error";
  } else if (isLucky) {
    petStatus = "Lucky Flash";
  } else if (isNewBest) {
    petStatus = "New Best Diff";
  } else {
    petStatus = "Mining";
  }

  const sharesValue = realModeEnabled
    ? `${realStats.accepted_shares} / ${realStats.rejected_shares}`
    : `${simAccepted} / ${simRejected}`;

  const metrics = [
    ["HASHRATE", realModeEnabled ? formatHashrate(realStats.hashrate) : `${simulationStats.hashrate.toFixed(2)} MH/s`],
    ["BEST DIFF", formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)],
    ["BLOCK HEIGHT", blockHeight],
    ["SHARES A / R", sharesValue],
    ["APP UPTIME", formatUptime(appUptime)],
    ["MINING UPTIME", formatUptime(miningUptime)],
  ];

  return (
    <main className={`pet-shell ${displayMode} ${petStatus === "Lucky Flash" ? "lucky" : ""}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">{realModeEnabled ? "REAL MINING MODE" : "SIMULATION MODE"}</p>
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
                  {petStatus === "Mining" ? (
                    <div className="reel-strip">
                      <span>₿</span><span>9</span><span>7</span><span>2</span><span>3</span><span>₿</span>
                    </div>
                  ) : (
                    <span>{getSlotChar(petStatus, 0)}</span>
                  )}
                </div>
                <div className="slot-reel reel-2">
                  {petStatus === "Mining" ? (
                    <div className="reel-strip delay-1">
                      <span>7</span><span>₿</span><span>1</span><span>8</span><span>5</span><span>7</span>
                    </div>
                  ) : (
                    <span>{getSlotChar(petStatus, 1)}</span>
                  )}
                </div>
                <div className="slot-reel reel-3">
                  {petStatus === "Mining" ? (
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
            <span>H: {realModeEnabled ? formatHashrate(realStats.hashrate) : `${simulationStats.hashrate.toFixed(2)} MH/s`}</span>
            <span className="divider">|</span>
            <span>D: {formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)}</span>
            <span className="divider">|</span>
            <span>B: {blockHeight}</span>
          </div>
        )}

        <div className="status-copy">
          <p className="label">STATUS</p>
          <p className={`status ${petStatus === "Lucky Flash" ? "flash" : ""}`} title={petStatus}>
            {petStatus}
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
        <div className="log-ticker">
          <span className="log-label">LOG:</span>
          <span className="log-text" title={latestLog}>{latestLog}</span>
        </div>
      )}

      <footer>
        <span className={`dot ${realModeEnabled ? "armed" : ""}`} />
        {realModeEnabled ? "Explicit CPU mode" : "Local-only simulation"}
        <button
          className="settings-button"
          disabled={isMining}
          onClick={() => setShowSettings(true)}
          type="button"
        >
          SETTINGS
        </button>
        <span className="cpu">{config.cpu_threads} thread</span>
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
                <input
                  min="1"
                  max={navigator.hardwareConcurrency || 1}
                  type="number"
                  value={draftConfig.cpu_threads}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, cpu_threads: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            <div className="panel-actions">
              <span>Real mode always starts manually.</span>
              <button className="confirm-button" onClick={saveSettings} type="button">
                SAVE
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
