import type { AppConfig, HeartbeatInterval } from "./miningLogic";

export function notificationSettingsFromConfig(config: AppConfig) {
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

export function heartbeatIntervalMs(interval: HeartbeatInterval) {
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
