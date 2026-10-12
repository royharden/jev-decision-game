/**
 * daily-deck — returns today's (UTC) deck, creating it on first request. Decks are
 * created only here, with the service role: anon has no INSERT on daily_decks.
 *
 * Body (max 16 KB, contents ignored): {}.
 * Returns { day, card_ids } with up to 10 card ids, picked at random from all cards.
 * `day` is the primary key, so concurrent first requests converge on one stored row.
 */
import { corsHeaders } from "../_shared/cors.ts";
import { json, readJsonBody } from "../_shared/http.ts";
import { errorResponse, notConfigured, serviceClient } from "../_shared/usage.ts";

const FN = "daily-deck";
const DECK_SIZE = 10;

/** Fisher-Yates with crypto randomness, so tomorrow's deck can't be predicted. */
function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  const rnd = new Uint32Array(1);
  for (let i = copy.length - 1; i > 0; i--) {
    crypto.getRandomValues(rnd);
    const j = rnd[0] % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  try {
    if (req.method !== "POST") return json({ error: "POST required" }, 405);
    const read = await readJsonBody(req);
    if ("error" in read) return read.error;

    const supabase = serviceClient();
    if (!supabase) return notConfigured("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    const day = new Date().toISOString().slice(0, 10);
    const getDeck = async () => {
      const { data, error } = await supabase.from("daily_decks").select("card_ids").eq("day", day).maybeSingle();
      if (error) throw new Error(`deck lookup failed: ${error.message}`);
      return (data?.card_ids ?? null) as string[] | null;
    };

    let cardIds = await getDeck();
    if (!cardIds) {
      const { data: cards, error } = await supabase.from("cards").select("id");
      if (error) throw new Error(`card list failed: ${error.message}`);
      const picked = shuffle((cards ?? []).map((c) => c.id as string)).slice(0, DECK_SIZE);
      if (!picked.length) return json({ day, card_ids: [] });

      const { error: insertError } = await supabase
        .from("daily_decks")
        .upsert({ day, card_ids: picked }, { onConflict: "day", ignoreDuplicates: true });
      if (insertError) throw new Error(`deck insert failed: ${insertError.message}`);
      // Re-read so every caller gets the stored row, even if another request won the insert.
      cardIds = (await getDeck()) ?? picked;
    }

    return json({ day, card_ids: cardIds });
  } catch (err) {
    return errorResponse(FN, err);
  }
});
