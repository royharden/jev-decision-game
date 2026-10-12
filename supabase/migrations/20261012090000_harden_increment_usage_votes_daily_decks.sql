/*
# Harden increment_usage, bound anon writes to votes and daily_decks

1. Functions
- `increment_usage(p_fn text, p_cap int)` is recreated as SECURITY DEFINER (it was
  SECURITY INVOKER) with `SET search_path = public` and a schema-qualified table.
  Same atomic upsert and return type: INSERT ... ON CONFLICT (day, fn) DO UPDATE ...
  WHERE calls < p_cap RETURNING true, so it returns true while under the cap and
  NULL once the cap is reached. The edge functions pass the cap (200/day per
  function, overridable with the DAILY_CALL_LIMIT secret) and call it right before
  every upstream request, retries included.
- EXECUTE is revoked again from PUBLIC, anon and authenticated and granted only to
  service_role.
2. usage_counters
- Re-asserts RLS on, no policies, and REVOKE ALL from anon and authenticated.
3. votes
- The anon INSERT policy was WITH CHECK (true). It now requires an existing card, a
  pick in (allow, ask_human, block), confidence 0.5-1, points -100..120 (the full
  range the client's Brier scoring can produce, +20 contrarian bonus), a known mode,
  short player_id/nickname strings and a server-side created_at.
- The same column bounds are added as CHECK constraints so they hold for every
  writer. NOT VALID: existing rows are not re-checked, new rows are.
4. daily_decks
- The anon INSERT policy was WITH CHECK (true). It now allows only a row for today
  (UTC, +/- 1 day for clock skew) holding 1-10 distinct, non-null ids of existing
  cards. `day` is the primary key, so there is still at most one row per day.
5. Cleanup
- Drops the deny-only (USING false) UPDATE/DELETE policies; with RLS on, having no
  policy already denies. Revokes write privileges anon/authenticated don't need:
  everything but SELECT on cards (cards are written by edge functions with the
  service role), and UPDATE/DELETE/TRUNCATE on votes and daily_decks. anon keeps
  SELECT on all three tables and INSERT on votes and daily_decks, which the UI needs.
*/

-- 1. increment_usage: SECURITY DEFINER, same atomic logic and return type.
CREATE OR REPLACE FUNCTION public.increment_usage(p_fn text, p_cap int)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.usage_counters AS uc (day, fn, calls)
  VALUES ((now() at time zone 'utc')::date, p_fn, 1)
  ON CONFLICT (day, fn)
  DO UPDATE SET calls = uc.calls + 1
  WHERE uc.calls < p_cap
  RETURNING true;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_usage(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(text, int) TO service_role;

-- 2. usage_counters stays locked to the service role.
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.usage_counters FROM anon, authenticated;
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'usage_counters'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.usage_counters', pol.policyname);
  END LOOP;
END $$;

-- 3. votes: bounded columns for every writer, bounded anon inserts.
ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_pick_check;
ALTER TABLE public.votes ADD CONSTRAINT votes_pick_check
  CHECK (pick IN ('allow', 'ask_human', 'block')) NOT VALID;

ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_confidence_check;
ALTER TABLE public.votes ADD CONSTRAINT votes_confidence_check
  CHECK (confidence >= 0.5 AND confidence <= 1) NOT VALID;

ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_points_check;
ALTER TABLE public.votes ADD CONSTRAINT votes_points_check
  CHECK (points BETWEEN -100 AND 120) NOT VALID;

ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_mode_check;
ALTER TABLE public.votes ADD CONSTRAINT votes_mode_check
  CHECK (mode IN ('daily', 'endless', 'crowd', 'theme')) NOT VALID;

ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_player_id_check;
ALTER TABLE public.votes ADD CONSTRAINT votes_player_id_check
  CHECK (char_length(player_id) BETWEEN 1 AND 64) NOT VALID;

ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_nickname_check;
ALTER TABLE public.votes ADD CONSTRAINT votes_nickname_check
  CHECK (char_length(nickname) BETWEEN 1 AND 32) NOT VALID;

DROP POLICY IF EXISTS "anon_insert_votes" ON public.votes;
CREATE POLICY "anon_insert_votes" ON public.votes FOR INSERT TO anon, authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_id)
    AND pick IN ('allow', 'ask_human', 'block')
    AND confidence >= 0.5 AND confidence <= 1
    AND points BETWEEN -100 AND 120
    AND mode IN ('daily', 'endless', 'crowd', 'theme')
    AND char_length(player_id) BETWEEN 1 AND 64
    AND char_length(nickname) BETWEEN 1 AND 32
    AND created_at BETWEEN now() - interval '1 minute' AND now() + interval '1 minute'
  );

-- 4. daily_decks: one row per day (primary key), only for today, only real card ids.
DROP POLICY IF EXISTS "anon_insert_daily_decks" ON public.daily_decks;
CREATE POLICY "anon_insert_daily_decks" ON public.daily_decks FOR INSERT TO anon, authenticated
  WITH CHECK (
    day BETWEEN (now() at time zone 'utc')::date - 1 AND (now() at time zone 'utc')::date + 1
    AND array_ndims(card_ids) = 1
    AND cardinality(card_ids) BETWEEN 1 AND 10
    AND array_position(card_ids, NULL) IS NULL
    AND cardinality(card_ids) = (SELECT count(DISTINCT u.id) FROM unnest(card_ids) AS u(id))
    AND NOT EXISTS (
      SELECT 1 FROM unnest(card_ids) AS u(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.cards c WHERE c.id = u.id)
    )
    AND created_at BETWEEN now() - interval '1 minute' AND now() + interval '1 minute'
  );

-- 5. Drop deny-only policies and revoke write privileges the client doesn't need.
DROP POLICY IF EXISTS "anon_insert_cards" ON public.cards;
DROP POLICY IF EXISTS "anon_update_cards" ON public.cards;
DROP POLICY IF EXISTS "anon_delete_cards" ON public.cards;
DROP POLICY IF EXISTS "anon_update_votes" ON public.votes;
DROP POLICY IF EXISTS "anon_delete_votes" ON public.votes;
DROP POLICY IF EXISTS "anon_update_daily_decks" ON public.daily_decks;
DROP POLICY IF EXISTS "anon_delete_daily_decks" ON public.daily_decks;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cards FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.votes FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.daily_decks FROM anon, authenticated;
