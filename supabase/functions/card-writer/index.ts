/**
 * card-writer — the only place an LLM is used. Two modes:
 *  - generate: N new cards for a theme, JSON {agent_role, action, context, theme}
 *  - commentary: 2 sentences on the tradeoff, citing ONLY the supplied numbers
 *
 * Secrets: OPENAI_API_KEY, optional OPENAI_BASE_URL (default https://api.openai.com/v1),
 * optional OPENAI_MODEL (default gpt-6-luna), optional DAILY_CALL_LIMIT (default 200
 * LLM requests/day). These come only from env, never from the request. No
 * `temperature` parameter is sent — the model rejects it.
 *
 * Body (max 16 KB). generate: theme must be one of THEMES (or omitted), count is
 * clamped to 1..10. commentary: action/context are trimmed to 600/1200 chars,
 * verdict_probs/crowd keep at most 10 numeric entries with keys up to 40 chars, and
 * harm is passed on as a short string.
 *
 * If there is no key or mode is "mock", the bundled deck and templated commentary
 * are used instead. Jev still runs live in mock mode.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { json, readJsonBody, text } from "../_shared/http.ts";
import {
  countedFetch,
  errorResponse,
  notConfigured,
  serviceClient,
  upstreamFailure,
  UpstreamError,
} from "../_shared/usage.ts";

const FN = "card-writer";

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

interface CommentaryInput {
  action: string;
  context: string;
  verdict_probs: Record<string, number>;
  harm: string | null;
  crowd: Record<string, number>;
}

/** At most 10 finite numeric entries with 1-40 char keys; anything else is dropped. */
function numericMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .filter(([k, v]) => k.length > 0 && k.length <= 40 && typeof v === "number" && Number.isFinite(v))
    .slice(0, 10);
  return Object.fromEntries(entries) as Record<string, number>;
}

function shortHarm(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, 16);
  if (typeof value === "string") return value.trim().slice(0, 16) || null;
  return null;
}

function mockCommentary(input: CommentaryInput): string {
  const probs = input.verdict_probs;
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  const crowdTop = Object.entries(input.crowd).sort((a, b) => b[1] - a[1])[0];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (!top) return "The tradeoff here is between moving fast and keeping a human in the loop.";
  if (crowdTop && crowdTop[0] !== top[0]) {
    return `Jev puts ${Math.round(top[1] * 100)}% on ${top[0]}, but the crowd leans ${crowdTop[0]} at ${pct(crowdTop[1])}. When they disagree, the interesting question is whether the crowd sees context Jev is missing.`;
  }
  return `Both Jev (${pct(top[1])} on ${top[0]}) and the crowd${crowdTop ? ` (${pct(crowdTop[1])} on ${crowdTop[0]})` : ""} land in the same place. That agreement is a signal the call is not a close one.`;
}

// One LLM request per invocation, counted against the daily cap right before it is
// sent. There is no retry, and the JSON parse fallback in extractJson is local only.
async function callLLM(
  supabase: SupabaseClient,
  apiKey: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
  const res = await countedFetch(
    supabase,
    FN,
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
    },
    { label: "LLM request", maxAttempts: 1, timeoutMs: 120_000 },
  );
  if (!res.ok) throw await upstreamFailure(FN, "LLM request", res);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new UpstreamError("LLM output had no JSON");
  const slice = raw.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    // try trimming to the last closing bracket
    const last = Math.max(slice.lastIndexOf("]"), slice.lastIndexOf("}"));
    try {
      return JSON.parse(slice.slice(0, last + 1));
    } catch {
      throw new UpstreamError("LLM output was not valid JSON");
    }
  }
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
    const mode: "generate" | "commentary" = body.mode === "commentary" ? "commentary" : "generate";
    const useMock = body.mock === true;
    const apiKey = Deno.env.get("OPENAI_API_KEY");

    // Validate and bound everything before any prompt is built (mock or LLM).
    let theme: string | undefined;
    let count = 5;
    if (mode === "generate") {
      if (body.theme !== undefined && body.theme !== null && body.theme !== "") {
        if (typeof body.theme !== "string" || !THEMES.includes(body.theme)) {
          return json({ error: `theme must be one of: ${THEMES.join(", ")}` }, 400);
        }
        theme = body.theme;
      }
      const n = Number(body.count ?? 5);
      count = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 10) : 5;
    }
    const commentaryInput: CommentaryInput = {
      action: text(body.action, 600),
      context: text(body.context, 1200),
      verdict_probs: numericMap(body.verdict_probs),
      harm: shortHarm(body.harm),
      crowd: numericMap(body.crowd),
    };

    if (useMock || !apiKey) {
      if (mode === "generate") {
        const rnd = mulberry32(Date.now() % 2147483647);
        return json({ cards: mockGenerate(theme, count, rnd), source: "mock" });
      }
      return json({ commentary: mockCommentary(commentaryInput), source: "mock" });
    }

    const supabase = serviceClient();
    if (!supabase) return notConfigured("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

    if (mode === "generate") {
      const output = await callLLM(supabase, apiKey, [
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
      const cards = extractJson(output);
      if (!Array.isArray(cards)) throw new UpstreamError("LLM output was not a JSON array of cards");
      const valid = cards
        .filter(
          (c: any) =>
            c && typeof c.agent_role === "string" && typeof c.action === "string" && typeof c.context === "string"
        )
        .slice(0, count)
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
      if (insertErr) throw new Error(`card insert failed: ${insertErr.message}`);
      return json({ cards: saved ?? [], source: "llm" });
    }

    // commentary mode — the LLM may cite only the numbers we hand it.
    const output = await callLLM(supabase, apiKey, [
      {
        role: "system",
        content:
          "You write 2-sentence commentary for a game about AI-agent judgment. You may ONLY cite the numbers given to you. Never claim to know how the model reasoned or mention any reasoning process. No more than 2 sentences.",
      },
      {
        role: "user",
        content: JSON.stringify({
          action: commentaryInput.action,
          context: commentaryInput.context,
          jev_verdict_probabilities: commentaryInput.verdict_probs,
          jev_harm: commentaryInput.harm,
          crowd_split: commentaryInput.crowd,
          instruction:
            "Write the 2-sentence commentary on the tradeoff. Cite only the numbers above.",
        }),
      },
    ]);
    return json({ commentary: output.trim().slice(0, 600), source: "llm" });
  } catch (err) {
    return errorResponse(FN, err);
  }
});
