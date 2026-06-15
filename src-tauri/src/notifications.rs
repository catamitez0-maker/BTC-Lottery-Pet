use std::{thread, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::miner;

const WEBHOOK_WARNING: &str = "[Warning] Webhook notification failed; check notification settings.";

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NotificationChannel {
    #[default]
    LocalWindowsToast,
    Webhook,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub(crate) enum HeartbeatInterval {
    #[serde(rename = "off")]
    #[default]
    Off,
    #[serde(rename = "30min")]
    ThirtyMin,
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "6h")]
    SixHours,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationSettings {
    pub enable_notifications: bool,
    pub notify_on_jackpot: bool,
    pub notify_on_share_accepted: bool,
    pub notify_on_connection_error: bool,
    pub heartbeat_interval: HeartbeatInterval,
    pub notification_channel: NotificationChannel,
    pub webhook_url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JackpotNotificationEvent {
    pub pool: String,
    pub job_id: String,
    pub hash: String,
    pub difficulty: f64,
    pub timestamp: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeartbeatSnapshot {
    pub status: String,
    pub hashrate: f64,
    pub accepted_shares: u64,
    pub rejected_shares: u64,
    pub best_difficulty: f64,
    pub uptime: String,
    pub pool: String,
}

#[derive(Clone, Debug, PartialEq)]
enum NotificationAction {
    Local {
        title: String,
        body: String,
        play_sound: bool,
    },
    Webhook {
        url: String,
        body: Value,
    },
}

pub(crate) fn notify_jackpot(
    app: &AppHandle,
    settings: NotificationSettings,
    event: JackpotNotificationEvent,
) {
    run_actions(app, jackpot_actions(&settings, &event));
}

pub(crate) fn notify_share_accepted(app: &AppHandle, settings: NotificationSettings) {
    run_actions(app, share_accepted_actions(&settings));
}

pub(crate) fn notify_connection_error(
    app: &AppHandle,
    settings: NotificationSettings,
    status: String,
) {
    run_actions(app, connection_error_actions(&settings, &status));
}

pub(crate) fn send_heartbeat(
    app: &AppHandle,
    settings: NotificationSettings,
    snapshot: HeartbeatSnapshot,
) {
    run_actions(app, heartbeat_actions(&settings, &snapshot));
}

fn jackpot_actions(
    settings: &NotificationSettings,
    event: &JackpotNotificationEvent,
) -> Vec<NotificationAction> {
    if !settings.enable_notifications || !settings.notify_on_jackpot {
        return Vec::new();
    }

    let mut actions = vec![NotificationAction::Local {
        title: "BTC Lottery Pet JACKPOT".into(),
        body: format!(
            "Block candidate found on {}. Hash: {}",
            event.pool, event.hash
        ),
        play_sound: true,
    }];

    if settings.notification_channel == NotificationChannel::Webhook
        && !settings.webhook_url.trim().is_empty()
    {
        actions.push(NotificationAction::Webhook {
            url: settings.webhook_url.trim().to_owned(),
            body: json!({
                "event": "jackpot",
                "pool": event.pool,
                "job_id": event.job_id,
                "hash": event.hash,
                "difficulty": event.difficulty,
                "timestamp": event.timestamp,
                "note": "found_block.json saved locally"
            }),
        });
    }

    actions
}

fn share_accepted_actions(settings: &NotificationSettings) -> Vec<NotificationAction> {
    if !settings.enable_notifications
        || !settings.notify_on_share_accepted
        || settings.notification_channel != NotificationChannel::LocalWindowsToast
    {
        return Vec::new();
    }

    vec![NotificationAction::Local {
        title: "BTC Lottery Pet".into(),
        body: "Share accepted.".into(),
        play_sound: false,
    }]
}

fn connection_error_actions(
    settings: &NotificationSettings,
    status: &str,
) -> Vec<NotificationAction> {
    if !settings.enable_notifications
        || !settings.notify_on_connection_error
        || settings.notification_channel != NotificationChannel::LocalWindowsToast
    {
        return Vec::new();
    }

    vec![NotificationAction::Local {
        title: "BTC Lottery Pet connection warning".into(),
        body: status.to_owned(),
        play_sound: true,
    }]
}

fn heartbeat_actions(
    settings: &NotificationSettings,
    snapshot: &HeartbeatSnapshot,
) -> Vec<NotificationAction> {
    if !settings.enable_notifications || settings.heartbeat_interval == HeartbeatInterval::Off {
        return Vec::new();
    }

    match settings.notification_channel {
        NotificationChannel::LocalWindowsToast => vec![NotificationAction::Local {
            title: "BTC Lottery Pet heartbeat".into(),
            body: format!(
                "{} | {} H/s | shares {}/{} | best diff {:.4} | uptime {} | {}",
                snapshot.status,
                snapshot.hashrate.round(),
                snapshot.accepted_shares,
                snapshot.rejected_shares,
                snapshot.best_difficulty,
                snapshot.uptime,
                snapshot.pool
            ),
            play_sound: false,
        }],
        NotificationChannel::Webhook => {
            if !settings.webhook_url.trim().is_empty() {
                vec![NotificationAction::Webhook {
                    url: settings.webhook_url.trim().to_owned(),
                    body: json!({
                        "event": "heartbeat",
                        "status": snapshot.status,
                        "hashrate": snapshot.hashrate,
                        "accepted_shares": snapshot.accepted_shares,
                        "rejected_shares": snapshot.rejected_shares,
                        "best_difficulty": snapshot.best_difficulty,
                        "uptime": snapshot.uptime,
                        "pool": snapshot.pool
                    }),
                }]
            } else {
                Vec::new()
            }
        }
    }
}

fn run_actions(app: &AppHandle, actions: Vec<NotificationAction>) {
    // Use this app instance's identifier as the toast AppUserModelID so
    // notifications attribute to the installed app.
    let app_id = app.config().identifier.clone();
    for action in actions {
        match action {
            NotificationAction::Local {
                title,
                body,
                play_sound,
            } => {
                if let Err(_error) = show_local_notification(&app_id, &title, &body, play_sound) {
                    miner::log_message(app, "[Warning] Local notification failed.");
                }
            }
            NotificationAction::Webhook { url, body } => {
                let app = app.clone();
                thread::spawn(move || {
                    if post_json(&url, &body).is_err() {
                        miner::log_message(&app, WEBHOOK_WARNING);
                    }
                });
            }
        }
    }
}

fn show_local_notification(
    app_id: &str,
    title: &str,
    body: &str,
    play_sound: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winrt_notification::{Sound, Toast};
        let mut toast = Toast::new(app_id).title(title).text1(body);
        if play_sound {
            toast = toast.sound(Some(Sound::SMS));
        } else {
            toast = toast.sound(None);
        }
        toast
            .show()
            .map_err(|error| format!("failed to show local notification: {:?}", error))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (app_id, title, body, play_sound);
        Ok(())
    }
}

fn post_json(url: &str, body: &Value) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("webhook URL must start with http:// or https://".into());
    }

    ureq::post(url)
        .timeout(Duration::from_secs(5))
        .send_json(body)
        .map_err(|error| format!("failed to execute webhook request: {error}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    use serde_json::json;

    use super::{
        connection_error_actions, heartbeat_actions, jackpot_actions, post_json,
        share_accepted_actions, HeartbeatInterval, HeartbeatSnapshot, JackpotNotificationEvent,
        NotificationAction, NotificationChannel, NotificationSettings,
    };

    fn settings(channel: NotificationChannel) -> NotificationSettings {
        NotificationSettings {
            enable_notifications: true,
            notify_on_jackpot: true,
            notify_on_share_accepted: false,
            notify_on_connection_error: true,
            heartbeat_interval: HeartbeatInterval::Off,
            notification_channel: channel,
            webhook_url: "http://127.0.0.1:1/hook".into(),
        }
    }

    fn jackpot_event() -> JackpotNotificationEvent {
        JackpotNotificationEvent {
            pool: "public-pool.io:3333".into(),
            job_id: "job-1".into(),
            hash: "000000abc".into(),
            difficulty: 42.0,
            timestamp: "2026-06-03T00:00:00Z".into(),
        }
    }

    #[test]
    fn simulated_block_found_triggers_local_notification_action() {
        let actions = jackpot_actions(
            &settings(NotificationChannel::LocalWindowsToast),
            &jackpot_event(),
        );

        assert!(matches!(
            actions.first(),
            Some(NotificationAction::Local {
                play_sound: true,
                ..
            })
        ));
    }

    #[test]
    fn jackpot_webhook_payload_is_sanitized() {
        let actions = jackpot_actions(&settings(NotificationChannel::Webhook), &jackpot_event());
        let body = actions.iter().find_map(|action| match action {
            NotificationAction::Webhook { body, .. } => Some(body),
            _ => None,
        });

        let body = body.expect("expected webhook action");
        let serialized = serde_json::to_string(body).unwrap();
        assert!(serialized.contains("\"event\":\"jackpot\""));
        assert!(serialized.contains("\"note\":\"found_block.json saved locally\""));
        assert!(!serialized.contains("btc_address"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("seed"));
    }

    #[test]
    fn share_accepted_notification_defaults_off() {
        assert!(
            share_accepted_actions(&settings(NotificationChannel::LocalWindowsToast)).is_empty()
        );
    }

    #[test]
    fn connection_error_uses_local_channel_only() {
        assert!(!connection_error_actions(
            &settings(NotificationChannel::LocalWindowsToast),
            "Connection error"
        )
        .is_empty());
        assert!(connection_error_actions(
            &settings(NotificationChannel::Webhook),
            "Connection error"
        )
        .is_empty());
    }

    #[test]
    fn heartbeat_webhook_respects_interval_setting() {
        let mut notification_settings = settings(NotificationChannel::Webhook);
        notification_settings.heartbeat_interval = HeartbeatInterval::OneHour;
        let snapshot = HeartbeatSnapshot {
            status: "Mining".into(),
            hashrate: 1000.0,
            accepted_shares: 1,
            rejected_shares: 0,
            best_difficulty: 3.5,
            uptime: "00:10:00".into(),
            pool: "public-pool.io:3333".into(),
        };

        assert!(matches!(
            heartbeat_actions(&notification_settings, &snapshot).first(),
            Some(NotificationAction::Webhook { .. })
        ));
    }

    #[test]
    fn posts_webhook_json_to_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];

            loop {
                let bytes_read = stream.read(&mut buffer).unwrap_or(0);
                if bytes_read == 0 {
                    break;
                }

                request.extend_from_slice(&buffer[..bytes_read]);
                let text = String::from_utf8_lossy(&request);
                let Some(header_end) = text.find("\r\n\r\n") else {
                    continue;
                };

                let headers = &text[..header_end];
                let body_len = request.len().saturating_sub(header_end + 4);
                let content_length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                });
                let headers_lower = headers.to_ascii_lowercase();

                if content_length.is_some_and(|length| body_len >= length)
                    || (headers_lower.contains("transfer-encoding: chunked")
                        && text.contains("\r\n0\r\n\r\n"))
                {
                    break;
                }
            }

            let text = String::from_utf8_lossy(&request).to_string();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            text
        });

        post_json(
            &format!("http://{address}/notify"),
            &json!({ "event": "jackpot", "hash": "abc" }),
        )
        .unwrap();
        let request = server.join().unwrap();

        assert!(request.contains("POST /notify HTTP/1.1"));
        assert!(request.contains("\"event\":\"jackpot\""));
        assert!(request.contains("\"hash\":\"abc\""));
    }

    #[test]
    fn webhook_failure_can_be_reported_without_exposing_url() {
        let error = post_json("ftp://example.invalid/hook", &json!({})).unwrap_err();

        assert!(!error.contains("example.invalid"));
    }
}
