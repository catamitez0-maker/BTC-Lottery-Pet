import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { SimulationStats } from "../miningLogic";

interface UseSimulationMiningSessionArgs {
  isMining: boolean;
  realModeEnabled: boolean;
  restartKey: number;
  simShareTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  simLuckyTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setLatestLog: Dispatch<SetStateAction<string>>;
  setSimAccepted: Dispatch<SetStateAction<number>>;
  setSimRejected: Dispatch<SetStateAction<number>>;
  setSimulationStats: Dispatch<SetStateAction<SimulationStats>>;
  setIsLucky: Dispatch<SetStateAction<boolean>>;
}

export function useSimulationMiningSession({
  isMining,
  realModeEnabled,
  restartKey,
  simShareTimerRef,
  simLuckyTimerRef,
  setLatestLog,
  setSimAccepted,
  setSimRejected,
  setSimulationStats,
  setIsLucky,
}: UseSimulationMiningSessionArgs) {
  useEffect(() => {
    if (!isMining || realModeEnabled) {
      return;
    }

    const startSecs = new Date().toLocaleTimeString();
    setLatestLog(`[${startSecs}] Connecting to simulation pool...`);
    const t1 = setTimeout(() => {
      setLatestLog(`[${new Date().toLocaleTimeString()}] Connected to simulation pool`);
    }, 600);
    const t2 = setTimeout(() => {
      setLatestLog(`[${new Date().toLocaleTimeString()}] Subscribed to simulation pool`);
    }, 1200);
    const t3 = setTimeout(() => {
      setLatestLog(`[${new Date().toLocaleTimeString()}] Authorized worker successfully`);
    }, 1800);

    const updateStats = () => {
      const rand = Math.random();
      const timeStr = new Date().toLocaleTimeString();

      if (rand < 0.12) {
        const isShareAccepted = Math.random() < 0.95;
        const jobNum = Math.floor(Math.random() * 1000);
        const nonceHex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");

        setLatestLog(`[${timeStr}] Share submitted: job_id=sim-${jobNum}, nonce=${nonceHex}`);

        if (simShareTimerRef.current) {
          clearTimeout(simShareTimerRef.current);
        }
        simShareTimerRef.current = setTimeout(() => {
          if (isShareAccepted) {
            setSimAccepted((a) => a + 1);
            setLatestLog(`[${new Date().toLocaleTimeString()}] Share accepted!`);
            setIsLucky(true);
            if (simLuckyTimerRef.current) {
              clearTimeout(simLuckyTimerRef.current);
            }
            simLuckyTimerRef.current = setTimeout(() => {
              setIsLucky(false);
              simLuckyTimerRef.current = null;
            }, 3000);
          } else {
            setSimRejected((r) => r + 1);
            setLatestLog(`[${new Date().toLocaleTimeString()}] Share rejected. Reason: share target out of range`);
          }
          simShareTimerRef.current = null;
        }, 300);
      } else if (rand < 0.3) {
        const jobNum = Math.floor(Math.random() * 1000);
        setLatestLog(`[${timeStr}] Job received: id=sim-${jobNum}, diff=0.01`);
      }

      const luckyFlash = Math.random() < 0.08;
      const candidateDifficulty = Math.random() * Math.random() * 4_500;

      const addedHashrate = 0.85 + Math.random() * 0.7;

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
      if (simLuckyTimerRef.current) {
        clearTimeout(simLuckyTimerRef.current);
        simLuckyTimerRef.current = null;
      }
      setIsLucky(false);
      setLatestLog(`[${new Date().toLocaleTimeString()}] Mining stopped`);
    };
  }, [isMining, realModeEnabled, restartKey]);
}
