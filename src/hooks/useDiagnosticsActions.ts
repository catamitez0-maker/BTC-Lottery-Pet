import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import { formatError } from "../formatting";

interface UseDiagnosticsActionsArgs {
  runningInTauri: boolean;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setPetLogMessage: (message: string) => void;
  getDevLogSnapshot?: () => string;
}

export function useDiagnosticsActions({
  runningInTauri,
  setErrorMessage,
  setPetLogMessage,
  getDevLogSnapshot,
}: UseDiagnosticsActionsArgs) {
  const openLogs = async () => {
    setErrorMessage(null);

    try {
      await invoke("open_log_folder");
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not open logs: ${formatError(error)}`);
      } else {
        setErrorMessage("Log folder is available in the desktop app.");
      }
    }
  };

  const copyLogPath = async () => {
    setErrorMessage(null);

    try {
      const path = await invoke<string>("get_log_path");
      await navigator.clipboard.writeText(path);
      setPetLogMessage("Log path copied.");
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not copy log path: ${formatError(error)}`);
      } else {
        setErrorMessage("Log path copy is available in the desktop app.");
      }
    }
  };

  const copyDiagnostics = async () => {
    setErrorMessage(null);

    try {
      const snapshot = await invoke<string>("get_diagnostic_snapshot");
      const devLogSnapshot = getDevLogSnapshot?.();
      await navigator.clipboard.writeText(
        devLogSnapshot ? `${snapshot}\n\n--- Frontend DEV LOG ---\n${devLogSnapshot}` : snapshot,
      );
      setPetLogMessage("Diagnostic snapshot copied.");
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not copy diagnostics: ${formatError(error)}`);
      } else {
        setErrorMessage("Diagnostics export is available in the desktop app.");
      }
    }
  };

  const saveDiagnostics = async () => {
    setErrorMessage(null);

    try {
      const path = await invoke<string>("save_diagnostic_snapshot");
      setPetLogMessage("Diagnostic snapshot saved.");
    } catch (error) {
      if (runningInTauri) {
        setErrorMessage(`Could not save diagnostics: ${formatError(error)}`);
      } else {
        setErrorMessage("Diagnostics save is available in the desktop app.");
      }
    }
  };

  return {
    openLogs,
    copyLogPath,
    copyDiagnostics,
    saveDiagnostics,
  };
}
