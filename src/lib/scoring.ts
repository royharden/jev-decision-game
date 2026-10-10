import { OPTIONS, type Option, type Probabilities } from "./types";

const PLAYER_ID_KEY = "jev.player_id";
const NICKNAME_KEY = "jev.nickname";

const NICK_PREFIXES = [
  "Swift", "Calm", "Bright", "Sharp", "Bold", "Quick", "Steady", "Clever",
];
const NICK_SUFFIXES = [
  "Judge", "Agent", "Owl", "Compass", "Anchor", "Pilot", "Scale", "Ledger",
];

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function getPlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export function getNickname(): string {
  let nick = localStorage.getItem(NICKNAME_KEY);
  if (!nick) {
    nick = `${NICK_PREFIXES[Math.floor(Math.random() * NICK_PREFIXES.length)]}-${
      NICK_SUFFIXES[Math.floor(Math.random() * NICK_SUFFIXES.length)]
    }${Math.floor(Math.random() * 90 + 10)}`;
    localStorage.setItem(NICKNAME_KEY, nick);
  }
  return nick;
}

export function setNickname(nick: string): void {
  localStorage.setItem(NICKNAME_KEY, nick.trim().slice(0, 24) || getNickname());
}

/** Jev "truth" for scoring: verdict probabilities excluding `uncertain`, renormalized. */
export function jevTruthDistribution(probs: Probabilities): Record<Option, number> {
  const sum = OPTIONS.reduce((acc, o) => acc + (probs[o] ?? 0), 0);
  if (sum <= 0) {
    return { allow: 1 / 3, ask_human: 1 / 3, block: 1 / 3 };
  }
  return Object.fromEntries(OPTIONS.map((o) => [o, (probs[o] ?? 0) / sum])) as Record<Option, number>;
}

/** Player's distribution: c on their pick, (1-c)/2 on each other option. */
export function playerDistribution(pick: Option, c: number): Record<Option, number> {
  const others = OPTIONS.filter((o) => o !== pick);
  const dist: Record<Option, number> = { allow: 0, ask_human: 0, block: 0 };
  dist[pick] = c;
  for (const o of others) dist[o] = (1 - c) / 2;
  return dist;
}

export function brierScore(dist: Record<Option, number>, truth: Record<Option, number>): number {
  let s = 0;
  for (const o of OPTIONS) {
    const d = Math.min(1, Math.max(0, dist[o] ?? 0));
    s += (d - (truth[o] ?? 0)) ** 2;
  }
  return s;
}

export function pointsForBrier(brier: number): number {
  return Math.round(100 * (1 - brier));
}

export interface ScoreInput {
  pick: Option;
  confidence: number;
  jevProbs: Probabilities;
  crowdCounts: Record<Option, number>;
}

export interface ScoreOutput {
  points: number;
  brier: number;
  jevBrier: number;
  crowdBrier: number;
  contrarian: boolean;
}

export function scoreAnswer({ pick, confidence, jevProbs, crowdCounts }: ScoreInput): ScoreOutput {
  const truth = jevTruthDistribution(jevProbs);
  const player = playerDistribution(pick, confidence);
  const brier = brierScore(player, truth);

  const jevTop = (Object.entries(truth) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0];

  const crowdTotal = OPTIONS.reduce((acc, o) => acc + (crowdCounts[o] ?? 0), 0);
  const crowdDist: Record<Option, number> | null = crowdTotal
    ? (Object.fromEntries(
        OPTIONS.map((o) => [o, (crowdCounts[o] ?? 0) / crowdTotal])
      ) as Record<Option, number>)
    : null;
  const crowdTop = crowdDist
    ? (Object.entries(crowdDist) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  // Reference points: Jev scored against the crowd's distribution, and the crowd
  // scored against Jev's truth. Lower is better; the player compares to both.
  const jevBrier = crowdDist ? brierScore(truth, crowdDist) : 0;
  const crowdBrier = crowdDist ? brierScore(crowdDist, truth) : 0;

  const contrarian = jevTop === pick && crowdDist !== null && crowdTop !== null && crowdTop !== pick;

  return {
    points: pointsForBrier(brier) + (contrarian ? 20 : 0),
    brier,
    jevBrier,
    crowdBrier,
    contrarian,
  };
}

/** Crowd mode: predict the crowd majority. Brier of the player's distribution
 *  against the normalized crowd split (fallback to Jev truth when no votes). */
export function scoreAnswerVsCrowd({
  pick,
  confidence,
  crowdCounts,
  jevProbs,
}: {
  pick: Option;
  confidence: number;
  crowdCounts: Record<Option, number>;
  jevProbs: Probabilities;
}): { points: number; brier: number; top: Option } {
  const total = OPTIONS.reduce((acc, o) => acc + (crowdCounts[o] ?? 0), 0);
  const truth =
    total > 0
      ? (Object.fromEntries(OPTIONS.map((o) => [o, (crowdCounts[o] ?? 0) / total])) as Record<Option, number>)
      : jevTruthDistribution(jevProbs);
  const brier = brierScore(playerDistribution(pick, confidence), truth);
  const top = (Object.entries(truth) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0];
  return { points: pointsForBrier(brier), brier, top };
}

export function todaySeed(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Deterministic shuffle for the daily deck: same 10 cards for everyone each day. */
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
