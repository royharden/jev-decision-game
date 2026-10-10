/*
# Add usage_counters table and increment_usage function; tighten RLS on cards and daily_decks

1. New Tables
- `usage_counters` — per-day, per-function call counter for rate limiting.
  - `day` (date, part of composite PK)
  - `fn` (text, part of composite PK)
  - `calls` (int, NOT NULL, default 0)
2. New Functions
- `increment_usage(p_fn text, p_cap int)` — atomic upsert that increments the
  daily call counter for `p_fn` only if it hasn't reached `p_cap`. Returns
  true if the call is allowed (under cap), false (no row) if capped.
  SECURITY INVOKER, search_path=public. EXECUTE granted only to service_role.
3. Security Changes
- Enable RLS on usage_counters with NO policies (locked to all but service_role).
- REVOKE ALL on usage_counters from anon and authenticated.
- REVOKE EXECUTE on increment_usage from PUBLIC, anon, authenticated.
- GRANT EXECUTE on increment_usage to service_role.
- DROP POLICY anon_insert_cards ON cards — player cards now come exclusively
  through the submit-card edge function (service role), so anon INSERT is
  no longer needed on the client.
- DROP POLICY anon_update_daily_decks ON daily_decks — the client should only
  insert-if-missing, never update an existing deck.
4. Notes
- The increment_usage function is called by edge functions right before each
  external API call (Jev or LLM). If it returns false (or errors), the
  function returns 429 to the client.
*/

CREATE TABLE IF NOT EXISTS usage_counters (
  day date NOT NULL,
  fn text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fn)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

-- No policies on usage_counters: only the service role (which bypasses RLS)
-- can read or write it.
REVOKE ALL ON usage_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION increment_usage(p_fn text, p_cap int)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO usage_counters (day, fn, calls)
  VALUES ((now() at time zone 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn)
  DO UPDATE SET calls = usage_counters.calls + 1
  WHERE usage_counters.calls < p_cap
  RETURNING true;
$$;

REVOKE EXECUTE ON FUNCTION increment_usage(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage(text, int) TO service_role;

-- Player cards now arrive only through the submit-card edge function (service role).
DROP POLICY IF EXISTS "anon_insert_cards" ON cards;

-- The client should only insert-if-missing, never mutate an existing daily deck.
DROP POLICY IF EXISTS "anon_update_daily_decks" ON daily_decks;