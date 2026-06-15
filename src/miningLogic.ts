export type PetStatus =
  | "Sleeping"
  | "Connecting"
  | "Mining"
  | "Overdrive"
  | "Lucky Flash"
  | "Cooling Down"
  | "Connection Error"
  | "New Best Diff"
  | "Jackpot";
export type ComputeMode = "cpu" | "gpu" | "hybrid";
export type PerformancePreset = "eco" | "normal" | "turbo" | "custom";
export type HeartbeatInterval = "off" | "30min" | "1h" | "6h";
export type NotificationChannel = "local_windows_toast" | "webhook";

export interface AppConfig {
  btc_address: string;
  pool_host: string;
  pool_port: number;
  pool_password: string;
  worker_name: string;
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

export interface SystemInfo {
  available_parallelism: number;
  default_cpu_threads: number;
  recommended_cpu_threads: number;
}

export interface GpuDevice {
  id: string;
  name: string;
  simulated: boolean;
}

export interface GpuBenchmarkResult {
  device_id: string;
  device_name: string;
  simulated: boolean;
  gpu_intensity_percent: number;
  hashrate: number;
  duration_ms: number;
  note: string;
  generated_at: string;
}

export type PoolDiagnosticStatus = "ok" | "failed" | "skipped";

export interface PoolDiagnosticStep {
  name: string;
  status: PoolDiagnosticStatus;
  message: string;
  duration_ms: number;
}

export interface PoolDiagnosticReport {
  generated_at: string;
  pool: string;
  steps: PoolDiagnosticStep[];
  summary: string;
}

export interface SimulationStats {
  status: PetStatus;
  hashrate: number;
  bestDifficulty: number;
}

export interface RealMiningStats {
  hashrate: number;
  accepted_shares: number;
  rejected_shares: number;
  best_difficulty: number;
  share_difficulty: number;
  current_job_id: string;
  connection_status: string;
  gpu_backend: string;
  gpu_device_name: string;
  gpu_dispatch_size: number;
  gpu_dispatch_ms: number;
  gpu_throttle_ms: number;
}

export interface BlockFoundEvent {
  job_id: string;
  nonce: string;
  ntime: string;
  extranonce2: string;
  hash: string;
  difficulty: number;
  timestamp: string;
  pool: string;
}

export function presetPort(poolHost: string, currentPort: number) {
  if (isKnownPoolHost(poolHost)) {
    return 3333;
  }

  return currentPort;
}

function isKnownPoolHost(poolHost: string) {
  const normalizedHost = poolHost.trim().toLowerCase();
  return (
    normalizedHost === "public-pool.io" ||
    normalizedHost === "pool.nerdminer.io" ||
    normalizedHost === "pool.nerdminers.org"
  );
}

function normalizePoolPort(poolHost: string, poolPort: number) {
  const port = Number.isFinite(poolPort) ? Math.trunc(poolPort) : 0;
  if (isKnownPoolHost(poolHost) && (port === 0 || port === 21496)) {
    return 3333;
  }

  if (port < 1 || port > 65535) {
    return 3333;
  }

  return port;
}

function normalizePoolPassword(poolPassword: string | null | undefined) {
  const trimmed = (poolPassword || "").trim();
  return trimmed || "x";
}

export function normalizeAppConfig(
  config: AppConfig,
  systemInfo: SystemInfo,
  devices: GpuDevice[],
): AppConfig {
  const poolHost = config.pool_host.trim() || "public-pool.io";
  const workerName = config.worker_name.trim() || "btc-lottery-pet";
  const computeMode = config.compute_mode;
  const isGpuMode = isGpuComputeMode(computeMode);
  const isGpuOnly = computeMode === "gpu";

  return {
    ...config,
    btc_address: config.btc_address.trim(),
    pool_host: poolHost,
    pool_port: normalizePoolPort(poolHost, Number(config.pool_port)),
    pool_password: normalizePoolPassword(config.pool_password),
    worker_name: workerName,
    webhook_url: config.webhook_url.trim(),
    real_mining_enabled: false,
    cpu_threads: threadsForPreset(
      config.performance_preset,
      systemInfo,
      Number(config.cpu_threads),
      isGpuOnly,
    ),
    gpu_enabled: isGpuMode,
    gpu_device_id: isGpuMode ? sanitizeGpuDeviceId(config.gpu_device_id, devices) : null,
    gpu_intensity_percent: Math.min(
      100,
      Math.max(1, Math.trunc(Number(config.gpu_intensity_percent) || 10)),
    ),
  };
}

export function realMiningStartError(
  config: AppConfig,
  devices: GpuDevice[],
  runningInTauri: boolean,
) {
  const poolHost = config.pool_host.trim();
  const poolPort = Number(config.pool_port);
  const workerName = config.worker_name.trim();

  if (!config.btc_address.trim()) {
    return "Add a BTC address before starting real mining.";
  }

  if (
    !poolHost ||
    /\s/.test(poolHost) ||
    poolHost.includes("://") ||
    poolHost.includes("/")
  ) {
    return "Pool host must be a hostname without spaces, URL scheme, or path.";
  }

  if (!Number.isInteger(poolPort) || poolPort < 1 || poolPort > 65535) {
    return "Pool port must be between 1 and 65535.";
  }

  const poolPassword = normalizePoolPassword(config.pool_password);
  if (poolPassword.length > 128 || /[\u0000-\u001F\u007F]/.test(poolPassword)) {
    return "Pool password must be 128 characters or fewer and cannot contain control characters.";
  }

  if (!workerName || !/^[A-Za-z0-9_-]+$/.test(workerName)) {
    return "Worker name may contain only letters, numbers, dashes, and underscores.";
  }

  if (config.compute_mode === "gpu" && runningInTauri && !hasHardwareGpuDevice(devices)) {
    return "No hardware GPU detected. Switch to CPU or CPU + GPU mode, or update GPU drivers.";
  }

  return null;
}

export function formatDifficulty(value: number) {
  return value < 1_000
    ? value.toFixed(4)
    : Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatHashrate(hashrate: number) {
  if (hashrate >= 1_000_000) {
    return `${(hashrate / 1_000_000).toFixed(2)} MH/s`;
  }

  if (hashrate >= 1_000) {
    return `${(hashrate / 1_000).toFixed(2)} KH/s`;
  }

  return `${hashrate.toFixed(0)} H/s`;
}

export function expectedSharesPerHour(hashrate: number, shareDifficulty: number) {
  if (!Number.isFinite(hashrate) || !Number.isFinite(shareDifficulty)) {
    return 0;
  }
  if (hashrate <= 0 || shareDifficulty <= 0) {
    return 0;
  }

  return hashrate * 3600 / (shareDifficulty * 2 ** 32);
}

export function formatShareRate(sharesPerHour: number) {
  if (!Number.isFinite(sharesPerHour) || sharesPerHour <= 0) {
    return "Waiting";
  }

  if (sharesPerHour < 0.001) {
    return "<0.001/h";
  }

  if (sharesPerHour < 1) {
    return `${sharesPerHour.toFixed(3)}/h`;
  }

  if (sharesPerHour < 100) {
    return `${sharesPerHour.toFixed(2)}/h`;
  }

  return `${Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(sharesPerHour)}/h`;
}

export function threadsForPreset(
  preset: PerformancePreset,
  systemInfo: SystemInfo,
  customThreads: number,
  gpuOnly = false,
) {
  if (gpuOnly) {
    return 0;
  }

  const availableThreads = Math.max(1, systemInfo.available_parallelism);
  const recommendedThreads = Math.min(
    availableThreads,
    Math.max(1, systemInfo.recommended_cpu_threads),
  );

  switch (preset) {
    case "eco":
      return 1;
    case "normal":
      return recommendedThreads;
    case "turbo":
      return availableThreads;
    case "custom":
      return Math.min(Math.max(1, customThreads), availableThreads);
  }
}

export function isGpuComputeMode(mode: ComputeMode) {
  return mode === "gpu" || mode === "hybrid";
}

export function hasHardwareGpuDevice(devices: GpuDevice[]) {
  return devices.some((device) => device.id !== "auto" && !device.simulated);
}

export function hasSoftwareGpuDevice(devices: GpuDevice[]) {
  return devices.some((device) => device.id !== "auto" && device.simulated);
}

export function sanitizeGpuDeviceId(deviceId: string | null, devices: GpuDevice[]) {
  if (!deviceId || deviceId === "auto") {
    return null;
  }

  const device = devices.find((candidate) => candidate.id === deviceId);
  return device && !device.simulated ? deviceId : null;
}
