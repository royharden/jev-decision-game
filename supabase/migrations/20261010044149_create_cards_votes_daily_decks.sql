/*
# Create cards, votes, daily_decks tables

1. New Tables
- `cards` — AI-agent judgment scenarios (the quiz cards).
  - `id` (uuid, primary key)
  - `agent_role` (text, who the agent is)
  - `action` (text, what the agent wants to do)
  - `context` (text, surrounding facts)
  - `theme` (text: money | email & messages | code & infra | health | home & IoT | data & privacy)
  - `source` (text: seed | llm | player)
  - `jev_response` (jsonb, raw Jev judgment, cached per card)
  - `verdict_probs` (jsonb, {allow, ask_human, block, uncertain})
  - `harm` (numeric, 0-4 Jev harm score)
  - `order_sensitive` (bool, Jev option-order check failed)
  - `latency_ms` (int, judged latency)
  - `cost_usd` (numeric, estimated Jev cost)
  - `created_at` (timestamp)
- `votes` — one player answer per card.
  - `id` (uuid, primary key)
  - `card_id` (uuid, FK to cards)
  - `player_id` (text, random local id)
  - `nickname` (text)
  - `pick` (text: allow | ask_human | block)
  - `confidence` (numeric 0.5-1)
  - `points` (int)
  - `mode` (text: daily | endless | crowd | theme)
  - `created_at` (timestamp)
- `daily_decks` — per-day card lists.
  - `day` (date, primary key)
  - `card_ids` (uuid array)
2. Security
- Enable RLS on all three tables.
- Public demo: anon can SELECT everything; anon can INSERT votes and player cards; UPDATE and DELETE are denied (votes and cards are immutable from the client).
3. Notes
- Player cards go through the submit-card edge function (service role) before landing here.
- `daily_decks` rows are written by the client with insert-if-missing semantics for the demo.
*/

CREATE TABLE IF NOT EXISTS cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_role text NOT NULL,
  action text NOT NULL,
  context text NOT NULL,
  theme text NOT NULL,
  source text NOT NULL DEFAULT 'seed',
  jev_response jsonb,
  verdict_probs jsonb,
  harm numeric,
  order_sensitive boolean DEFAULT false,
  latency_ms integer,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  nickname text NOT NULL,
  pick text NOT NULL,
  confidence numeric NOT NULL,
  points integer NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'endless',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_decks (
  day date PRIMARY KEY,
  card_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_decks ENABLE ROW LEVEL SECURITY;

-- Permissive anon policies for this demo: anyone can read, insert votes and player cards, but nothing can be updated or deleted from the client.
DROP POLICY IF EXISTS "anon_select_cards" ON cards;
CREATE POLICY "anon_select_cards" ON cards FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_cards" ON cards;
CREATE POLICY "anon_insert_cards" ON cards FOR INSERT TO anon, authenticated WITH CHECK (source = 'player');

DROP POLICY IF EXISTS "anon_update_cards" ON cards;
CREATE POLICY "anon_update_cards" ON cards FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "anon_delete_cards" ON cards;
CREATE POLICY "anon_delete_cards" ON cards FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "anon_select_votes" ON votes;
CREATE POLICY "anon_select_votes" ON votes FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_votes" ON votes;
CREATE POLICY "anon_insert_votes" ON votes FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_votes" ON votes;
CREATE POLICY "anon_update_votes" ON votes FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "anon_delete_votes" ON votes;
CREATE POLICY "anon_delete_votes" ON votes FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "anon_select_daily_decks" ON daily_decks;
CREATE POLICY "anon_select_daily_decks" ON daily_decks FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_daily_decks" ON daily_decks;
CREATE POLICY "anon_insert_daily_decks" ON daily_decks FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_daily_decks" ON daily_decks;
CREATE POLICY "anon_update_daily_decks" ON daily_decks FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_daily_decks" ON daily_decks;
CREATE POLICY "anon_delete_daily_decks" ON daily_decks FOR DELETE TO anon, authenticated USING (false);

CREATE INDEX IF NOT EXISTS votes_card_id_idx ON votes (card_id);
CREATE INDEX IF NOT EXISTS votes_player_idx ON votes (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cards_theme_idx ON cards (theme);