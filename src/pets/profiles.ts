import type { PetStatus } from "../domain/petState";

export const DEFAULT_PET_PROFILE_ID = "classic-slot";

export const PET_PROFILE_STATUSES: PetStatus[] = [
  "Sleeping",
  "Connecting",
  "Mining",
  "Overdrive",
  "Lucky Flash",
  "Cooling Down",
  "Connection Error",
  "New Best Diff",
  "Jackpot",
];

export type PetProfileKind = "procedural" | "sprite";
export type PetBodyShape = "slot-cabinet" | "cyber-console" | "fortune-arcade";
export type PetBodySilhouette = "wide-cabinet" | "tall-console" | "round-arcade";
export type PetScreenShape = "flat" | "visor" | "arched";
export type PetFeetStyle = "stubby" | "skids" | "pads";
export type PetIdlePose = "settled" | "alert" | "bouncy";
export type PetOrnament = "lever" | "antenna" | "coin";
export type PetAnimationToken =
  | "sleeping"
  | "connecting"
  | "mining"
  | "overdrive"
  | "lucky-flash"
  | "cooling-down"
  | "connection-error"
  | "new-best-diff"
  | "jackpot";

export interface PetPalette {
  cabinet: string;
  cabinetDark: string;
  primary: string;
  secondary: string;
  screen: string;
  screenGlow: string;
  reel: string;
  accent: string;
  error: string;
}

export interface PetStateAppearance {
  expression: string;
  slots: [string, string, string];
  animation: PetAnimationToken;
  statusLabel: string;
}

export interface PetVoiceLines {
  idle: string;
  connecting: string;
  mining: string;
  overdrive: string;
  lucky: string;
  jackpot: string;
  error: string;
  coolingDown: string;
  rejected: string;
}

export interface PetPersonality {
  name: string;
  species: string;
  trait: string;
  favoriteSignal: string;
  voice: PetVoiceLines;
}

export interface PetBodyDesign {
  shape: PetBodyShape;
  silhouette: PetBodySilhouette;
  screenShape: PetScreenShape;
  feet: PetFeetStyle;
  idlePose: PetIdlePose;
  badge: string;
  ornament: PetOrnament;
  accentMarks: string[];
}

export interface SpritePetSource {
  src: string;
  frameWidth: number;
  frameHeight: number;
  frameMap: Partial<Record<PetStatus, number>>;
}

export interface PetProfile {
  id: string;
  name: string;
  kind: PetProfileKind;
  manifestVersion: 1;
  description: string;
  accessibilityLabel: string;
  tags: string[];
  body: PetBodyDesign;
  personality: PetPersonality;
  palette: PetPalette;
  reels: [string[], string[], string[]];
  states: Record<PetStatus, PetStateAppearance>;
  sprite?: SpritePetSource;
}

export type PetManifest = PetProfile;

export interface PetManifestValidationResult {
  ok: boolean;
  errors: string[];
}

const PET_PROFILE_KIND_VALUES: PetProfileKind[] = ["procedural", "sprite"];
const PET_BODY_SHAPE_VALUES: PetBodyShape[] = ["slot-cabinet", "cyber-console", "fortune-arcade"];
const PET_BODY_SILHOUETTE_VALUES: PetBodySilhouette[] = ["wide-cabinet", "tall-console", "round-arcade"];
const PET_SCREEN_SHAPE_VALUES: PetScreenShape[] = ["flat", "visor", "arched"];
const PET_FEET_STYLE_VALUES: PetFeetStyle[] = ["stubby", "skids", "pads"];
const PET_IDLE_POSE_VALUES: PetIdlePose[] = ["settled", "alert", "bouncy"];
const PET_ORNAMENT_VALUES: PetOrnament[] = ["lever", "antenna", "coin"];
const PET_ANIMATION_TOKEN_VALUES: PetAnimationToken[] = [
  "sleeping",
  "connecting",
  "mining",
  "overdrive",
  "lucky-flash",
  "cooling-down",
  "connection-error",
  "new-best-diff",
  "jackpot",
];

const classicStates: Record<PetStatus, PetStateAppearance> = {
  Sleeping: {
    expression: "(-_-) z",
    slots: ["Z", "z", "Z"],
    animation: "sleeping",
    statusLabel: "Standby",
  },
  Connecting: {
    expression: "(._.)",
    slots: ["C", "N", "N"],
    animation: "connecting",
    statusLabel: "Dialing",
  },
  Mining: {
    expression: "(>_<)",
    slots: ["-", "-", "-"],
    animation: "mining",
    statusLabel: "Rolling",
  },
  Overdrive: {
    expression: "(>_>)!",
    slots: ["G", "P", "U"],
    animation: "overdrive",
    statusLabel: "Overdrive",
  },
  "Lucky Flash": {
    expression: "(*_*)",
    slots: ["B", "T", "C"],
    animation: "lucky-flash",
    statusLabel: "Lucky",
  },
  "Cooling Down": {
    expression: "(~_~)",
    slots: ["C", "O", "L"],
    animation: "cooling-down",
    statusLabel: "Cooldown",
  },
  "Connection Error": {
    expression: "(x_x)",
    slots: ["E", "R", "R"],
    animation: "connection-error",
    statusLabel: "Fault",
  },
  "New Best Diff": {
    expression: "(^_^)",
    slots: ["B", "S", "T"],
    animation: "new-best-diff",
    statusLabel: "Best",
  },
  Jackpot: {
    expression: "(BTC!)",
    slots: ["B", "T", "C"],
    animation: "jackpot",
    statusLabel: "Jackpot",
  },
};

export const builtinPetProfiles: PetProfile[] = [
  {
    id: "classic-slot",
    name: "Classic Slot",
    kind: "procedural",
    manifestVersion: 1,
    description: "Warm amber cabinet with old-school lottery reels.",
    accessibilityLabel: "Classic arcade slot pet",
    tags: ["arcade", "btc", "starter"],
    body: {
      shape: "slot-cabinet",
      silhouette: "wide-cabinet",
      screenShape: "flat",
      feet: "stubby",
      idlePose: "settled",
      badge: "BTC",
      ornament: "lever",
      accentMarks: ["coin-slot", "side-rail"],
    },
    personality: {
      name: "Bitty",
      species: "Pocket slot miner",
      trait: "steady",
      favoriteSignal: "accepted shares",
      voice: {
        idle: "Waiting for a spin.",
        connecting: "Listening for the pool tone.",
        mining: "Reels are warm. Hashes are moving.",
        overdrive: "GPU lights are hot.",
        lucky: "That share sounded bright.",
        jackpot: "Jackpot signal locked.",
        error: "Pool line is rough. Check the route.",
        coolingDown: "Cooling the cabinet.",
        rejected: "Rejected share logged. Staying steady.",
      },
    },
    palette: {
      cabinet: "#313643",
      cabinetDark: "#171a22",
      primary: "#f7931a",
      secondary: "#ffd35a",
      screen: "#07120f",
      screenGlow: "#00ff66",
      reel: "#f7931a",
      accent: "#29b6f6",
      error: "#ff4a4a",
    },
    reels: [
      ["B", "9", "7", "2", "3", "B"],
      ["7", "B", "1", "8", "5", "7"],
      ["9", "2", "B", "7", "6", "9"],
    ],
    states: classicStates,
  },
  {
    id: "cyber-miner",
    name: "Cyber Miner",
    kind: "procedural",
    manifestVersion: 1,
    description: "Cool cyan mining console tuned for GPU runs.",
    accessibilityLabel: "Cyber console mining pet",
    tags: ["gpu", "cyan", "console"],
    body: {
      shape: "cyber-console",
      silhouette: "tall-console",
      screenShape: "visor",
      feet: "skids",
      idlePose: "alert",
      badge: "GPU",
      ornament: "antenna",
      accentMarks: ["heat-vents", "scanline"],
    },
    personality: {
      name: "Volt",
      species: "Hash drone",
      trait: "focused",
      favoriteSignal: "stable dispatch",
      voice: {
        idle: "Core parked. Sensors online.",
        connecting: "Syncing stratum handshake.",
        mining: "Pipeline stable. Watching nonce flow.",
        overdrive: "GPU lane active. Thermal margin watched.",
        lucky: "Signal spike caught.",
        jackpot: "Target breach confirmed.",
        error: "Fault detected. Pool or GPU needs attention.",
        coolingDown: "Throttle window open.",
        rejected: "Rejected share isolated.",
      },
    },
    palette: {
      cabinet: "#203446",
      cabinetDark: "#0b1621",
      primary: "#29b6f6",
      secondary: "#7cffd1",
      screen: "#04131b",
      screenGlow: "#7cffd1",
      reel: "#7cffd1",
      accent: "#f7931a",
      error: "#ff5b6b",
    },
    reels: [
      ["0", "1", "F", "A", "C", "E"],
      ["G", "P", "U", "9", "7", "1"],
      ["H", "A", "S", "H", "2", "4"],
    ],
    states: {
      ...classicStates,
      Sleeping: { expression: "[idle]", slots: ["0", "0", "0"], animation: "sleeping", statusLabel: "Standby" },
      Connecting: { expression: "[sync]", slots: ["S", "Y", "N"], animation: "connecting", statusLabel: "Sync" },
      Mining: { expression: "[hash]", slots: ["-", "-", "-"], animation: "mining", statusLabel: "Hashing" },
      Overdrive: { expression: "[boost]", slots: ["G", "P", "U"], animation: "overdrive", statusLabel: "Boost" },
      Jackpot: { expression: "[WIN]", slots: ["B", "T", "C"], animation: "jackpot", statusLabel: "Jackpot" },
      "Connection Error": { expression: "[ERR]", slots: ["4", "0", "4"], animation: "connection-error", statusLabel: "Fault" },
    },
  },
  {
    id: "lucky-cat",
    name: "Lucky Cat",
    kind: "procedural",
    manifestVersion: 1,
    description: "Playful fortune-counter with bright jackpot energy.",
    accessibilityLabel: "Lucky cat arcade pet",
    tags: ["lucky", "playful", "gold"],
    body: {
      shape: "fortune-arcade",
      silhouette: "round-arcade",
      screenShape: "arched",
      feet: "pads",
      idlePose: "bouncy",
      badge: "777",
      ornament: "coin",
      accentMarks: ["bell-arch", "coin-tray"],
    },
    personality: {
      name: "Mika",
      species: "Fortune arcade pet",
      trait: "playful",
      favoriteSignal: "lucky flashes",
      voice: {
        idle: "Tiny paws on standby.",
        connecting: "Calling the pool bell.",
        mining: "Pawing through hashes.",
        overdrive: "Fast paws, bright lamps.",
        lucky: "Lucky flash collected.",
        jackpot: "Fortune cabinet says yes.",
        error: "The signal slipped. Try the pool line.",
        coolingDown: "Taking a soft cooldown.",
        rejected: "That share bounced. Try again.",
      },
    },
    palette: {
      cabinet: "#3a2f3f",
      cabinetDark: "#17101b",
      primary: "#ff5fb7",
      secondary: "#ffd35a",
      screen: "#130713",
      screenGlow: "#ffd35a",
      reel: "#ffd35a",
      accent: "#7cffd1",
      error: "#ff6b4a",
    },
    reels: [
      ["L", "U", "C", "K", "7", "$"],
      ["7", "$", "B", "T", "C", "7"],
      ["M", "E", "O", "W", "9", "$"],
    ],
    states: {
      ...classicStates,
      Sleeping: { expression: "(=.=)", slots: ["p", "r", "r"], animation: "sleeping", statusLabel: "Nap" },
      Connecting: { expression: "(=o.o=)", slots: ["C", "A", "L"], animation: "connecting", statusLabel: "Calling" },
      Mining: { expression: "(=^.^=)", slots: ["-", "-", "-"], animation: "mining", statusLabel: "Pawing" },
      Overdrive: { expression: "(=>.<=)", slots: ["G", "P", "U"], animation: "overdrive", statusLabel: "Dash" },
      "Lucky Flash": { expression: "(=$.$=)", slots: ["7", "7", "7"], animation: "lucky-flash", statusLabel: "Lucky" },
      Jackpot: { expression: "(=WIN=)", slots: ["B", "T", "C"], animation: "jackpot", statusLabel: "Jackpot" },
    },
  },
];

const profileRegistry = new Map(builtinPetProfiles.map((profile) => [profile.id, profile]));

export const builtinPetProfileIds = builtinPetProfiles.map((profile) => profile.id);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedValue<T extends string>(value: unknown, allowed: readonly T[]) {
  return typeof value === "string" && allowed.includes(value as T);
}

function isHexColor(value: unknown) {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function validatePalette(profile: Partial<PetManifest>, errors: string[]) {
  for (const key of [
    "cabinet",
    "cabinetDark",
    "primary",
    "secondary",
    "screen",
    "screenGlow",
    "reel",
    "accent",
    "error",
  ] as const) {
    if (!isHexColor(profile.palette?.[key])) {
      errors.push(`palette.${key} must be a #RRGGBB color`);
    }
  }
}

function validateBody(profile: Partial<PetManifest>, errors: string[]) {
  if (!isAllowedValue(profile.body?.shape, PET_BODY_SHAPE_VALUES)) {
    errors.push("body.shape is not supported");
  }
  if (!isAllowedValue(profile.body?.silhouette, PET_BODY_SILHOUETTE_VALUES)) {
    errors.push("body.silhouette is not supported");
  }
  if (!isAllowedValue(profile.body?.screenShape, PET_SCREEN_SHAPE_VALUES)) {
    errors.push("body.screenShape is not supported");
  }
  if (!isAllowedValue(profile.body?.feet, PET_FEET_STYLE_VALUES)) {
    errors.push("body.feet is not supported");
  }
  if (!isAllowedValue(profile.body?.idlePose, PET_IDLE_POSE_VALUES)) {
    errors.push("body.idlePose is not supported");
  }
  if (!isAllowedValue(profile.body?.ornament, PET_ORNAMENT_VALUES)) {
    errors.push("body.ornament is not supported");
  }
  if (!hasRequiredText(profile.body?.badge)) {
    errors.push("body.badge is required");
  }
  if (!Array.isArray(profile.body?.accentMarks)) {
    errors.push("body.accentMarks must be an array");
  } else if (profile.body.accentMarks.some((mark) => !/^[a-z0-9-]+$/.test(mark))) {
    errors.push("body.accentMarks must contain class-safe tokens");
  }
}

function validateReels(profile: Partial<PetManifest>, errors: string[]) {
  if (!Array.isArray(profile.reels) || profile.reels.length !== 3) {
    errors.push("reels must contain exactly 3 reel arrays");
    return;
  }

  profile.reels.forEach((reel, index) => {
    if (!Array.isArray(reel) || reel.length === 0 || reel.some((symbol) => !hasRequiredText(symbol))) {
      errors.push(`reels.${index} must contain symbols`);
    }
  });
}

function validateVoice(profile: Partial<PetManifest>, errors: string[]) {
  for (const key of [
    "idle",
    "connecting",
    "mining",
    "overdrive",
    "lucky",
    "jackpot",
    "error",
    "coolingDown",
    "rejected",
  ] as const) {
    if (!hasRequiredText(profile.personality?.voice?.[key])) {
      errors.push(`personality.voice.${key} is required`);
    }
  }
}

function validateStates(profile: Partial<PetManifest>, errors: string[]) {
  for (const status of PET_PROFILE_STATUSES) {
    const state = profile.states?.[status];
    if (!state) {
      errors.push(`states.${status} is required`);
      continue;
    }
    if (!hasRequiredText(state.expression)) {
      errors.push(`states.${status}.expression is required`);
    }
    if (!Array.isArray(state.slots) || state.slots.length !== 3 || state.slots.some((symbol) => !hasRequiredText(symbol))) {
      errors.push(`states.${status}.slots must contain exactly 3 symbols`);
    }
    if (!isAllowedValue(state.animation, PET_ANIMATION_TOKEN_VALUES)) {
      errors.push(`states.${status}.animation is not supported`);
    }
    if (!hasRequiredText(state.statusLabel)) {
      errors.push(`states.${status}.statusLabel is required`);
    }
  }
}

export function validatePetManifest(manifest: unknown): PetManifestValidationResult {
  if (!isRecord(manifest)) {
    return {
      ok: false,
      errors: ["manifest must be an object"],
    };
  }

  const profile = manifest as Partial<PetManifest>;
  const errors: string[] = [];

  if (profile.manifestVersion !== 1) {
    errors.push("manifestVersion must be 1");
  }
  if (typeof profile.id !== "string" || profile.id.trim().length === 0 || !/^[a-z0-9-]+$/.test(profile.id)) {
    errors.push("id must use lowercase letters, numbers, and dashes");
  }
  if (!hasRequiredText(profile.name)) {
    errors.push("name is required");
  }
  if (!isAllowedValue(profile.kind, PET_PROFILE_KIND_VALUES)) {
    errors.push("kind must be procedural or sprite");
  }
  if (!hasRequiredText(profile.accessibilityLabel)) {
    errors.push("accessibilityLabel is required");
  }
  if (!hasRequiredText(profile.personality?.name)) {
    errors.push("personality.name is required");
  }
  if (!hasRequiredText(profile.personality?.species)) {
    errors.push("personality.species is required");
  }
  if (!hasRequiredText(profile.personality?.trait)) {
    errors.push("personality.trait is required");
  }
  if (!hasRequiredText(profile.personality?.favoriteSignal)) {
    errors.push("personality.favoriteSignal is required");
  }

  validatePalette(profile, errors);
  validateBody(profile, errors);
  validateReels(profile, errors);
  validateVoice(profile, errors);
  validateStates(profile, errors);

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function isKnownPetProfileId(profileId: string | null | undefined) {
  return profileRegistry.has((profileId || "").trim());
}

export function getPetProfile(profileId: string | null | undefined) {
  return (
    profileRegistry.get((profileId || "").trim()) ??
    profileRegistry.get(DEFAULT_PET_PROFILE_ID) ??
    builtinPetProfiles[0]
  );
}

export function normalizePetProfileId(profileId: string | null | undefined) {
  return getPetProfile(profileId).id;
}

export function missingPetStates(profile: PetProfile) {
  return PET_PROFILE_STATUSES.filter((status) => !profile.states[status]);
}
