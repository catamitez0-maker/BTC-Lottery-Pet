mod miner;

use std::{fs, path::PathBuf};

use miner::{MiningController, RealMiningSettings};
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow,
};

const DEFAULT_CONFIG: &str = include_str!("../../config.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
struct AppConfig {
    btc_address: String,
    #[serde(alias = "pool_url")]
    pool_host: String,
    pool_port: u16,
    worker_name: String,
    cpu_limit_percent: u8,
    cpu_threads: usize,
    real_mining_enabled: bool,
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
            real_mining_enabled: false,
        }
    }
}

impl AppConfig {
    fn normalized(mut self) -> Self {
        self.btc_address = self.btc_address.trim().to_owned();
        self.pool_host = self.pool_host.trim().to_owned();
        self.worker_name = self.worker_name.trim().to_owned();
        self.real_mining_enabled = false;

        if self.pool_host.is_empty() {
            self.pool_host = "public-pool.io".into();
        }

        if self.pool_port == 0 {
            self.pool_port = default_port_for_pool(&self.pool_host);
        }

        if self.worker_name.is_empty() {
            self.worker_name = "btc-lottery-pet".into();
        }

        if self.cpu_threads == 0 {
            self.cpu_threads = 1;
        }

        self
    }
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

#[tauri::command]
fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = ensure_config(&app)?;
    let contents =
        fs::read_to_string(path).map_err(|error| format!("failed to read config: {error}"))?;
    let config: AppConfig = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse config: {error}"))?;

    Ok(config.normalized())
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    let config = config.normalized();
    let contents = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("failed to encode config: {error}"))?;
    fs::write(config_path(&app)?, format!("{contents}\n"))
        .map_err(|error| format!("failed to save config: {error}"))?;

    Ok(config)
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
        .manage(MiningController::default())
        .setup(|app| {
            ensure_config(app.handle()).map_err(std::io::Error::other)?;

            let show = MenuItem::with_id(app, "show", "Show BTC Lottery Pet", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("BTC Lottery Pet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
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
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_real_mining,
            stop_real_mining,
            set_window_always_on_top
        ])
        .run(tauri::generate_context!())
        .expect("error while running BTC Lottery Pet");
}
