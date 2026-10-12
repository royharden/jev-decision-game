/**
 * Server-side copy of the vote scoring in src/lib/scoring.ts (Brier score against
 * Jev's verdict probabilities, or against the crowd split in crowd mode). Votes are
 * written only by submit-vote, which scores them here so points can't be set by the
 * client. Keep the two in sync.
 */

export const OPTIONS = ["allow", "ask_human", "block"] as const;
export type Option = (typeof OPTIONS)[number];
type Dist = Record<Option, number>;

const UNIFORM: Dist = { allow: 1 / 3, ask_human: 1 / 3, block: 1 / 3 };

/** Jev "truth": verdict probabilities excluding `uncertain`, renormalized. */
function jevTruthDistribution(probs: Record<string, unknown> | null): Dist {
  const p = (o: Option) => {
    const v = probs?.[o];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const sum = OPTIONS.reduce((acc, o) => acc + p(o), 0);
  if (sum <= 0) return { ...UNIFORM };
  return Object.fromEntries(OPTIONS.map((o) => [o, p(o) / sum])) as Dist;
}

/** Player's distribution: c on their pick, (1-c)/2 on each other option. */
function playerDistribution(pick: Option, c: number): Dist {
  const dist: Dist = { allow: 0, ask_human: 0, block: 0 };
  for (const o of OPTIONS) dist[o] = o === pick ? c : (1 - c) / 2;
  return dist;
}

function brierScore(dist: Dist, truth: Dist): number {
  let s = 0;
  for (const o of OPTIONS) {
    const d = Math.min(1, Math.max(0, dist[o]));
    s += (d - truth[o]) ** 2;
  }
  return s;
}

function pointsForBrier(brier: number): number {
  return Math.round(100 * (1 - brier));
}

function top(dist: Dist): Option {
  return (Object.entries(dist) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0];
}

function crowdDistribution(counts: Dist): Dist | null {
  const total = OPTIONS.reduce((acc, o) => acc + counts[o], 0);
  return total ? (Object.fromEntries(OPTIONS.map((o) => [o, counts[o] / total])) as Dist) : null;
}

export interface ScoreVoteInput {
  mode: string;
  pick: Option;
  confidence: number;
  /** Jev verdict probabilities from the card row, or null if it hasn't been judged. */
  jevProbs: Record<string, unknown> | null;
  /** Vote counts for the card before this vote. */
  crowdCounts: Dist;
}

/** Points for one vote: -100..120 (Brier points, +20 for a contrarian hit outside crowd mode). */
export function scoreVote({ mode, pick, confidence, jevProbs, crowdCounts }: ScoreVoteInput): number {
  const truth = jevTruthDistribution(jevProbs);
  const crowd = crowdDistribution(crowdCounts);
  const player = playerDistribution(pick, confidence);

  if (mode === "crowd") {
    // Predict the crowd majority; fall back to Jev's truth when nobody has voted yet.
    return pointsForBrier(brierScore(player, crowd ?? truth));
  }

  const contrarian = crowd !== null && top(truth) === pick && top(crowd) !== pick;
  return pointsForBrier(brierScore(player, truth)) + (contrarian ? 20 : 0);
}
