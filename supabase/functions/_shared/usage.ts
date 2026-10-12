import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { json } from "./http.ts";

const DEFAULT_DAILY_CAP = 200;
const RETRY_STATUSES = new Set([429, 529]);

/**
 * Service-role client built only from env. Returns null when SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY is missing; callers answer 503 instead of building a
 * client from an empty string.
 */
export function serviceClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function notConfigured(what: string): Response {
  return json({ error: `${what} not configured` }, 503);
}

/** Per-function daily cap: 200, unless the DAILY_CALL_LIMIT secret holds a non-negative integer. */
export function dailyCallLimit(): number {
  const raw = Deno.env.get("DAILY_CALL_LIMIT")?.trim();
  return raw && /^\d{1,9}$/.test(raw) ? Number(raw) : DEFAULT_DAILY_CAP;
}

/** The daily cap was hit (429) or the counter couldn't be checked (503). Never retried. */
export class DailyLimitError extends Error {
  constructor(readonly status: 429 | 503) {
    super(status === 429 ? "daily_limit" : "usage_check_unavailable");
  }
}

/** An upstream call failed. The message is generic; the raw upstream detail is only logged. */
export class UpstreamError extends Error {}

/**
 * Counts one upstream call for `fn` against today's cap. Fails closed: an RPC error
 * throws a 503 and any result other than `true` (increment_usage returns NULL once
 * the cap is reached) throws a 429, so the caller never reaches its fetch.
 */
export async function consumeDailyCall(supabase: SupabaseClient, fn: string): Promise<void> {
  const cap = dailyCallLimit();
  if (cap < 1) throw new DailyLimitError(429);
  let result: { data: unknown; error: { message: string } | null };
  try {
    result = await supabase.rpc("increment_usage", { p_fn: fn, p_cap: cap });
  } catch (err) {
    console.error(`[${fn}] increment_usage threw:`, err);
    throw new DailyLimitError(503);
  }
  if (result.error) {
    console.error(`[${fn}] increment_usage failed:`, result.error.message);
    throw new DailyLimitError(503);
  }
  if (result.data !== true) throw new DailyLimitError(429);
}

export interface CountedFetchOptions {
  /** Shown to the client in generic error messages, e.g. "Jev API". */
  label: string;
  /** Total attempts including the first. Retries only on 429/529 or a network error. */
  maxAttempts: number;
  timeoutMs: number;
}

/**
 * Every paid upstream fetch goes through here. increment_usage runs right before each
 * attempt, retries included, so the cap counts real upstream requests. A
 * DailyLimitError from the counter propagates at once: nothing is retried after it.
 */
export async function countedFetch(
  supabase: SupabaseClient,
  fn: string,
  url: string,
  init: RequestInit,
  { label, maxAttempts, timeoutMs }: CountedFetchOptions,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    await consumeDailyCall(supabase, fn);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // fetch rejects with a TypeError on network failures; timeouts are not retried.
      if (err instanceof TypeError && attempt < maxAttempts) {
        await backoff(attempt);
        continue;
      }
      console.error(`[${fn}] ${label} fetch failed:`, err);
      throw new UpstreamError(`${label} unreachable`);
    }
    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      await res.body?.cancel().catch(() => {});
      await backoff(attempt);
      continue;
    }
    return res;
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
}

/** Logs a non-OK upstream response server side and returns an error with a generic message. */
export async function upstreamFailure(fn: string, label: string, res: Response): Promise<UpstreamError> {
  const detail = await res.text().catch(() => "");
  console.error(`[${fn}] ${label} failed (${res.status}):`, detail.slice(0, 2000));
  return new UpstreamError(`${label} failed (${res.status})`);
}

/** Maps anything thrown inside a handler to a response that never echoes raw error text. */
export function errorResponse(fn: string, err: unknown): Response {
  if (err instanceof DailyLimitError) return json({ error: err.message }, err.status);
  if (err instanceof UpstreamError) return json({ error: err.message }, 502);
  console.error(`[${fn}] unhandled error:`, err);
  return json({ error: "Internal error" }, 500);
}
