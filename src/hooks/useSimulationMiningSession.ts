import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { createHashAttemptEvent, createShareEvent } from "../domain/miningEvents";
import type { MiningEvent } from "../domain/miningEvents";
import type { DevLogEntry } from "../domain/miningLogs";
import type { SimulationStats } from "../miningLogic";

interface UseSimulationMiningSessionArgs {
  isMining: boolean;
  realModeEnabled: boolean;
  restartKey: number;
  simShareTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setLatestLog: Dispatch<SetStateAction<string>>;
  setSimAccepted: Dispatch<SetStateAction<number>>;
  setSimRejected: Dispatch<SetStateAction<number>>;
  setSimulationStats: Dispatch<SetStateAction<SimulationStats>>;
  emitMiningEvent: (event: MiningEvent) => void;
  appendDevLog: (source: DevLogEntry["source"], message: string) => void;
}

export function useSimulationMiningSession({
  isMining,
  realModeEnabled,
  restartKey,
  simShareTimerRef,
  setLatestLog,
  setSimAccepted,
  setSimRejected,
  setSimulationStats,
  emitMiningEvent,
  appendDevLog,
}: UseSimulationMiningSessionArgs) {
  useEffect(() => {
    if (!isMining || realModeEnabled) {
      return;
    }

    const startSecs = new Date().toLocaleTimeString();
    appendDevLog("simulation", `[${startSecs}] Connecting to simulation pool...`);
    setLatestLog("I am entering dream mode.");
    const t1 = setTimeout(() => {
      appendDevLog("simulation", `[${new Date().toLocaleTimeString()}] Connected to simulation pool`);
      setLatestLog("The dream signal is warm.");
    }, 600);
    const t2 = setTimeout(() => {
      appendDevLog("simulation", `[${new Date().toLocaleTimeString()}] Subscribed to simulation pool`);
      setLatestLog("A pretend pool sent a puzzle.");
    }, 1200);
    const t3 = setTimeout(() => {
      appendDevLog("simulation", `[${new Date().toLocaleTimeString()}] Authorized worker successfully`);
      setLatestLog("My dream worker is ready.");
    }, 1800);

    const updateStats = () => {
      const rand = Math.random();
      const timeStr = new Date().toLocaleTimeString();

      if (rand < 0.12) {
        const isShareAccepted = Math.random() < 0.95;
        const jobNum = Math.floor(Math.random() * 1000);
        const nonceHex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");

        appendDevLog("simulation", `[${timeStr}] Share submitted: job_id=sim-${jobNum}, nonce=${nonceHex}`);

        if (simShareTimerRef.current) {
          clearTimeout(simShareTimerRef.current);
        }
        simShareTimerRef.current = setTimeout(() => {
          if (isShareAccepted) {
            setSimAccepted((a) => a + 1);
            appendDevLog("simulation", `[${new Date().toLocaleTimeString()}] Share accepted!`);
            emitMiningEvent(createShareEvent("share_accepted", "simulation", "Share accepted!"));
          } else {
            setSimRejected((r) => r + 1);
            const rejectedMessage = "Share rejected. Reason: share target out of range";
            appendDevLog("simulation", `[${new Date().toLocaleTimeString()}] ${rejectedMessage}`);
            emitMiningEvent(createShareEvent("share_rejected", "simulation", rejectedMessage));
          }
          simShareTimerRef.current = null;
        }, 300);
      } else if (rand < 0.3) {
        const jobNum = Math.floor(Math.random() * 1000);
        appendDevLog("simulation", `[${timeStr}] Job received: id=sim-${jobNum}, diff=0.01`);
        setLatestLog("A dream puzzle arrived.");
      }

      const luckyFlash = Math.random() < 0.08;
      const candidateDifficulty = Math.random() * Math.random() * 4_500;

      const addedHashrate = 0.85 + Math.random() * 0.7;
      emitMiningEvent(createHashAttemptEvent("simulation", Math.round(addedHashrate * 1_000_000)));

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
      appendDevLog("simulation", `[${new Date().toLocaleTimeString()}] Mining stopped`);
      setLatestLog("Dream mode is resting.");
    };
  }, [isMining, realModeEnabled, restartKey, emitMiningEvent, appendDevLog]);
}
