/**
 * jev-judge — the judge. Calls the TypeSafe SystemOne API (model jev-1.13.0, pinned)
 * once per card with every question batched into a single request, then caches the
 * result on the card row so Jev is called once per card, not once per player.
 *
 * Secrets (server-side only): TYPESAFE_API_KEY
 * Body: { card_id?, agent_role, action, context, withOrderCheck?, force? }
 * Returns: { answers, model, usage, latency_ms, cost_usd, order_sensitive? }
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MODEL = "jev-1.13.0";
const INPUT_COST_PER_TOKEN = 0.042 / 1_000_000;

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

async function callJev(payload: unknown, apiKey: string, attempt = 0): Promise<Response> {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if ((res.status === 429 || res.status === 529) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt + 1)));
    return callJev(payload, apiKey, attempt + 1);
  }
  return res;
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
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST required" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "TYPESAFE_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { card_id, agent_role, action, context, withOrderCheck = true, force = false } = body;
    if (!agent_role || !action || !context) {
      return new Response(
        JSON.stringify({ error: "agent_role, action and context are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Cache hit: return the stored judgment unless force is set.
    if (card_id && !force) {
      const { data: card } = await supabase
        .from("cards")
        .select("jev_response, verdict_probs, harm, order_sensitive, latency_ms, cost_usd")
        .eq("id", card_id)
        .maybeSingle();
      if (card?.jev_response?.answers) {
        return new Response(JSON.stringify({ cached: true, ...card.jev_response }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const payload = {
      model: MODEL,
      state: { agent_role, action, context },
      questions: buildQuestions(withOrderCheck),
    };

    const started = performance.now();
    const res = await callJev(payload, apiKey);
    const latency_ms = Math.round(performance.now() - started);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Jev API failed (${res.status})`, detail: detail.slice(0, 500) }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
      const { answers: a, ...meta } = output;
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

    return new Response(JSON.stringify(output), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message ?? "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
