import type { CSSProperties } from "react";
import type { PetStatus } from "../domain/petState";
import type { RealMiningStats, SimulationStats } from "../miningLogic";
import type { PetCompanionSnapshot } from "../pets/companion";
import type { PetProfile } from "../pets/profiles";

type PetMachineStyle = CSSProperties & { [key: `--${string}`]: string };

interface PetDisplayProps {
  petProfile: PetProfile;
  companion: PetCompanionSnapshot;
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

function colorChannel(hexColor: string) {
  const trimmed = hexColor.trim().replace(/^#/, "");
  const normalized = trimmed.length === 3
    ? trimmed.split("").map((part) => `${part}${part}`).join("")
    : trimmed;
  const parsed = Number.parseInt(normalized, 16);

  if (normalized.length !== 6 || Number.isNaN(parsed)) {
    return "247, 147, 26";
  }

  return [
    (parsed >> 16) & 255,
    (parsed >> 8) & 255,
    parsed & 255,
  ].join(", ");
}

function colorWithAlpha(hexColor: string, alpha: number) {
  return `rgba(${colorChannel(hexColor)}, ${alpha})`;
}

function profileStyle(profile: PetProfile): PetMachineStyle {
  return {
    "--pet-cabinet": profile.palette.cabinet,
    "--pet-cabinet-dark": profile.palette.cabinetDark,
    "--pet-primary": profile.palette.primary,
    "--pet-secondary": profile.palette.secondary,
    "--pet-screen": profile.palette.screen,
    "--pet-screen-glow": profile.palette.screenGlow,
    "--pet-reel": profile.palette.reel,
    "--pet-accent": profile.palette.accent,
    "--pet-error": profile.palette.error,
    "--pet-primary-glow": colorWithAlpha(profile.palette.primary, 0.36),
    "--pet-secondary-glow": colorWithAlpha(profile.palette.secondary, 0.52),
    "--pet-screen-glow-soft": colorWithAlpha(profile.palette.screenGlow, 0.58),
    "--pet-reel-glow": colorWithAlpha(profile.palette.reel, 0.56),
    "--pet-accent-glow": colorWithAlpha(profile.palette.accent, 0.44),
    "--pet-error-glow": colorWithAlpha(profile.palette.error, 0.48),
  } as PetMachineStyle;
}

export default function PetDisplay({
  petProfile,
  companion,
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
  const appearance = petProfile.states[petStatus];
  const containerClass = [
    "pet-machine-container",
    appearance.animation,
    `pet-shape-${petProfile.body.shape}`,
    `pet-silhouette-${petProfile.body.silhouette}`,
    `pet-screen-${petProfile.body.screenShape}`,
    `pet-feet-${petProfile.body.feet}`,
    `pet-pose-${petProfile.body.idlePose}`,
    `pet-mood-${companion.mood}`,
    `pet-profile-${petProfile.id}`,
  ].join(" ");
  const careMeters = [
    companion.care.energy,
    companion.care.bond,
    companion.care.focus,
  ];

  return (
    <>
      <div
        aria-label={`${petProfile.accessibilityLabel}: ${companion.ariaLabel}`}
        className={containerClass}
        style={profileStyle(petProfile)}
      >
        <div className="pet-machine">
          <span className={`pet-ornament pet-ornament-${petProfile.body.ornament}`} aria-hidden="true" />
          <div className="pet-accent-marks" aria-hidden="true">
            {petProfile.body.accentMarks.map((mark) => (
              <span className={`pet-mark pet-mark-${mark}`} key={mark} />
            ))}
          </div>
          <div className="pet-marquee">
            <span>{companion.name}</span>
            <b>{petProfile.body.badge}</b>
          </div>
          <div className="pet-lights">
            <span className="light light-1"></span>
            <span className="light light-2"></span>
            <span className="light light-3"></span>
          </div>
          <div className="pet-screen">
            <div className="pet-expression">{appearance.expression}</div>
            <div className="pet-slots">
              <div className="slot-reel reel-1">
                {isMiningAnimation ? (
                  <div className="reel-strip">
                    {petProfile.reels[0].map((symbol, index) => (
                      <span key={`${symbol}-${index}`}>{symbol}</span>
                    ))}
                  </div>
                ) : (
                  <span>{appearance.slots[0]}</span>
                )}
              </div>
              <div className="slot-reel reel-2">
                {isMiningAnimation ? (
                  <div className="reel-strip delay-1">
                    {petProfile.reels[1].map((symbol, index) => (
                      <span key={`${symbol}-${index}`}>{symbol}</span>
                    ))}
                  </div>
                ) : (
                  <span>{appearance.slots[1]}</span>
                )}
              </div>
              <div className="slot-reel reel-3">
                {isMiningAnimation ? (
                  <div className="reel-strip delay-2">
                    {petProfile.reels[2].map((symbol, index) => (
                      <span key={`${symbol}-${index}`}>{symbol}</span>
                    ))}
                  </div>
                ) : (
                  <span>{appearance.slots[2]}</span>
                )}
              </div>
            </div>
          </div>
          <div className="pet-status-plate">{appearance.statusLabel}</div>
          <div className="pet-identity-strip">
            <span>{companion.species}</span>
            <b>{companion.moodLabel}</b>
          </div>
          <div className="pet-panel-decor">
            <span className="decor-btn decor-btn-red"></span>
            <span className="decor-btn decor-btn-blue"></span>
          </div>
          <div className="pet-feet" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="smoke-container">
            <span className="smoke-puff puff-1"></span>
            <span className="smoke-puff puff-2"></span>
          </div>
        </div>
        <div className="pet-companion-panel">
          <div className="pet-speech">
            <b>{companion.moodLabel}</b>
            <span>{companion.reaction}</span>
          </div>
          <div className="pet-care-meters" aria-label="Pet care meters">
            {careMeters.map((meter) => (
              <span key={meter.label}>
                <b>{meter.label}</b>
                <i>
                  <em style={{ width: `${meter.value}%` }} />
                </i>
              </span>
            ))}
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
