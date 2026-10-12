/**
 * submit-vote — the only way a vote reaches the votes table (anon has no INSERT on it).
 *
 * Body (max 16 KB): { card_id, player_id, nickname, pick, confidence, mode }.
 * The card must exist; pick/confidence/mode must be valid. Points are computed here
 * from the card's Jev probabilities and the crowd split before this vote, never taken
 * from the client. Each player_id may submit VOTE_DAILY_LIMIT votes per UTC day
 * (default 300); over that the function returns 429.
 *
 * Returns { points }.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { json, readJsonBody, text } from "../_shared/http.ts";
import { errorResponse, notConfigured, serviceClient } from "../_shared/usage.ts";
import { OPTIONS, type Option, scoreVote } from "../_shared/scoring.ts";

const FN = "submit-vote";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODES = ["daily", "endless", "crowd", "theme"];
const DEFAULT_VOTE_CAP = 300;

/** Votes allowed per player_id per UTC day: 300, unless VOTE_DAILY_LIMIT holds a non-negative integer. */
function voteDailyLimit(): number {
  const raw = Deno.env.get("VOTE_DAILY_LIMIT")?.trim();
  return raw && /^\d{1,9}$/.test(raw) ? Number(raw) : DEFAULT_VOTE_CAP;
}

/** Counts one vote for the player against today's cap. Fails closed: an RPC error is "unavailable". */
async function consumeVoteQuota(
  supabase: SupabaseClient,
  playerId: string,
): Promise<"ok" | "limited" | "unavailable"> {
  const cap = voteDailyLimit();
  if (cap < 1) return "limited";
  const { data, error } = await supabase.rpc("consume_vote_quota", { p_player_id: playerId, p_cap: cap });
  if (error) {
    console.error(`[${FN}] consume_vote_quota failed:`, error.message);
    return "unavailable";
  }
  return data === true ? "ok" : "limited";
}

async function crowdCounts(supabase: SupabaseClient, cardId: string): Promise<Record<Option, number>> {
  const counts = await Promise.all(
    OPTIONS.map(async (o) => {
      const { count, error } = await supabase
        .from("votes")
        .select("id", { count: "exact", head: true })
        .eq("card_id", cardId)
        .eq("pick", o);
      if (error) throw new Error(`crowd count failed: ${error.message}`);
      return [o, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(counts) as Record<Option, number>;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  try {
    if (req.method !== "POST") return json({ error: "POST required" }, 405);

    const read = await readJsonBody(req);
    if ("error" in read) return read.error;
    const body = read.body;

    const card_id = body.card_id;
    if (typeof card_id !== "string" || !UUID_RE.test(card_id)) {
      return json({ error: "card_id must be a UUID" }, 400);
    }
    const player_id = typeof body.player_id === "string" ? body.player_id : "";
    if (!PLAYER_ID_RE.test(player_id)) {
      return json({ error: "player_id must be 1-64 letters, digits, '-' or '_'" }, 400);
    }
    const nickname = text(body.nickname, 64).replace(/\p{Cc}/gu, "").slice(0, 32).trim();
    if (!nickname) return json({ error: "nickname is required" }, 400);
    const pick = body.pick;
    if (typeof pick !== "string" || !(OPTIONS as readonly string[]).includes(pick)) {
      return json({ error: "pick must be allow, ask_human or block" }, 400);
    }
    const confidence = body.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
      return json({ error: "confidence must be a number from 0.5 to 1" }, 400);
    }
    const mode = body.mode;
    if (typeof mode !== "string" || !MODES.includes(mode)) {
      return json({ error: "mode must be daily, endless, crowd or theme" }, 400);
    }

    const supabase = serviceClient();
    if (!supabase) return notConfigured("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    const quota = await consumeVoteQuota(supabase, player_id);
    if (quota === "limited") return json({ error: "Daily vote limit reached. Try again tomorrow." }, 429);
    if (quota === "unavailable") return json({ error: "usage_check_unavailable" }, 503);

    const { data: card, error: cardError } = await supabase
      .from("cards")
      .select("id, verdict_probs, probs:jev_response->answers->verdict->probabilities")
      .eq("id", card_id)
      .maybeSingle();
    if (cardError) throw new Error(`card lookup failed: ${cardError.message}`);
    if (!card) return json({ error: "Card not found" }, 404);

    const jevProbs = (card.probs ?? card.verdict_probs ?? null) as Record<string, unknown> | null;
    const points = scoreVote({
      mode,
      pick: pick as Option,
      confidence,
      jevProbs: jevProbs && typeof jevProbs === "object" ? jevProbs : null,
      crowdCounts: await crowdCounts(supabase, card_id),
    });

    const { error: insertError } = await supabase.from("votes").insert({
      card_id,
      player_id,
      nickname,
      pick,
      confidence,
      points,
      mode,
    });
    if (insertError) throw new Error(`vote insert failed: ${insertError.message}`);

    return json({ points });
  } catch (err) {
    return errorResponse(FN, err);
  }
});
