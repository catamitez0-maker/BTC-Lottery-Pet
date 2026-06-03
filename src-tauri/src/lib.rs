mod miner;
mod notifications;

use std::{fs, path::PathBuf, process::Command, thread};

use miner::{MiningController, RealMiningSettings};
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

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ComputeMode {
    #[default]
    Cpu,
    GpuSim,
    GpuBenchmark,
    GpuRealExperimental,
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
    worker_name: String,
    cpu_limit_percent: u8,
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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            btc_address: String::new(),
            pool_host: "public-pool.io".into(),
            pool_port: 21496,
            worker_name: "btc-lottery-pet".into(),
            cpu_limit_percent: 10,
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
        }
    }
}

impl AppConfig {
    fn normalized(mut self) -> Self {
        self.btc_address = self.btc_address.trim().to_owned();
        self.pool_host = self.pool_host.trim().to_owned();
        self.worker_name = self.worker_name.trim().to_owned();
        self.webhook_url = self.webhook_url.trim().to_owned();
        self.real_mining_enabled = false;
        self.gpu_device_id = self
            .gpu_device_id
            .map(|device_id| device_id.trim().to_owned())
            .filter(|device_id| !device_id.is_empty());

        if self.pool_host.is_empty() {
            self.pool_host = "public-pool.io".into();
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
            ComputeMode::Cpu | ComputeMode::GpuRealExperimental => {
                self.compute_mode = ComputeMode::Cpu;
                self.gpu_enabled = false;
                self.gpu_device_id = None;
            }
            ComputeMode::GpuSim | ComputeMode::GpuBenchmark => {
                self.gpu_enabled = true;
            }
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
}

fn available_parallelism() -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

fn recommended_cpu_threads() -> usize {
    available_parallelism().min(2)
}

fn default_port_for_pool(pool_host: &str) -> u16 {
    if pool_host == "public-pool.io" {
        21496
    } else {
        3333
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
        fs::read_to_string(path).map_err(|error| format!("failed to read config: {error}"))?;
    let config: AppConfig = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse config: {error}"))?;

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
fn get_gpu_devices() -> Vec<GpuDevice> {
    vec![
        GpuDevice {
            id: "auto".into(),
            name: "Auto".into(),
            simulated: true,
        },
        GpuDevice {
            id: "simulated-gpu".into(),
            name: "Simulated GPU".into(),
            simulated: true,
        },
    ]
}

#[tauri::command]
fn run_gpu_benchmark(
    gpu_device_id: Option<String>,
    gpu_intensity_percent: u8,
) -> GpuBenchmarkResult {
    let gpu_intensity_percent = gpu_intensity_percent.clamp(1, 100);
    let device_id = gpu_device_id.unwrap_or_else(|| "auto".into());
    let device_name = if device_id == "simulated-gpu" {
        "Simulated GPU"
    } else {
        "Auto"
    };

    GpuBenchmarkResult {
        device_id,
        device_name: device_name.into(),
        simulated: true,
        gpu_intensity_percent,
        hashrate: 120_000_000.0 * f64::from(gpu_intensity_percent) / 10.0,
        duration_ms: 250,
        note: "Simulated benchmark only. No real GPU workload was started.".into(),
    }
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
    use super::{
        get_gpu_devices, get_system_info, run_gpu_benchmark, AppConfig, ComputeMode,
        PerformancePreset,
    };

    #[test]
    fn normalizes_saved_config_to_safe_startup_values() {
        let config = AppConfig {
            real_mining_enabled: true,
            compute_mode: ComputeMode::GpuRealExperimental,
            gpu_enabled: true,
            gpu_device_id: Some("simulated-gpu".into()),
            ..AppConfig::default()
        };

        let normalized = config.normalized();

        assert!(!normalized.real_mining_enabled);
        assert_eq!(normalized.compute_mode, ComputeMode::Cpu);
        assert!(!normalized.gpu_enabled);
        assert_eq!(normalized.gpu_device_id, None);
    }

    #[test]
    fn compute_mode_controls_gpu_enabled_flag() {
        let config = AppConfig {
            compute_mode: ComputeMode::GpuSim,
            gpu_enabled: false,
            ..AppConfig::default()
        };

        let normalized = config.normalized();

        assert_eq!(normalized.compute_mode, ComputeMode::GpuSim);
        assert!(normalized.gpu_enabled);
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
    fn gpu_benchmark_is_simulated_placeholder_only() {
        let devices = get_gpu_devices();
        let result = run_gpu_benchmark(Some("simulated-gpu".into()), 25);

        assert_eq!(devices.len(), 2);
        assert!(devices.iter().all(|device| device.simulated));
        assert!(result.simulated);
        assert_eq!(result.device_id, "simulated-gpu");
        assert_eq!(result.gpu_intensity_percent, 25);
        assert!(result.note.contains("No real GPU workload"));
    }
}
