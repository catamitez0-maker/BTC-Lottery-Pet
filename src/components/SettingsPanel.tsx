import React, { useMemo } from "react";
import type {
  AppConfig,
  ComputeMode,
  GpuDevice,
  GpuBenchmarkResult,
  SystemInfo,
  PerformancePreset,
  HeartbeatInterval,
  NotificationChannel,
} from "../App";

interface SettingsPanelProps {
  draftConfig: AppConfig;
  setDraftConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  setShowSettings: (show: boolean) => void;
  saveSettings: () => Promise<void>;
  runGpuBenchmark: () => Promise<void>;
  benchmarkResult: GpuBenchmarkResult | null;
  gpuDevices: GpuDevice[];
  systemInfo: SystemInfo;
  formatHashrate: (hashrate: number) => string;
  sanitizeGpuDeviceId: (deviceId: string | null, devices: GpuDevice[]) => string | null;
  presetPort: (poolHost: string, currentPort: number) => number;
  threadsForPreset: (
    preset: PerformancePreset,
    systemInfo: SystemInfo,
    customThreads: number,
    gpuOnly?: boolean,
  ) => number;
  isGpuComputeMode: (mode: ComputeMode) => boolean;
  hasHardwareGpuDevice: (devices: GpuDevice[]) => boolean;
  hasSoftwareGpuDevice: (devices: GpuDevice[]) => boolean;
}

export default function SettingsPanel({
  draftConfig,
  setDraftConfig,
  setShowSettings,
  saveSettings,
  runGpuBenchmark,
  benchmarkResult,
  gpuDevices,
  systemInfo,
  formatHashrate,
  sanitizeGpuDeviceId,
  presetPort,
  threadsForPreset,
  isGpuComputeMode,
  hasHardwareGpuDevice,
  hasSoftwareGpuDevice,
}: SettingsPanelProps) {
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
  }, [draftEffectiveCpuThreads, systemInfo, isDraftGpuOnly]);

  return (
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
          <label className="full-width">
            COMPUTE MODE
            <select
              value={draftConfig.compute_mode}
              onChange={(event) => {
                const computeMode = event.target.value as ComputeMode;
                const isGpu = isGpuComputeMode(computeMode);
                setDraftConfig({
                  ...draftConfig,
                  compute_mode: computeMode,
                  gpu_enabled: isGpu,
                  gpu_device_id: isGpu
                    ? sanitizeGpuDeviceId(draftConfig.gpu_device_id, gpuDevices)
                    : null,
                  performance_preset: draftConfig.performance_preset,
                  cpu_threads: computeMode === "gpu"
                    ? Number(draftConfig.cpu_threads)
                    : threadsForPreset(
                        draftConfig.performance_preset,
                        systemInfo,
                        Number(draftConfig.cpu_threads),
                        false,
                      ),
                });
              }}
            >
              <option value="cpu">CPU Only</option>
              <option value="gpu">GPU Only</option>
              <option value="hybrid">CPU + GPU</option>
            </select>
          </label>
          <div className="compute-status full-width" aria-label="Compute status">
            <span>ACTIVE PLAN</span>
            <strong>
              {draftConfig.compute_mode === "cpu"
                ? `${draftEffectiveCpuThreads} CPU thread${draftEffectiveCpuThreads === 1 ? "" : "s"}`
                : draftConfig.compute_mode === "gpu"
                  ? "GPU worker, 0 CPU hash threads"
                  : `${draftEffectiveCpuThreads} CPU thread${draftEffectiveCpuThreads === 1 ? "" : "s"} + GPU worker`}
            </strong>
            <p className="field-hint">
              {draftConfig.compute_mode === "cpu"
                ? "GPU controls stay disabled in CPU Only mode."
                : draftConfig.compute_mode === "gpu"
                  ? "CPU presets are ignored in GPU Only mode. Use GPU Limit below to reduce GPU pressure."
                  : "Performance Preset controls only the CPU side of Hybrid mode."}
            </p>
          </div>
          {!isDraftGpuOnly ? (
            <>
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
                        false,
                      ),
                    });
                  }}
                >
                  <option value="eco">Eco - 1 CPU thread</option>
                  <option value="normal">
                    Normal - {systemInfo.recommended_cpu_threads} CPU thread{systemInfo.recommended_cpu_threads === 1 ? "" : "s"}
                  </option>
                  <option value="turbo">
                    Turbo - {systemInfo.available_parallelism} CPU thread{systemInfo.available_parallelism === 1 ? "" : "s"}
                  </option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label>
                CPU THREADS
                <select
                  disabled={draftConfig.performance_preset !== "custom"}
                  value={draftEffectiveCpuThreads}
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
                      {threads} thread{threads === 1 ? "" : "s"}{threads === systemInfo.available_parallelism ? " (max)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <div className="compute-status full-width" aria-label="CPU workers">
              <span>CPU WORKERS</span>
              <strong>0 threads (GPU only)</strong>
              <p className="field-hint">
                Real mining will start one GPU worker and no CPU hash workers.
              </p>
            </div>
          )}
          {draftConfig.compute_mode !== "cpu" && (
            <>
              <label>
                GPU DEVICE
                <select
                  value={sanitizeGpuDeviceId(draftConfig.gpu_device_id, gpuDevices) || "auto"}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      gpu_device_id: sanitizeGpuDeviceId(
                        event.target.value === "auto" ? null : event.target.value,
                        gpuDevices,
                      ),
                    })
                  }
                >
                  {gpuDevices.map((device) => (
                    <option key={device.id} value={device.id} disabled={device.simulated && device.id !== "auto"}>
                      {device.name}{device.simulated && device.id !== "auto" ? " (software - disabled)" : ""}
                    </option>
                  ))}
                </select>
                {!hardwareGpuAvailable && !softwareGpuAvailable && (
                  <p className="field-hint warning">
                    No compatible GPU detected. Try updating your GPU drivers.
                  </p>
                )}
                {!hardwareGpuAvailable && softwareGpuAvailable && (
                  <p className="field-hint warning">
                    Only software GPU adapters were detected. They are disabled for real mining.
                  </p>
                )}
                {hardwareGpuAvailable && softwareGpuAvailable && (
                  <p className="field-hint">
                    Software adapters are disabled. Auto will prefer a hardware GPU backend.
                  </p>
                )}
              </label>
              <label>
                GPU LIMIT
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
                <p className="field-hint">
                  Soft duty-cycle limiter. 100% means no intentional throttle sleep.
                </p>
              </label>
            </>
          )}
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
                <span>Mode</span>
                <strong>{benchmarkResult.simulated ? "Simulated" : "Real GPU"}</strong>
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
          <button className="confirm-button" onClick={() => void saveSettings()} type="button">
            SAVE
          </button>
        </div>
      </div>
    </section>
  );
}
