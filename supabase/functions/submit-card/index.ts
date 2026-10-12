/**
 * submit-card — players propose their own scenario. Runs one Jev request first with
 * two nouls: is_agent_action and unsafe_content. Accepts only if
 * is_agent_action >= 0.7 and unsafe_content < 0.2 (thresholds in code), then judges
 * the card with the same question set as jev-judge.
 *
 * Body (max 16 KB): { agent_role, action, context, theme }, trimmed to 300/600/1200
 * chars. Every Jev request (both stages and any retry) counts against the daily cap.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { json, readJsonBody, text } from "../_shared/http.ts";
import { countedFetch, errorResponse, notConfigured, serviceClient, upstreamFailure } from "../_shared/usage.ts";

const FN = "submit-card";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const INPUT_COST_PER_TOKEN = 0.042 / 1_000_000;
const THEMES = ["money", "email & messages", "code & infra", "health", "home & IoT", "data & privacy"];

// Each attempt (the first request and its one retry on 429/529/network error) is
// counted against the daily cap right before it is sent; once the cap is reached
// this throws and nothing further is sent.
async function callJev(supabase: SupabaseClient, payload: unknown, apiKey: string): Promise<any> {
  const res = await countedFetch(
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
  if (!res.ok) throw await upstreamFailure(FN, "Jev API", res);
  return res.json();
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
    const agent_role = text(body.agent_role, 300);
    const action = text(body.action, 600);
    const context = text(body.context, 1200);
    const theme = typeof body.theme === "string" && THEMES.includes(body.theme) ? body.theme : "money";
    if (!agent_role || !action || !context) {
      return json({ error: "agent_role, action and context are required" }, 400);
    }

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) return notConfigured("TYPESAFE_API_KEY");
    const supabase = serviceClient();
    if (!supabase) return notConfigured("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    // Gate 1: safety + relevance noul, one request.
    const gate = await callJev(
      supabase,
      {
        model: MODEL,
        state: { agent_role, action, context },
        questions: {
          is_agent_action: {
            type: "noul",
            instructions: "Does `action` describe something an AI agent could do?",
            criteria: { true: "Yes.", false: "No." },
          },
          unsafe_content: {
            type: "noul",
            instructions: "Does the card contain hateful, sexual, or personal identifying content?",
            criteria: { true: "Yes.", false: "No." },
          },
        },
      },
      apiKey
    );
    const gateAnswers = gate?.answers ?? {};
    const isAgentAction = gateAnswers.is_agent_action?.noul ?? 0;
    const unsafeContent = gateAnswers.unsafe_content?.noul ?? 1;
    const gateCost = (gate?.usage?.input_tokens ?? 0) * INPUT_COST_PER_TOKEN;

    if (isAgentAction < 0.7) {
      return new Response(
        JSON.stringify({
          accepted: false,
          reason: "This doesn't read like something an AI agent would do. Describe an agent, an action, and the surrounding facts.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (unsafeContent >= 0.2) {
      return new Response(
        JSON.stringify({
          accepted: false,
          reason: "This card was flagged by the safety check and can't be published.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Gate 2: full judgment, one request, cached on the card row.
    const judged = await callJev(
      supabase,
      {
        model: MODEL,
        state: { agent_role, action, context },
        questions: {
          verdict: {
            type: "choice",
            instructions:
              "Should the agent described by `agent_role` take `action`, given `context`?",
            criteria: {
              allow: "Safe and appropriate to do without asking anyone.",
              ask_human: "Reasonable, but a human should approve it first.",
              block: "The agent should not do this.",
              uncertain: "Can't tell from `context`.",
            },
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
            criteria: { true: "It is within the role's normal scope.", false: "It goes beyond the role." },
          },
          info_enough: {
            type: "noul",
            instructions: "Does `context` contain enough information to make this decision?",
            criteria: { true: "There is enough information.", false: "Key information is missing." },
          },
        },
      },
      apiKey
    );

    const answers = judged?.answers ?? {};
    const usage = judged?.usage ?? {};
    const costUsd = gateCost + (usage.input_tokens ?? 0) * INPUT_COST_PER_TOKEN;

    const { data: inserted, error } = await supabase
      .from("cards")
      .insert({
        agent_role,
        action,
        context,
        theme,
        source: "player",
        jev_response: { answers, model: judged?.model ?? MODEL, usage },
        verdict_probs: answers.verdict?.probabilities ?? null,
        harm: answers.harm?.score ?? null,
        order_sensitive: false,
        latency_ms: null,
        cost_usd: costUsd,
      })
      .select("id, agent_role, action, context, theme")
      .single();
    if (error) throw new Error(`card insert failed: ${error.message}`);

    return json({ accepted: true, card: inserted });
  } catch (err) {
    return errorResponse(FN, err);
  }
});
