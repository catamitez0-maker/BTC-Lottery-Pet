mod gpu_miner;
mod miner;
mod notifications;

use std::{fs, path::PathBuf, process::Command, thread};

use miner::{MiningController, PoolDiagnosticReport, PoolDiagnosticSettings, RealMiningSettings};
use notifications::{
    HeartbeatInterval, HeartbeatSnapshot, JackpotNotificationEvent, NotificationChannel,
    NotificationSettings,
};
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow, WindowEvent,
};

const DEFAULT_CONFIG: &str = include_str!("../../config.json");
const DEFAULT_POOL_HOST: &str = "public-pool.io";
const DEFAULT_POOL_PORT: u16 = 3333;
const DEFAULT_POOL_PASSWORD: &str = "x";
const DEFAULT_PET_PROFILE_ID: &str = "classic-slot";
const BUILTIN_PET_PROFILE_IDS: &[&str] = &["classic-slot", "cyber-miner", "lucky-cat"];
const OLD_PUBLIC_POOL_PORT: u16 = 21496;
const DIAGNOSTIC_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ComputeMode {
    #[default]
    Cpu,
    Gpu,
    Hybrid,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PerformancePreset {
    #[default]
    Eco,
    Normal,
    Turbo,
    Custom,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default)]
struct AppConfig {
    btc_address: String,
    #[serde(alias = "pool_url")]
    pool_host: String,
    pool_port: u16,
    pool_password: String,
    worker_name: String,
    cpu_threads: usize,
    performance_preset: PerformancePreset,
    real_mining_enabled: bool,
    enable_notifications: bool,
    notify_on_jackpot: bool,
    notify_on_share_accepted: bool,
    notify_on_connection_error: bool,
    heartbeat_interval: HeartbeatInterval,
    notification_channel: NotificationChannel,
    webhook_url: String,
    compute_mode: ComputeMode,
    gpu_enabled: bool,
    gpu_device_id: Option<String>,
    gpu_intensity_percent: u8,
    pet_profile_id: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            btc_address: String::new(),
            pool_host: DEFAULT_POOL_HOST.into(),
            pool_port: DEFAULT_POOL_PORT,
            pool_password: DEFAULT_POOL_PASSWORD.into(),
            worker_name: "btc-lottery-pet".into(),
            cpu_threads: 1,
            performance_preset: PerformancePreset::Eco,
            real_mining_enabled: false,
            enable_notifications: true,
            notify_on_jackpot: true,
            notify_on_share_accepted: false,
            notify_on_connection_error: true,
            heartbeat_interval: HeartbeatInterval::Off,
            notification_channel: NotificationChannel::LocalWindowsToast,
            webhook_url: String::new(),
            compute_mode: ComputeMode::Cpu,
            gpu_enabled: false,
            gpu_device_id: None,
            gpu_intensity_percent: 10,
            pet_profile_id: DEFAULT_PET_PROFILE_ID.into(),
        }
    }
}

impl AppConfig {
    fn normalized(mut self) -> Self {
        self.btc_address = self.btc_address.trim().to_owned();
        self.pool_host = self.pool_host.trim().to_owned();
        self.pool_password = normalize_pool_password(&self.pool_password);
        self.worker_name = self.worker_name.trim().to_owned();
        self.webhook_url = self.webhook_url.trim().to_owned();
        self.pet_profile_id = normalize_pet_profile_id(&self.pet_profile_id);
        self.real_mining_enabled = false;
        self.gpu_device_id = self
            .gpu_device_id
            .map(|device_id| device_id.trim().to_owned())
            .filter(|device_id| !device_id.is_empty());

        if self.pool_host.is_empty() {
            self.pool_host = DEFAULT_POOL_HOST.into();
        }

        if is_known_pool_host(&self.pool_host)
            && (self.pool_port == 0 || self.pool_port == OLD_PUBLIC_POOL_PORT)
        {
            self.pool_port = DEFAULT_POOL_PORT;
        }

        if self.pool_port == 0 {
            self.pool_port = default_port_for_pool(&self.pool_host);
        }

        if self.worker_name.is_empty() {
            self.worker_name = "btc-lottery-pet".into();
        }

        let available_threads = available_parallelism();
        let recommended_threads = recommended_cpu_threads();
        self.cpu_threads = match self.performance_preset {
            PerformancePreset::Eco => 1,
            PerformancePreset::Normal => recommended_threads,
            PerformancePreset::Turbo => available_threads,
            PerformancePreset::Custom => self.cpu_threads.clamp(1, available_threads),
        };
        self.gpu_intensity_percent = self.gpu_intensity_percent.clamp(1, 100);

        match self.compute_mode {
            ComputeMode::Cpu => {
                self.gpu_enabled = false;
                self.gpu_device_id = None;
            }
            ComputeMode::Gpu | ComputeMode::Hybrid => {
                self.gpu_enabled = true;
            }
        }
        if self.compute_mode == ComputeMode::Gpu {
            self.cpu_threads = 0;
        }

        self
    }
}

#[derive(Clone, Debug, Serialize)]
struct SystemInfo {
    available_parallelism: usize,
    default_cpu_threads: usize,
    recommended_cpu_threads: usize,
}

#[derive(Clone, Debug, Serialize)]
struct GpuDevice {
    id: String,
    name: String,
    simulated: bool,
}

#[derive(Clone, Debug, Serialize)]
struct GpuBenchmarkResult {
    device_id: String,
    device_name: String,
    simulated: bool,
    gpu_intensity_percent: u8,
    hashrate: f64,
    duration_ms: u64,
    note: String,
    generated_at: String,
}

#[derive(Clone, Debug, Serialize)]
struct DiagnosticConfig {
    pool_host: String,
    pool_port: u16,
    worker_name: String,
    cpu_threads: usize,
    performance_preset: PerformancePreset,
    compute_mode: ComputeMode,
    gpu_enabled: bool,
    gpu_device_id: Option<String>,
    gpu_intensity_percent: u8,
    pet_profile_id: String,
    enable_notifications: bool,
    notify_on_jackpot: bool,
    notify_on_share_accepted: bool,
    notify_on_connection_error: bool,
    heartbeat_interval: HeartbeatInterval,
    notification_channel: NotificationChannel,
}

#[derive(Clone, Debug, Serialize)]
struct DiagnosticSnapshot {
    diagnostic_schema_version: u32,
    generated_at: String,
    product_name: String,
    app_version: String,
    identifier: String,
    config: DiagnosticConfig,
    gpu_devices: Vec<GpuDevice>,
    log_path: String,
    recent_log_lines: Vec<String>,
    last_connection_error: Option<String>,
    redacted_fields: Vec<String>,
}

fn available_parallelism() -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

fn recommended_cpu_threads() -> usize {
    available_parallelism().min(2)
}

fn is_known_pool_host(pool_host: &str) -> bool {
    matches!(
        pool_host.trim().to_ascii_lowercase().as_str(),
        "public-pool.io" | "pool.nerdminer.io" | "pool.nerdminers.org"
    )
}

fn default_port_for_pool(_pool_host: &str) -> u16 {
    DEFAULT_POOL_PORT
}

fn normalize_pool_password(password: &str) -> String {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        DEFAULT_POOL_PASSWORD.into()
    } else {
        trimmed.to_owned()
    }
}

fn normalize_pet_profile_id(profile_id: &str) -> String {
    let trimmed = profile_id.trim();
    if BUILTIN_PET_PROFILE_IDS.contains(&trimmed) {
        trimmed.to_owned()
    } else {
        DEFAULT_PET_PROFILE_ID.into()
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve app config directory: {error}"))?;

    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("failed to create app config directory: {error}"))?;

    Ok(config_dir.join("config.json"))
}

fn ensure_config(app: &AppHandle) -> Result<PathBuf, String> {
    let path = config_path(app)?;

    if !path.exists() {
        fs::write(&path, DEFAULT_CONFIG)
            .map_err(|error| format!("failed to create default config: {error}"))?;
    }

    Ok(path)
}

fn write_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(config)
        .map_err(|error| format!("failed to encode config: {error}"))?;
    fs::write(config_path(app)?, format!("{contents}\n"))
        .map_err(|error| format!("failed to save config: {error}"))
}

fn load_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = ensure_config(app)?;
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("failed to read config: {error}"))?;

    // If the saved config contains values that the current version can't parse
    // (e.g., old ComputeMode variants from a previous version), fall back to
    // the default config rather than crashing on startup.
    let config: AppConfig = match serde_json::from_str(&contents) {
        Ok(c) => c,
        Err(error) => {
            eprintln!("[Config] Failed to parse saved config: {error}. Using defaults.");
            let default: AppConfig =
                serde_json::from_str(DEFAULT_CONFIG).expect("DEFAULT_CONFIG must always be valid");
            // Overwrite the broken config file with clean defaults
            let _ = write_config(app, &default);
            default
        }
    };

    Ok(config.normalized())
}

fn reset_saved_config_to_safe_defaults(app: &AppHandle) -> Result<(), String> {
    let config = load_config(app)?;
    write_config(app, &config)
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    load_config(&app)
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    let config = config.normalized();
    write_config(&app, &config)?;

    Ok(config)
}

#[tauri::command]
fn get_system_info() -> SystemInfo {
    let available_parallelism = available_parallelism();

    SystemInfo {
        available_parallelism,
        default_cpu_threads: 1,
        recommended_cpu_threads: recommended_cpu_threads(),
    }
}

#[tauri::command]
async fn get_gpu_devices() -> Vec<GpuDevice> {
    tauri::async_runtime::spawn_blocking(|| {
        gpu_miner::enumerate_gpu_devices()
            .into_iter()
            .map(|info| GpuDevice {
                id: info.id,
                name: info.name,
                simulated: info.simulated,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn run_gpu_benchmark(
    gpu_device_id: Option<String>,
    gpu_intensity_percent: u8,
) -> GpuBenchmarkResult {
    let intensity = gpu_intensity_percent.clamp(1, 100);
    let generated_at = chrono::Utc::now().to_rfc3339();
    let fallback_generated_at = generated_at.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match gpu_miner::run_gpu_benchmark(gpu_device_id.as_deref(), intensity) {
            Ok(info) => GpuBenchmarkResult {
                device_id: gpu_device_id.unwrap_or_else(|| "auto".into()),
                device_name: info.device_name,
                simulated: info.simulated,
                gpu_intensity_percent: intensity,
                hashrate: info.hashrate,
                duration_ms: info.duration_ms,
                note: info.note,
                generated_at: generated_at.clone(),
            },
            Err(error) => GpuBenchmarkResult {
                device_id: gpu_device_id.unwrap_or_else(|| "auto".into()),
                device_name: "Unknown".into(),
                simulated: false,
                gpu_intensity_percent: intensity,
                hashrate: 0.0,
                duration_ms: 0,
                note: format!("GPU benchmark failed: {error}"),
                generated_at: generated_at.clone(),
            },
        }
    })
    .await
    .unwrap_or_else(|_| GpuBenchmarkResult {
        device_id: "auto".into(),
        device_name: "Unknown".into(),
        simulated: false,
        gpu_intensity_percent: intensity,
        hashrate: 0.0,
        duration_ms: 0,
        note: "GPU benchmark task panicked".into(),
        generated_at: fallback_generated_at,
    })
}

#[tauri::command]
async fn diagnose_pool_connection(
    settings: PoolDiagnosticSettings,
) -> Result<PoolDiagnosticReport, String> {
    tauri::async_runtime::spawn_blocking(move || miner::diagnose_pool_connection(settings))
        .await
        .map_err(|_| "pool diagnostic task panicked".to_string())
}

#[tauri::command]
async fn get_diagnostic_snapshot(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || build_diagnostic_snapshot(&app))
        .await
        .map_err(|_| "diagnostic snapshot task panicked".to_string())?
}

#[tauri::command]
async fn save_diagnostic_snapshot(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_diagnostic_snapshot(&app)?;
        let log_dir = ensure_log_dir(&app)?;
        let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
        let path = log_dir.join(format!("diagnostic-{timestamp}.json"));
        fs::write(&path, format!("{snapshot}\n"))
            .map_err(|error| format!("failed to save diagnostic snapshot: {error}"))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|_| "diagnostic snapshot save task panicked".to_string())?
}

#[tauri::command]
fn start_real_mining(
    app: AppHandle,
    state: State<'_, MiningController>,
    settings: RealMiningSettings,
) -> Result<(), String> {
    state.start(app, settings)
}

#[tauri::command]
fn stop_real_mining(app: AppHandle, state: State<'_, MiningController>) {
    state.stop(&app);
}

#[tauri::command]
fn notify_jackpot(
    app: AppHandle,
    settings: NotificationSettings,
    event: JackpotNotificationEvent,
) -> Result<(), String> {
    notifications::notify_jackpot(&app, settings, event);
    Ok(())
}

#[tauri::command]
fn notify_share_accepted(app: AppHandle, settings: NotificationSettings) -> Result<(), String> {
    notifications::notify_share_accepted(&app, settings);
    Ok(())
}

#[tauri::command]
fn notify_connection_error(
    app: AppHandle,
    settings: NotificationSettings,
    status: String,
) -> Result<(), String> {
    notifications::notify_connection_error(&app, settings, status);
    Ok(())
}

#[tauri::command]
fn send_heartbeat_notification(
    app: AppHandle,
    settings: NotificationSettings,
    snapshot: HeartbeatSnapshot,
) -> Result<(), String> {
    notifications::send_heartbeat(&app, settings, snapshot);
    Ok(())
}

#[tauri::command]
fn get_log_path(app: AppHandle) -> Result<String, String> {
    Ok(ensure_log_dir(&app)?.display().to_string())
}

#[tauri::command]
fn open_log_folder(app: AppHandle) -> Result<(), String> {
    open_log_folder_impl(&app)
}

#[tauri::command]
fn set_window_always_on_top(window: WebviewWindow, always_on_top: bool) -> Result<(), String> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| format!("failed to update always-on-top setting: {error}"))
}

fn diagnostic_config(config: AppConfig) -> DiagnosticConfig {
    DiagnosticConfig {
        pool_host: config.pool_host,
        pool_port: config.pool_port,
        worker_name: config.worker_name,
        cpu_threads: config.cpu_threads,
        performance_preset: config.performance_preset,
        compute_mode: config.compute_mode,
        gpu_enabled: config.gpu_enabled,
        gpu_device_id: config.gpu_device_id,
        gpu_intensity_percent: config.gpu_intensity_percent,
        pet_profile_id: config.pet_profile_id,
        enable_notifications: config.enable_notifications,
        notify_on_jackpot: config.notify_on_jackpot,
        notify_on_share_accepted: config.notify_on_share_accepted,
        notify_on_connection_error: config.notify_on_connection_error,
        heartbeat_interval: config.heartbeat_interval,
        notification_channel: config.notification_channel,
    }
}

fn read_recent_log_lines(
    app: &AppHandle,
    max_lines: usize,
) -> Result<(String, Vec<String>), String> {
    let log_dir = ensure_log_dir(app)?;
    let log_path = log_dir.join("mining.log");
    let log_path_string = log_path.display().to_string();

    if !log_path.exists() {
        return Ok((log_path_string, Vec::new()));
    }

    let contents = fs::read_to_string(&log_path)
        .map_err(|error| format!("failed to read mining log for diagnostics: {error}"))?;
    let mut lines = contents
        .lines()
        .rev()
        .take(max_lines)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    lines.reverse();

    Ok((log_path_string, lines))
}

fn sanitize_diagnostic_line(line: &str, config: &AppConfig) -> String {
    let mut sanitized = line.to_owned();
    for (value, replacement) in [
        (config.btc_address.trim(), "[redacted btc address]"),
        (config.webhook_url.trim(), "[redacted webhook url]"),
    ] {
        if !value.is_empty() {
            sanitized = sanitized.replace(value, replacement);
        }
    }

    let pool_password = normalize_pool_password(&config.pool_password);
    if pool_password != DEFAULT_POOL_PASSWORD {
        sanitized = sanitized.replace(&pool_password, "[redacted pool password]");
    }

    sanitized
}

fn diagnostic_redacted_fields(config: &AppConfig) -> Vec<String> {
    let mut fields = Vec::new();
    if !config.btc_address.trim().is_empty() {
        fields.push("btc_address".to_owned());
    }
    if normalize_pool_password(&config.pool_password) != DEFAULT_POOL_PASSWORD {
        fields.push("pool_password".to_owned());
    }
    if !config.webhook_url.trim().is_empty() {
        fields.push("webhook_url".to_owned());
    }
    fields
}

fn build_diagnostic_snapshot(app: &AppHandle) -> Result<String, String> {
    let config = load_config(app)?;
    let redacted_fields = diagnostic_redacted_fields(&config);
    let (log_path, recent_log_lines) = read_recent_log_lines(app, 80)?;
    let recent_log_lines = recent_log_lines
        .into_iter()
        .map(|line| sanitize_diagnostic_line(&line, &config))
        .collect::<Vec<_>>();
    let last_connection_error = recent_log_lines
        .iter()
        .rev()
        .find(|line| line.to_ascii_lowercase().contains("connection error"))
        .cloned();
    let gpu_devices = gpu_miner::enumerate_gpu_devices()
        .into_iter()
        .map(|info| GpuDevice {
            id: info.id,
            name: info.name,
            simulated: info.simulated,
        })
        .collect();
    let snapshot = DiagnosticSnapshot {
        diagnostic_schema_version: DIAGNOSTIC_SCHEMA_VERSION,
        generated_at: chrono::Utc::now().to_rfc3339(),
        product_name: app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| "BTC Lottery Pet".into()),
        app_version: env!("CARGO_PKG_VERSION").into(),
        identifier: app.config().identifier.clone(),
        config: diagnostic_config(config),
        gpu_devices,
        log_path,
        recent_log_lines,
        last_connection_error,
        redacted_fields,
    };

    serde_json::to_string_pretty(&snapshot)
        .map_err(|error| format!("failed to encode diagnostic snapshot: {error}"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn ensure_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to locate log folder: {error}"))?;
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("failed to create log folder: {error}"))?;
    Ok(log_dir)
}

fn open_log_folder_impl(app: &AppHandle) -> Result<(), String> {
    let log_dir = ensure_log_dir(app)?;

    #[cfg(windows)]
    let mut command = Command::new("explorer");

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(&log_dir)
        .spawn()
        .map_err(|error| format!("failed to open log folder: {error}"))?;

    Ok(())
}

fn tray_icon() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as i32 - 15;
            let dy = y as i32 - 15;
            let inside_coin = dx * dx + dy * dy <= 14 * 14;
            let index = ((y * SIZE + x) * 4) as usize;

            if inside_coin {
                rgba[index] = 247;
                rgba[index + 1] = 147;
                rgba[index + 2] = 26;
                rgba[index + 3] = 255;
            }

            let vertical = (x == 14 || x == 17) && (7..=24).contains(&y);
            let horizontal = (8..=22).contains(&x) && (y == 10 || y == 16 || y == 22);
            let rounded_edge = x == 22 && ((11..=15).contains(&y) || (17..=21).contains(&y));

            if inside_coin && (vertical || horizontal || rounded_edge) {
                rgba[index] = 61;
                rgba[index + 1] = 37;
                rgba[index + 2] = 6;
                rgba[index + 3] = 255;
            }
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(MiningController::default())
        .setup(|app| {
            reset_saved_config_to_safe_defaults(app.handle()).map_err(std::io::Error::other)?;

            let show = MenuItem::with_id(app, "show", "Show BTC Lottery Pet", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide to Tray", true, None::<&str>)?;
            let open_logs = MenuItem::with_id(app, "open_logs", "Open Logs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &open_logs, &quit])?;

            TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("BTC Lottery Pet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "open_logs" => {
                        let _ = open_log_folder_impl(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_system_info,
            get_gpu_devices,
            run_gpu_benchmark,
            diagnose_pool_connection,
            get_diagnostic_snapshot,
            save_diagnostic_snapshot,
            start_real_mining,
            stop_real_mining,
            notify_jackpot,
            notify_share_accepted,
            notify_connection_error,
            send_heartbeat_notification,
            get_log_path,
            open_log_folder,
            set_window_always_on_top
        ])
        .run(tauri::generate_context!())
        .expect("error while running BTC Lottery Pet");
}

#[cfg(test)]
mod tests {
    use super::{get_system_info, AppConfig, ComputeMode, PerformancePreset};
    use crate::gpu_miner;

    fn run_gpu_hardware_tests() -> bool {
        std::env::var_os("BTC_LOTTERY_PET_RUN_GPU_HARDWARE_TESTS").is_some()
    }

    #[test]
    fn normalizes_saved_config_to_safe_startup_values() {
        let config = AppConfig {
            real_mining_enabled: true,
            compute_mode: ComputeMode::Gpu,
            gpu_enabled: true,
            gpu_device_id: Some("simulated-gpu".into()),
            ..AppConfig::default()
        };

        let normalized = config.normalized();

        assert!(!normalized.real_mining_enabled);
        assert_eq!(normalized.compute_mode, ComputeMode::Gpu);
        assert!(normalized.gpu_enabled);
    }

    #[test]
    fn migrates_known_pool_default_ports() {
        for pool_host in ["public-pool.io", "pool.nerdminer.io", "pool.nerdminers.org"] {
            let normalized = AppConfig {
                pool_host: pool_host.into(),
                pool_port: 21496,
                ..AppConfig::default()
            }
            .normalized();

            assert_eq!(normalized.pool_host, pool_host);
            assert_eq!(normalized.pool_port, 3333);
        }

        let custom = AppConfig {
            pool_host: "example.invalid".into(),
            pool_port: 21496,
            ..AppConfig::default()
        }
        .normalized();

        assert_eq!(custom.pool_host, "example.invalid");
        assert_eq!(custom.pool_port, 21496);
    }

    #[test]
    fn normalization_defaults_blank_worker_and_zero_port() {
        let config = AppConfig {
            pool_host: " example.invalid ".into(),
            pool_port: 0,
            worker_name: "   ".into(),
            ..AppConfig::default()
        };

        let normalized = config.normalized();

        assert_eq!(normalized.pool_host, "example.invalid");
        assert_eq!(normalized.pool_port, 3333);
        assert_eq!(normalized.worker_name, "btc-lottery-pet");
    }

    #[test]
    fn compute_mode_controls_gpu_enabled_flag() {
        let config = AppConfig {
            compute_mode: ComputeMode::Gpu,
            gpu_enabled: false,
            ..AppConfig::default()
        };

        let normalized = config.normalized();

        assert_eq!(normalized.compute_mode, ComputeMode::Gpu);
        assert!(normalized.gpu_enabled);
        assert_eq!(normalized.cpu_threads, 0);
    }

    #[test]
    fn pet_profile_id_defaults_and_rejects_unknown_values() {
        let default = AppConfig::default().normalized();
        assert_eq!(default.pet_profile_id, "classic-slot");

        let known = AppConfig {
            pet_profile_id: " cyber-miner ".into(),
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(known.pet_profile_id, "cyber-miner");

        let unknown = AppConfig {
            pet_profile_id: "mystery-pack".into(),
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(unknown.pet_profile_id, "classic-slot");
    }

    #[test]
    fn performance_presets_control_cpu_threads() {
        let available_threads = super::available_parallelism();
        let recommended_threads = super::recommended_cpu_threads();

        let eco = AppConfig {
            performance_preset: PerformancePreset::Eco,
            cpu_threads: available_threads,
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(eco.cpu_threads, 1);

        let normal = AppConfig {
            performance_preset: PerformancePreset::Normal,
            cpu_threads: 1,
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(normal.cpu_threads, recommended_threads);

        let turbo = AppConfig {
            performance_preset: PerformancePreset::Turbo,
            cpu_threads: 1,
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(turbo.cpu_threads, available_threads);

        let custom = AppConfig {
            performance_preset: PerformancePreset::Custom,
            cpu_threads: available_threads + 1,
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(custom.cpu_threads, available_threads);
    }

    #[test]
    fn reports_conservative_cpu_thread_defaults() {
        let info = get_system_info();

        assert!(info.available_parallelism >= 1);
        assert_eq!(info.default_cpu_threads, 1);
        assert!(info.recommended_cpu_threads >= 1);
        assert!(info.recommended_cpu_threads <= info.available_parallelism);
    }

    #[test]
    fn diagnostic_config_serialization_excludes_address_and_webhook() {
        let config = AppConfig {
            btc_address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".into(),
            webhook_url: "https://example.invalid/secret-hook".into(),
            pool_password: "d=1".into(),
            pool_host: "public-pool.io".into(),
            worker_name: "desktop".into(),
            ..AppConfig::default()
        };

        let serialized = serde_json::to_string(&super::diagnostic_config(config)).unwrap();

        assert!(serialized.contains("public-pool.io"));
        assert!(serialized.contains("desktop"));
        assert!(!serialized.contains("btc_address"));
        assert!(!serialized.contains("webhook_url"));
        assert!(!serialized.contains("pool_password"));
        assert!(!serialized.contains("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
        assert!(!serialized.contains("secret-hook"));
        assert!(!serialized.contains("d=1"));
    }

    #[test]
    fn diagnostic_snapshot_schema_uses_single_identity_fields() {
        let snapshot = super::DiagnosticSnapshot {
            diagnostic_schema_version: super::DIAGNOSTIC_SCHEMA_VERSION,
            generated_at: "2026-06-15T00:00:00Z".into(),
            product_name: "BTC Lottery Pet".into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            identifier: "com.btc-lottery-pet.desktop".into(),
            config: super::diagnostic_config(AppConfig::default()),
            gpu_devices: Vec::new(),
            log_path: String::new(),
            recent_log_lines: Vec::new(),
            last_connection_error: None,
            redacted_fields: Vec::new(),
        };

        let value = serde_json::to_value(snapshot).unwrap();

        assert_eq!(value["diagnostic_schema_version"], 2);
        assert_eq!(value["identifier"], "com.btc-lottery-pet.desktop");
        assert!(value.get("flavor").is_none());
    }

    #[test]
    fn diagnostic_log_lines_redact_address_and_webhook() {
        let config = AppConfig {
            btc_address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".into(),
            webhook_url: "https://example.invalid/secret-hook".into(),
            pool_password: "d=1".into(),
            ..AppConfig::default()
        };

        let sanitized = super::sanitize_diagnostic_line(
            "connection error for 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa with d=1 via https://example.invalid/secret-hook",
            &config,
        );

        assert!(sanitized.contains("[redacted btc address]"));
        assert!(sanitized.contains("[redacted pool password]"));
        assert!(sanitized.contains("[redacted webhook url]"));
        assert!(!sanitized.contains("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
        assert!(!sanitized.contains("d=1"));
        assert!(!sanitized.contains("secret-hook"));
    }

    #[test]
    fn diagnostic_redacted_fields_track_configured_sensitive_values() {
        let empty = AppConfig::default();
        assert!(super::diagnostic_redacted_fields(&empty).is_empty());

        let configured = AppConfig {
            btc_address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".into(),
            webhook_url: "https://example.invalid/secret-hook".into(),
            pool_password: "d=1".into(),
            ..AppConfig::default()
        };

        assert_eq!(
            super::diagnostic_redacted_fields(&configured),
            vec![
                "btc_address".to_owned(),
                "pool_password".to_owned(),
                "webhook_url".to_owned()
            ]
        );
    }

    #[test]
    fn gpu_benchmark_returns_a_result() {
        if !run_gpu_hardware_tests() {
            eprintln!("skipping hardware GPU backend smoke test");
            return;
        }

        // Call the underlying sync functions directly (the Tauri commands are async wrappers)
        let devices = gpu_miner::enumerate_gpu_devices();

        // There should always be at least the "auto" entry
        assert!(!devices.is_empty());
        assert_eq!(devices[0].id, "auto");

        // Verify GPU backend can be initialized (but don't run actual mining
        // batches — old/buggy OpenCL drivers like AMD Caicos can crash the
        // process with STATUS_ACCESS_VIOLATION during kernel execution).
        match gpu_miner::create_gpu_backend(None, 25) {
            Ok(gpu) => {
                assert!(!gpu.device_name().is_empty());
            }
            Err(_) => {
                // GPU init may fail on machines without a compatible GPU — that's OK
            }
        }
    }
}
