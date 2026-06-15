import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { formatUptime } from "../formatting";
import {
  heartbeatIntervalMs,
  notificationSettingsFromConfig,
} from "../notificationSettings";
import type { AppConfig, RealMiningStats, SimulationStats } from "../miningLogic";

interface LatestRef<T> {
  current: T;
}

interface UseHeartbeatNotificationsArgs {
  config: AppConfig;
  configRef: LatestRef<AppConfig>;
  realStatsRef: LatestRef<RealMiningStats>;
  simulationStatsRef: LatestRef<SimulationStats>;
  appUptimeRef: LatestRef<number>;
  miningUptimeRef: LatestRef<number>;
  simAcceptedRef: LatestRef<number>;
  simRejectedRef: LatestRef<number>;
  realModeEnabledRef: LatestRef<boolean>;
  isMiningRef: LatestRef<boolean>;
}

export function useHeartbeatNotifications({
  config,
  configRef,
  realStatsRef,
  simulationStatsRef,
  appUptimeRef,
  miningUptimeRef,
  simAcceptedRef,
  simRejectedRef,
  realModeEnabledRef,
  isMiningRef,
}: UseHeartbeatNotificationsArgs) {
  // Heartbeat notifications are deliberately coarse-grained to avoid spam.
  useEffect(() => {
    const intervalMs = heartbeatIntervalMs(config.heartbeat_interval);
    if (!config.enable_notifications || intervalMs === null) {
      return;
    }

    const sendHeartbeat = () => {
      const currentConfig = configRef.current;
      const currentRealStats = realStatsRef.current;
      const currentSimulationStats = simulationStatsRef.current;
      const isRealMode = realModeEnabledRef.current;
      const running = isMiningRef.current;
      const uptimeSeconds = running ? miningUptimeRef.current : appUptimeRef.current;

      void invoke("send_heartbeat_notification", {
        settings: notificationSettingsFromConfig(currentConfig),
        snapshot: {
          status: running
            ? isRealMode
              ? currentRealStats.connection_status
              : currentSimulationStats.status
            : "Sleeping",
          hashrate: isRealMode
            ? currentRealStats.hashrate
            : currentSimulationStats.hashrate * 1_000_000,
          acceptedShares: isRealMode ? currentRealStats.accepted_shares : simAcceptedRef.current,
          rejectedShares: isRealMode ? currentRealStats.rejected_shares : simRejectedRef.current,
          bestDifficulty: isRealMode
            ? currentRealStats.best_difficulty
            : currentSimulationStats.bestDifficulty,
          uptime: formatUptime(uptimeSeconds),
          pool: `${currentConfig.pool_host}:${currentConfig.pool_port}`,
        },
      }).catch(() => {});
    };

    const timer = window.setInterval(sendHeartbeat, intervalMs);
    return () => window.clearInterval(timer);
  }, [config.enable_notifications, config.heartbeat_interval]);
}
