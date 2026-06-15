export interface ProbabilityInput {
  currentDifficulty: number | null;
  hashrate: number;
  bestDifficulty: number;
  acceptedShares: number;
  rejectedShares: number;
  miningUptimeSeconds: number;
  realModeEnabled: boolean;
}

export interface ProbabilitySnapshot {
  currentDifficulty: number | null;
  estimatedTimeToBlockSeconds: number | null;
  luckMeter: number;
  streakCounter: number;
}

const TWO_POW_32 = 2 ** 32;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function calculateProbabilitySnapshot(input: ProbabilityInput): ProbabilitySnapshot {
  const hashrate = Number.isFinite(input.hashrate) ? Math.max(0, input.hashrate) : 0;
  const difficulty =
    input.currentDifficulty && Number.isFinite(input.currentDifficulty) && input.currentDifficulty > 0
      ? input.currentDifficulty
      : null;
  const estimatedTimeToBlockSeconds = difficulty && hashrate > 0
    ? difficulty * TWO_POW_32 / hashrate
    : null;

  const attemptsFactor = hashrate > 0 && input.miningUptimeSeconds > 0
    ? Math.log10(hashrate * input.miningUptimeSeconds + 10) * 8
    : 0;
  const bestFactor = input.bestDifficulty > 0
    ? Math.log10(input.bestDifficulty + 1) * 12
    : 0;
  const shareFactor = input.acceptedShares * 9 - input.rejectedShares * 3;
  const modeFactor = input.realModeEnabled ? 8 : 3;
  const luckMeter = Math.round(clamp(modeFactor + attemptsFactor + bestFactor + shareFactor, 0, 100));

  return {
    currentDifficulty: difficulty,
    estimatedTimeToBlockSeconds,
    luckMeter,
    streakCounter: Math.max(0, input.acceptedShares - input.rejectedShares),
  };
}

export function formatProbabilityTime(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return "Waiting";
  }

  const years = seconds / (365.25 * 24 * 3600);
  if (years >= 1_000_000) {
    return `${Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(years / 1_000_000)}M years`;
  }

  if (years >= 1) {
    return `${Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(years)} years`;
  }

  const days = seconds / 86_400;
  if (days >= 1) {
    return `${Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(days)} days`;
  }

  const hours = seconds / 3_600;
  if (hours >= 1) {
    return `${Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(hours)} hours`;
  }

  return `${Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(seconds)} sec`;
}
