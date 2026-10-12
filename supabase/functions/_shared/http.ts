import { corsHeaders } from "./cors.ts";

/** Hard cap on request bodies for every function. Larger bodies get 413. */
export const MAX_BODY_BYTES = 16 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export type JsonBody = Record<string, unknown>;

/**
 * Reads the request body with a hard byte cap (checked against Content-Length and
 * again while streaming, so a missing or lying header can't bypass it). Returns the
 * parsed JSON object, or a ready-made 413/400 response.
 */
export async function readJsonBody(req: Request): Promise<{ body: JsonBody } | { error: Response }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { error: json({ error: "payload_too_large" }, 413) };
  }
  if (!req.body) return { error: json({ error: "JSON body required" }, 400) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { error: json({ error: "payload_too_large" }, 413) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: json({ error: "Invalid JSON body" }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: json({ error: "JSON object body required" }, 400) };
  }
  return { body: parsed as JsonBody };
}

/** A trimmed string capped at `max` characters; anything that isn't a string becomes "". */
export function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Admin actions require the ADMIN_TOKEN secret in the x-admin-token header.
 * Unset (or too-short) ADMIN_TOKEN means admin actions are disabled entirely.
 */
export async function isAdmin(req: Request): Promise<boolean> {
  const expected = Deno.env.get("ADMIN_TOKEN");
  const given = req.headers.get("x-admin-token");
  if (!expected || expected.length < 16 || !given) return false;
  // Compare SHA-256 digests in constant time so length and content don't leak via timing.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
    crypto.subtle.digest("SHA-256", enc.encode(given)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
