import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

type PetStatus = "Sleeping" | "Mining" | "Lucky Flash";

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
  pool_host: "pool.nerdminers.org",
  pool_port: 3333,
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

const blockHeightPlaceholder = "890,000";

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

function App() {
  const [isMining, setIsMining] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [uptime, setUptime] = useState(0);
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setUptime((value) => value + 1);
    }, 1_000);

    invoke<AppConfig>("get_config")
      .then((loadedConfig) => {
        setConfig(loadedConfig);
        setDraftConfig(loadedConfig);
      })
      .catch(() => {
        setConfig(fallbackConfig);
        setDraftConfig(fallbackConfig);
      });

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let unlisten = () => {};

    listen<RealMiningStats>("mining-stats", (event) => {
      setRealStats(event.payload);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {});

    return () => unlisten();
  }, []);

  useEffect(() => {
    if (!isMining || realModeEnabled) {
      return;
    }

    const updateStats = () => {
      setSimulationStats((current) => {
        const luckyFlash = Math.random() < 0.08;
        const candidateDifficulty = Math.random() * Math.random() * 4_500;

        return {
          status: luckyFlash ? "Lucky Flash" : "Mining",
          hashrate: 0.85 + Math.random() * 0.7,
          bestDifficulty: Math.max(current.bestDifficulty, candidateDifficulty),
        };
      });
    };

    updateStats();
    const timer = window.setInterval(updateStats, 1_000);
    return () => window.clearInterval(timer);
  }, [isMining, realModeEnabled]);

  const startMining = async () => {
    setErrorMessage("");

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

    if (realModeEnabled) {
      setRealStats((current) => ({
        ...current,
        hashrate: 0,
        connection_status: "Stopped",
      }));

      try {
        await invoke("stop_real_mining");
      } catch {
        // Browser-only Vite previews have no Rust backend.
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
    } catch {
      // Keep browser previews useful while the Rust backend is unavailable.
      setConfig(settings);
      setDraftConfig(settings);
    }

    setErrorMessage("");
    setShowSettings(false);
  };

  const toggleAlwaysOnTop = async () => {
    const nextValue = !alwaysOnTop;

    try {
      await invoke("set_window_always_on_top", { alwaysOnTop: nextValue });
      setAlwaysOnTop(nextValue);
    } catch {
      // Browser-only Vite previews have no Tauri window to update.
      setAlwaysOnTop(nextValue);
    }
  };

  const status = realModeEnabled
    ? realStats.connection_status
    : simulationStats.status;
  const isLuckyFlash = !realModeEnabled && simulationStats.status === "Lucky Flash";
  const metrics = realModeEnabled
    ? [
        ["HASHRATE", formatHashrate(realStats.hashrate)],
        ["BEST DIFF", formatDifficulty(realStats.best_difficulty)],
        ["SHARES A / R", `${realStats.accepted_shares} / ${realStats.rejected_shares}`],
        ["JOB ID", realStats.current_job_id || "--"],
      ]
    : [
        ["HASHRATE", `${simulationStats.hashrate.toFixed(2)} MH/s`],
        ["BEST DIFF", formatDifficulty(simulationStats.bestDifficulty)],
        ["UPTIME", formatUptime(uptime)],
        ["BLOCK HEIGHT", blockHeightPlaceholder],
      ];

  return (
    <main className={`pet-shell ${isLuckyFlash ? "lucky" : ""}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">{realModeEnabled ? "REAL MINING MODE" : "SIMULATION MODE"}</p>
          <h1>BTC Lottery Pet</h1>
        </div>
        <div className="header-actions">
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
        <div className={`pet-orb ${isMining ? "awake" : ""}`}>
          <span>{isMining ? "B" : "zZ"}</span>
        </div>
        <div className="status-copy">
          <p className="label">STATUS</p>
          <p className={`status ${isLuckyFlash ? "flash" : ""}`} title={status}>
            {status}
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

      <section className="metrics">
        {metrics.map(([label, value]) => (
          <article key={label}>
            <p className="label">{label}</p>
            <strong title={value}>{value}</strong>
          </article>
        ))}
      </section>

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
                <select
                  value={draftConfig.pool_host}
                  onChange={(event) => {
                    const poolHost = event.target.value;
                    setDraftConfig({
                      ...draftConfig,
                      pool_host: poolHost,
                      pool_port: poolHost === "public-pool.io" ? 21496 : 3333,
                    });
                  }}
                >
                  <option value="pool.nerdminers.org">pool.nerdminers.org</option>
                  <option value="public-pool.io">public-pool.io</option>
                </select>
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
