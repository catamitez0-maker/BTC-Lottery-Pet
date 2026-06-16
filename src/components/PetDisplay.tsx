import type { PetStatus } from "../domain/petState";
import type { RealMiningStats, SimulationStats } from "../miningLogic";

interface PetDisplayProps {
  petStatus: PetStatus;
  isMiningAnimation: boolean;
  displayMode: "compact" | "detail";
  compactComputeMode: string;
  displayedHashrate: string;
  realModeEnabled: boolean;
  realStats: RealMiningStats;
  simulationStats: SimulationStats;
  blockHeight: string;
  formatDifficulty: (value: number) => string;
}

function getPetExpression(status: PetStatus): string {
  switch (status) {
    case "Sleeping":
      return "( -ω- )zzZ";
    case "Connecting":
      return "( ._.)";
    case "Cooling Down":
      return "( ~_~ )";
    case "Connection Error":
      return "( x_x )";
    case "Jackpot":
      return "( ₿∀₿ )";
    case "Lucky Flash":
      return "( ★∀★ )";
    case "New Best Diff":
      return "( ≧▽≦ )";
    case "Overdrive":
      return "( >_> )!";
    case "Mining":
      return "( •̀_•́ )";
    default:
      return "( •̀_•́ )";
  }
}

function getSlotChar(status: PetStatus, index: number): string {
  switch (status) {
    case "Sleeping":
      return ["Z", "z", "Z"][index];
    case "Connecting":
      return ["C", "N", "N"][index];
    case "Cooling Down":
      return ["C", "O", "L"][index];
    case "Connection Error":
      return ["E", "R", "R"][index];
    case "Jackpot":
      return ["₿", "₿", "₿"][index];
    case "Lucky Flash":
      return ["₿", "₿", "₿"][index];
    case "New Best Diff":
      return ["B", "S", "T"][index];
    case "Overdrive":
      return ["G", "P", "U"][index];
    default:
      return "-";
  }
}

export default function PetDisplay({
  petStatus,
  isMiningAnimation,
  displayMode,
  compactComputeMode,
  displayedHashrate,
  realModeEnabled,
  realStats,
  simulationStats,
  blockHeight,
  formatDifficulty,
}: PetDisplayProps) {
  const containerClass = `pet-machine-container ${petStatus.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <>
      <div className={containerClass}>
        <div className="pet-machine">
          <div className="pet-lights">
            <span className="light light-1"></span>
            <span className="light light-2"></span>
            <span className="light light-3"></span>
          </div>
          <div className="pet-screen">
            <div className="pet-expression">{getPetExpression(petStatus)}</div>
            <div className="pet-slots">
              <div className="slot-reel reel-1">
                {isMiningAnimation ? (
                  <div className="reel-strip">
                    <span>₿</span><span>9</span><span>7</span><span>2</span><span>3</span><span>₿</span>
                  </div>
                ) : (
                  <span>{getSlotChar(petStatus, 0)}</span>
                )}
              </div>
              <div className="slot-reel reel-2">
                {isMiningAnimation ? (
                  <div className="reel-strip delay-1">
                    <span>7</span><span>₿</span><span>1</span><span>8</span><span>5</span><span>7</span>
                  </div>
                ) : (
                  <span>{getSlotChar(petStatus, 1)}</span>
                )}
              </div>
              <div className="slot-reel reel-3">
                {isMiningAnimation ? (
                  <div className="reel-strip delay-2">
                    <span>9</span><span>2</span><span>₿</span><span>7</span><span>6</span><span>9</span>
                  </div>
                ) : (
                  <span>{getSlotChar(petStatus, 2)}</span>
                )}
              </div>
            </div>
          </div>
          <div className="pet-panel-decor">
            <span className="decor-btn decor-btn-red"></span>
            <span className="decor-btn decor-btn-blue"></span>
          </div>
          <div className="smoke-container">
            <span className="smoke-puff puff-1"></span>
            <span className="smoke-puff puff-2"></span>
          </div>
        </div>
      </div>

      {displayMode === "compact" && (
        <div className="mini-stats-line">
          <span>{compactComputeMode}: {displayedHashrate}</span>
          <span className="divider">|</span>
          <span>D: {formatDifficulty(realModeEnabled ? realStats.best_difficulty : simulationStats.bestDifficulty)}</span>
          <span className="divider">|</span>
          <span>B: {blockHeight}</span>
        </div>
      )}
    </>
  );
}
