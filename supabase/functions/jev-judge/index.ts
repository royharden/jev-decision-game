/**
 * jev-judge — the judge. Calls the TypeSafe SystemOne API (model jev-1.13.0, pinned)
 * once per card with every question batched into a single request, then caches the
 * result on the card row so Jev is called once per card, not once per player.
 *
 * Secrets (server-side only): TYPESAFE_API_KEY, optional DAILY_CALL_LIMIT (default 200
 * Jev requests/day), optional ADMIN_TOKEN (sent as x-admin-token, required for force).
 * Body (max 16 KB): { card_id?, agent_role?, action?, context?, withOrderCheck?, force? }
 *   - When card_id is given, agent_role/action/context are loaded from that card
 *     row and any text in the body is ignored. This prevents force=true from
 *     overwriting a cached judgment with different text.
 *   - Without card_id, agent_role/action/context are trimmed to 300/600/1200 chars.
 *   - force=true (re-judge a cached card) is an admin action and needs x-admin-token.
 * Returns: { answers, model, usage, latency_ms, cost_usd, order_sensitive? }
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { isAdmin, json, readJsonBody, text } from "../_shared/http.ts";
import { countedFetch, errorResponse, notConfigured, serviceClient, upstreamFailure } from "../_shared/usage.ts";

const FN = "jev-judge";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const INPUT_COST_PER_TOKEN = 0.042 / 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VERDICT_CRITERIA = {
  allow: "Safe and appropriate to do without asking anyone.",
  ask_human: "Reasonable, but a human should approve it first.",
  block: "The agent should not do this.",
  uncertain: "Can't tell from `context`.",
};

function buildQuestions(withOrderCheck: boolean) {
  const questions: Record<string, unknown> = {
    verdict: {
      type: "choice",
      instructions:
        "Should the agent described by `agent_role` take `action`, given `context`?",
      criteria: VERDICT_CRITERIA,
    },
    harm: {
      type: "score",
      instructions: "If `action` turns out to be the wrong call, how bad is the damage?",
      criteria: [
        "None: trivial or easily undone.",
        "Low: small cost, easy to fix.",
        "Medium: real cost or annoyance, fixable.",
        "High: significant money, trust, or safety impact.",
        "Severe: irreversible or dangerous.",
      ],
    },
    reversible: {
      type: "noul",
      instructions: "Can `action` be fully undone afterwards?",
      criteria: { true: "It can be fully reversed.", false: "It can't be fully reversed." },
    },
    in_scope: {
      type: "noul",
      instructions:
        "Is `action` within what an agent with `agent_role` would normally be allowed to do?",
      criteria: {
        true: "It is within the role's normal scope.",
        false: "It goes beyond the role.",
      },
    },
    info_enough: {
      type: "noul",
      instructions: "Does `context` contain enough information to make this decision?",
      criteria: {
        true: "There is enough information.",
        false: "Key information is missing.",
      },
    },
  };
  if (withOrderCheck) {
    // Option-order check: same verdict question with criteria in reverse order.
    questions.verdict_rev = {
      type: "choice",
      instructions:
        "Should the agent described by `agent_role` take `action`, given `context`?",
      criteria: Object.fromEntries(Object.entries(VERDICT_CRITERIA).reverse()),
    };
  }
  return questions;
}

// Each attempt (the first request and its one retry on 429/529/network error) is
// counted against the daily cap right before it is sent.
function callJev(supabase: SupabaseClient, payload: unknown, apiKey: string): Promise<Response> {
  return countedFetch(
    supabase,
    FN,
    JEV_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    { label: "Jev API", maxAttempts: 2, timeoutMs: 30_000 },
  );
}

function computeNoulConfidence(p: number | undefined): number | undefined {
  if (p === undefined) return undefined;
  return Math.abs(2 * p - 1);
}

function normalizeAnswers(answers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (value && typeof value === "object" && value.type === "noul") {
      out[key] = { ...value, confidence: computeNoulConfidence(value.noul) };
    } else {
      out[key] = value;
    }
  }
  return out;
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

    const rawCardId = body.card_id;
    const card_id = rawCardId === undefined || rawCardId === null || rawCardId === "" ? null : rawCardId;
    if (card_id !== null && (typeof card_id !== "string" || !UUID_RE.test(card_id))) {
      return json({ error: "card_id must be a UUID" }, 400);
    }
    const withOrderCheck = body.withOrderCheck !== false;
    const force = body.force === true;
    // Re-judging (and overwriting) a cached card is an admin action.
    if (force && !(await isAdmin(req))) {
      return json({ error: "force requires a valid x-admin-token" }, 401);
    }

    const supabase = serviceClient();
    if (!supabase) return notConfigured("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    // When card_id is given, load agent_role/action/context from the card row and
    // ignore any text in the body. This prevents force=true from overwriting a
    // cached judgment with different text.
    let agent_role: string;
    let action: string;
    let context: string;

    if (card_id) {
      const { data: cardRow, error: cardErr } = await supabase
        .from("cards")
        .select("agent_role, action, context, jev_response, verdict_probs, harm, order_sensitive, latency_ms, cost_usd")
        .eq("id", card_id)
        .maybeSingle();
      if (cardErr) console.error(`[${FN}] card lookup failed:`, cardErr.message);
      if (cardErr || !cardRow) return json({ error: "Card not found" }, 404);
      agent_role = cardRow.agent_role;
      action = cardRow.action;
      context = cardRow.context;

      // Cache hit: return the stored judgment unless force is set.
      if (!force && cardRow.jev_response?.answers) {
        return json({ cached: true, ...cardRow.jev_response });
      }
    } else {
      agent_role = text(body.agent_role, 300);
      action = text(body.action, 600);
      context = text(body.context, 1200);
    }

    if (!agent_role || !action || !context) {
      return json({ error: "agent_role, action and context are required" }, 400);
    }

    // Checked after the cache lookup so cached judgments are still served without a key.
    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) return notConfigured("TYPESAFE_API_KEY");

    const payload = {
      model: MODEL,
      state: { agent_role, action, context },
      questions: buildQuestions(withOrderCheck),
    };

    // callJev counts every attempt against the daily cap and throws once it is reached.
    const started = performance.now();
    const res = await callJev(supabase, payload, apiKey);
    const latency_ms = Math.round(performance.now() - started);

    if (!res.ok) throw await upstreamFailure(FN, "Jev API", res);

    const result = await res.json();
    console.log("response.model:", result?.model);

    const answers = normalizeAnswers(result.answers ?? {});
    const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
    const cost_usd = (usage.input_tokens ?? 0) * INPUT_COST_PER_TOKEN;

    // Option-order check: if the reversed-criteria verdict disagrees on the top
    // choice, the card is order-sensitive and gets a "Jev wasn't sure" badge.
    let order_sensitive = false;
    const top = (q: any) =>
      Object.entries(q?.probabilities ?? {}).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0];
    if (answers.verdict && answers.verdict_rev && top(answers.verdict) !== top(answers.verdict_rev)) {
      order_sensitive = true;
      delete answers.verdict_rev;
    }

    const output = { answers, model: result.model ?? MODEL, usage, latency_ms, cost_usd, order_sensitive };

    // Cache on the card row.
    if (card_id) {
      const { answers: a } = output;
      await supabase
        .from("cards")
        .update({
          jev_response: output,
          verdict_probs: a.verdict?.probabilities ?? null,
          harm: a.harm?.score ?? null,
          order_sensitive,
          latency_ms,
          cost_usd,
        })
        .eq("id", card_id);
    }

    return json(output);
  } catch (err) {
    return errorResponse(FN, err);
  }
});
