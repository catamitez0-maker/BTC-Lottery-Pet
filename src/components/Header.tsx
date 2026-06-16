import type { ComputeMode } from "../miningLogic";

interface HeaderProps {
  realModeEnabled: boolean;
  computeMode: ComputeMode;
  displayMode: "compact" | "detail";
  setDisplayMode: React.Dispatch<React.SetStateAction<"compact" | "detail">>;
  isMining: boolean;
  openModeSelection: () => void;
  alwaysOnTop: boolean;
  toggleAlwaysOnTop: () => void;
}

export default function Header({
  realModeEnabled,
  computeMode,
  displayMode,
  setDisplayMode,
  isMining,
  openModeSelection,
  alwaysOnTop,
  toggleAlwaysOnTop,
}: HeaderProps) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">
          {realModeEnabled
            ? computeMode === "gpu"
              ? "GPU MINING"
              : computeMode === "hybrid"
                ? "CPU + GPU MINING"
                : "CPU MINING"
            : "SIMULATION MODE"}
        </p>
        <h1>BTC Lottery Pet</h1>
      </div>
      <div className="header-actions">
        <button
          className={`mode-button ${displayMode === "detail" ? "armed" : ""}`}
          onClick={() => setDisplayMode((mode) => (mode === "compact" ? "detail" : "compact"))}
          title="Toggle compact/detail mode"
          type="button"
        >
          {displayMode === "compact" ? "DETAIL" : "PET"}
        </button>
        <button
          className={`mode-button ${realModeEnabled ? "armed" : ""}`}
          disabled={isMining}
          onClick={openModeSelection}
          title="Choose mining mode"
          type="button"
        >
          MODE
        </button>
        <button
          className={`pin-button ${alwaysOnTop ? "active" : ""}`}
          onClick={toggleAlwaysOnTop}
          title="Toggle always on top"
          type="button"
        >
          {alwaysOnTop ? "PIN" : "FREE"}
        </button>
      </div>
    </header>
  );
}
