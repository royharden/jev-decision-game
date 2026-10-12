/*
# Close anon writes on votes and daily_decks; add per-player daily vote quota

1. votes / daily_decks
- Drops every non-SELECT policy on both tables (anon_insert_votes,
  anon_insert_daily_decks, and any other INSERT/UPDATE/DELETE/ALL policy), so with
  RLS on, anon and authenticated can only read them.
- Revokes INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on both tables
  from PUBLIC, anon and authenticated. SELECT (and the SELECT policies) stay.
- Writes now go only through edge functions running as service_role (which bypasses
  RLS): submit-vote inserts votes (server-side scoring, validated input) and
  daily-deck creates the day's deck. The CHECK constraints from the previous
  migration still bound every vote row.
2. New table `vote_quota`
- `day` (date), `player_id` (text), `votes` (int); primary key (day, player_id).
- RLS on, no policies, REVOKE ALL from PUBLIC, anon and authenticated.
3. New function `consume_vote_quota(p_player_id text, p_cap int)`
- Same atomic upsert as increment_usage: counts one vote for the player today (UTC)
  and returns true while under p_cap, NULL once the cap is reached.
- SECURITY DEFINER, search_path = public. EXECUTE granted only to service_role.
*/

-- 1. votes / daily_decks: drop every write policy, revoke write privileges.
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('votes', 'daily_decks')
      AND cmd <> 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_decks ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.votes, public.daily_decks
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON public.votes, public.daily_decks TO service_role;

-- 2. vote_quota: per-player, per-day vote counter, service_role only.
CREATE TABLE IF NOT EXISTS public.vote_quota (
  day date NOT NULL,
  player_id text NOT NULL,
  votes int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, player_id)
);

ALTER TABLE public.vote_quota ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vote_quota FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vote_quota TO service_role;

-- 3. consume_vote_quota: true while under the cap, NULL once it is reached.
CREATE OR REPLACE FUNCTION public.consume_vote_quota(p_player_id text, p_cap int)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.vote_quota AS vq (day, player_id, votes)
  VALUES ((now() at time zone 'utc')::date, p_player_id, 1)
  ON CONFLICT (day, player_id)
  DO UPDATE SET votes = vq.votes + 1
  WHERE vq.votes < p_cap
  RETURNING true;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_vote_quota(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_vote_quota(text, int) TO service_role;
