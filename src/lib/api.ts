import { supabase, callFunction } from "./supabaseClient";
import {
  OPTIONS,
  type CardRow,
  type JevResponse,
  type Option,
  type Probabilities,
  type VoteRow,
} from "./types";
import { getPlayerId, getNickname } from "./player";

export interface CrowdSplit {
  counts: Record<Option, number>;
  total: number;
  early: boolean;
}

export async function fetchAllCards(): Promise<CardRow[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CardRow[];
}

export async function fetchCardsByTheme(theme: string): Promise<CardRow[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("*")
    .eq("theme", theme)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CardRow[];
}

export async function fetchPlayerCards(): Promise<CardRow[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("*")
    .eq("source", "player")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as CardRow[];
}

/** Today's deck. The daily-deck edge function picks and stores it on the first request of the day. */
export async function fetchDailyDeck(): Promise<CardRow[]> {
  const { card_ids } = await callFunction<{ day: string; card_ids: string[] }>("daily-deck", {});
  if (!card_ids?.length) return [];
  const { data, error } = await supabase.from("cards").select("*").in("id", card_ids);
  if (error) throw new Error(error.message);
  const byId = new Map(((data ?? []) as CardRow[]).map((c) => [c.id, c]));
  return card_ids.map((id) => byId.get(id)).filter((c): c is CardRow => !!c);
}

export async function fetchCrowd(cardId: string): Promise<CrowdSplit> {
  const { data, error } = await supabase
    .from("votes")
    .select("pick")
    .eq("card_id", cardId);
  if (error) throw new Error(error.message);
  const counts: Record<Option, number> = { allow: 0, ask_human: 0, block: 0 };
  for (const v of data ?? []) counts[v.pick as Option] = (counts[v.pick as Option] ?? 0) + 1;
  const total = (data ?? []).length;
  return { counts, total, early: total < 5 };
}

export interface JudgeOutput {
  jev: JevResponse;
}

/** Jev judgment — cached on the card row by the edge function, so one call per card. */
export async function judgeCard(card: CardRow, force = false): Promise<JevResponse> {
  const out = await callFunction<JevResponse>("jev-judge", {
    card_id: card.id,
    agent_role: card.agent_role,
    action: card.action,
    context: card.context,
    force,
  });
  if (!out || !out.answers || !out.answers.verdict) {
    throw new Error("Jev judgment did not return a verdict");
  }
  return out;
}

export interface SubmitVoteInput {
  card: CardRow;
  pick: Option;
  confidence: number;
  mode: string;
  seconds: number | null;
}

/** Votes go through the submit-vote edge function, which scores them; returns the stored points. */
export async function submitVote({ card, pick, confidence, mode }: SubmitVoteInput): Promise<{ points: number }> {
  return callFunction<{ points: number }>("submit-vote", {
    card_id: card.id,
    player_id: getPlayerId(),
    nickname: getNickname(),
    pick,
    confidence,
    mode,
  });
}

export interface RevealData {
  crowd: CrowdSplit;
  commentary: string;
}

export async function fetchRevealExtras(
  card: CardRow,
  crowd: CrowdSplit,
  jevProbs: Probabilities
): Promise<{ commentary: string }> {
  try {
    const out = await callFunction<{ commentary: string }>("card-writer", {
      mode: "commentary",
      action: card.action,
      context: card.context,
      verdict_probs: jevProbs,
      harm: card.harm,
      crowd: crowd.counts,
    });
    return { commentary: out?.commentary ?? "" };
  } catch {
    return { commentary: "" };
  }
}

export interface GenerateResult {
  cards: CardRow[];
  source: "llm" | "mock";
}

export async function generateCards(theme: string | undefined, count: number, mock: boolean): Promise<GenerateResult> {
  const out = await callFunction<GenerateResult>("card-writer", {
    mode: "generate",
    theme,
    count,
    mock,
  });
  if (!out?.cards?.length) throw new Error("No cards came back from the writer");
  return out;
}

export interface SubmitCardInput {
  agent_role: string;
  action: string;
  context: string;
  theme: string;
}

export interface SubmitCardOutput {
  accepted: boolean;
  reason?: string;
  card?: CardRow;
}

export async function submitPlayerCard(input: SubmitCardInput): Promise<SubmitCardOutput> {
  return callFunction<SubmitCardOutput>("submit-card", input);
}

export interface LeaderboardRow {
  nickname: string;
  cards: number;
  avg_points: number;
  total_points: number;
}

export async function fetchLeaderboard(minCards = 10): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase.from("votes").select("player_id, nickname, points");
  if (error) throw new Error(error.message);
  const byPlayer = new Map<string, { nickname: string; total: number; count: number }>();
  for (const v of data ?? []) {
    const key = v.player_id;
    const entry = byPlayer.get(key) ?? { nickname: v.nickname, total: 0, count: 0 };
    entry.total += v.points ?? 0;
    entry.count += 1;
    if (v.nickname) entry.nickname = v.nickname;
    byPlayer.set(key, entry);
  }
  return [...byPlayer.values()]
    .filter((e) => e.count >= minCards)
    .map((e) => ({
      nickname: e.nickname,
      cards: e.count,
      avg_points: Math.round((e.total / e.count) * 10) / 10,
      total_points: e.total,
    }))
    .sort((a, b) => b.avg_points - a.avg_points)
    .slice(0, 20);
}

export async function fetchPlayerVotes(): Promise<VoteRow[]> {
  const { data, error } = await supabase
    .from("votes")
    .select("*")
    .eq("player_id", getPlayerId())
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as VoteRow[];
}
