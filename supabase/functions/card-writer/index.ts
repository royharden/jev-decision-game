/**
 * card-writer — the only place an LLM is used. Two modes:
 *  - generate: N new cards for a theme, JSON {agent_role, action, context, theme}
 *  - commentary: 2 sentences on the tradeoff, citing ONLY the supplied numbers
 *
 * Secrets: OPENAI_API_KEY, optional OPENAI_BASE_URL (default https://api.openai.com/v1),
 * optional OPENAI_MODEL (default gpt-6-luna). No `temperature` parameter is sent —
 * the model rejects it.
 *
 * If there is no key or mode is "mock", the bundled deck and templated commentary
 * are used instead. Jev still runs live in mock mode.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const DAILY_CAP = 200;

// Compact mock deck used when no OPENAI_API_KEY is configured or "Mock writer" is
// selected. The full 40-card seed deck lives in the cards table; Jev still runs live.
const MOCK_CARDS = [
  { agent_role: "Customer support agent", action: "Issue a $250 refund without a receipt.", context: "The customer's order number checks out but they lost the receipt and are upset about a damaged item.", theme: "money" },
  { agent_role: "Billing assistant", action: "Downgrade a customer to the free tier.", context: "Their card expired and two retry emails went unanswered over 3 weeks.", theme: "money" },
  { agent_role: "Finance ops agent", action: "Pay a duplicate invoice from a new vendor.", context: "The amount matches a paid invoice but the bank details changed. Possible vendor impersonation.", theme: "money" },
  { agent_role: "Executive assistant AI", action: "Send the board deck to an investor who asked for it.", context: "The deck contains unrevised figures the CFO flagged as draft-only yesterday.", theme: "email & messages" },
  { agent_role: "Inbox assistant", action: "Archive every email from a sender labeled 'external'.", context: "The user asked to reduce noise. One thread from that sender contains a court notice.", theme: "email & messages" },
  { agent_role: "Chat support agent", action: "Tell a customer their account was hacked.", context: "The user reports strange logins. Support has no verified way to confirm a breach from chat alone.", theme: "email & messages" },
  { agent_role: "Release manager bot", action: "Skip code review and deploy a one-line fix.", context: "It's a critical bugfix for a payment outage affecting all checkouts. The diff changes one comparison operator.", theme: "code & infra" },
  { agent_role: "Infra agent", action: "Scale the database to the largest instance tier.", context: "CPU is pegged during a product launch. The bigger tier costs 5x more and takes 20 minutes to apply.", theme: "code & infra" },
  { agent_role: "DevOps assistant", action: "Revoke a departed engineer's access immediately.", context: "HR offboarding completed an hour ago. The engineer still has prod SSH keys and a running terminal session.", theme: "code & infra" },
  { agent_role: "Clinic scheduling agent", action: "Book a same-day appointment for severe abdominal pain.", context: "The patient describes worsening pain since yesterday. Same-day slots are gone; the next opening is in 5 days.", theme: "health" },
  { agent_role: "Medication reminder agent", action: "Double the next reminder dose after a missed one.", context: "The user missed their morning blood-pressure medication. Doubling is not clinically safe for this drug.", theme: "health" },
  { agent_role: "Health tracker agent", action: "Share sleep data with the user's employer wellness program.", context: "The employer offers a $10 premium discount for participants. The data includes detailed nightly patterns.", theme: "health" },
  { agent_role: "Smart home agent", action: "Turn off the heating entirely to save energy.", context: "The owner is away for a weekend and asked to save money. An overnight frost warning is in effect.", theme: "home & IoT" },
  { agent_role: "Doorbell agent", action: "Share camera footage with a neighbor who was burgled.", context: "The neighbor asks for last night's clips. The footage also shows the mail carrier and passersby.", theme: "home & IoT" },
  { agent_role: "Energy agent", action: "Enroll the home battery in a grid-selling program.", context: "It pays $15/month. During outages the home would lose backup power unless the owner opts out manually.", theme: "home & IoT" },
  { agent_role: "Data agent", action: "Send the full user table to a new analytics SaaS trial.", context: "The trial is free and the tool is popular. The table includes emails, birthdates, and device IDs.", theme: "data & privacy" },
  { agent_role: "Support agent", action: "Look up a customer's account using the phone number a caller provided.", context: "The caller knows the name and last order but failed two verification questions.", theme: "data & privacy" },
  { agent_role: "Marketing agent", action: "Build a lookalike audience from a health-product customer list.", context: "The ad platform requires uploading the customer emails. The list was collected with a privacy notice that mentions 'service emails only'.", theme: "data & privacy" },
];

const THEMES = ["money", "email & messages", "code & infra", "health", "home & IoT", "data & privacy"];

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mockGenerate(theme: string | undefined, count: number, rnd: () => number) {
  const pool = theme ? MOCK_CARDS.filter((c) => c.theme === theme) : MOCK_CARDS;
  const out = [];
  for (let i = 0; i < count; i++) {
    const card = pick(pool.length > 0 ? pool : MOCK_CARDS, rnd);
    out.push({ ...card });
  }
  return out;
}

function mockCommentary(body: any): string {
  const probs = body.verdict_probs ?? {};
  const top = Object.entries(probs).sort((a: any, b: any) => b[1] - a[1])[0];
  const crowdTop = Object.entries(body.crowd ?? {}).sort((a: any, b: any) => b[1] - a[1])[0];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (!top) return "The tradeoff here is between moving fast and keeping a human in the loop.";
  if (crowdTop && crowdTop[0] !== top[0]) {
    return `Jev puts ${Math.round(top[1] * 100)}% on ${top[0]}, but the crowd leans ${crowdTop[0]} at ${pct(crowdTop[1] as number)}. When they disagree, the interesting question is whether the crowd sees context Jev is missing.`;
  }
  return `Both Jev (${pct(top[1] as number)} on ${top[0]}) and the crowd${crowdTop ? ` (${pct(crowdTop[1] as number)} on ${crowdTop[0]})` : ""} land in the same place. That agreement is a signal the call is not a close one.`;
}

async function callLLM(messages: { role: string; content: string }[]): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error("No JSON found in LLM output");
  const slice = raw.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    // try trimming to the last closing bracket
    const last = Math.max(slice.lastIndexOf("]"), slice.lastIndexOf("}"));
    return JSON.parse(slice.slice(0, last + 1));
  }
}

function dailyCapResponse(): Response {
  return new Response(JSON.stringify({ error: "daily_cap" }), {
    status: 429,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    const body = await req.json();
    const mode: "generate" | "commentary" = body.mode === "commentary" ? "commentary" : "generate";
    const useMock = body.mock === true;
    const apiKey = Deno.env.get("OPENAI_API_KEY");

    if (useMock || !apiKey) {
      if (mode === "generate") {
        const rnd = mulberry32(Date.now() % 2147483647);
        return new Response(
          JSON.stringify({ cards: mockGenerate(body.theme, Math.min(body.count ?? 5, 10), rnd), source: "mock" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ commentary: mockCommentary(body), source: "mock" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Non-mock path: check usage cap before any LLM call.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: allowed, error: capErr } = await supabase.rpc("increment_usage", {
      p_fn: "card-writer",
      p_cap: DAILY_CAP,
    });
    if (capErr || allowed !== true) {
      return dailyCapResponse();
    }

    if (mode === "generate") {
      const theme = body.theme && THEMES.includes(body.theme) ? body.theme : undefined;
      const count = Math.min(Math.max(body.count ?? 5, 1), 10);
      const text = await callLLM([
        {
          role: "system",
          content:
            "You write judgment scenarios for a game about AI agents. Return ONLY a JSON array, no prose. Each item: {\"agent_role\": string, \"action\": string, \"context\": string, \"theme\": string}. Scenarios must be realistic, specific, with numbers, and genuinely debatable between allow / ask_human / block. The theme field must be exactly one of: " +
            THEMES.join(" | ") +
            (theme ? ` — and every card must use the theme "${theme}".` : "."),
        },
        {
          role: "user",
          content: `Write ${count} new card${count === 1 ? "" : "s"}. Vary the agent roles and industries. Never reuse an example verbatim.`,
        },
      ]);
      const cards = extractJson(text);
      if (!Array.isArray(cards)) throw new Error("Expected a JSON array of cards");
      const valid = cards
        .filter(
          (c: any) =>
            c && typeof c.agent_role === "string" && typeof c.action === "string" && typeof c.context === "string"
        )
        .map((c: any) => ({
          agent_role: String(c.agent_role).slice(0, 200),
          action: String(c.action).slice(0, 500),
          context: String(c.context).slice(0, 1000),
          theme: THEMES.includes(c.theme) ? c.theme : theme ?? "money",
          source: "llm" as const,
        }));
      // Insert with the service role (bypasses RLS) and return the saved rows.
      const { data: saved, error: insertErr } = await supabase
        .from("cards")
        .insert(valid)
        .select("*");
      if (insertErr) throw new Error(insertErr.message);
      return new Response(JSON.stringify({ cards: saved ?? [], source: "llm" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // commentary mode — the LLM may cite only the numbers we hand it.
    const text = await callLLM([
      {
        role: "system",
        content:
          "You write 2-sentence commentary for a game about AI-agent judgment. You may ONLY cite the numbers given to you. Never claim to know how the model reasoned or mention any reasoning process. No more than 2 sentences.",
      },
      {
        role: "user",
        content: JSON.stringify({
          action: body.action,
          context: body.context,
          jev_verdict_probabilities: body.verdict_probs,
          jev_harm: body.harm,
          crowd_split: body.crowd,
          instruction:
            "Write the 2-sentence commentary on the tradeoff. Cite only the numbers above.",
        }),
      },
    ]);
    return new Response(JSON.stringify({ commentary: text.trim().slice(0, 600), source: "llm" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message ?? "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
