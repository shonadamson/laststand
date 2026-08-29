-- Run this in your Supabase SQL Editor (supabase.com → your project → SQL Editor)
-- It creates one table that stores the entire league state as JSON

CREATE TABLE IF NOT EXISTS league_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert the initial empty state
INSERT INTO league_state (id, state)
VALUES (1, '{
  "users": [],
  "currentWeek": 1,
  "picks": {},
  "results": {},
  "eliminations": {},
  "weekLocked": {},
  "gradingResults": {},
  "thresholds": {
    "rb":        { "rushRecYds": 65 },
    "passing":   { "passYds": 220 },
    "receiving": { "recYds": 40 },
    "tfl":       { "requireAny": true },
    "defense":   { "maxPointsAllowed": 26 },
    "offense":   { "minPointsScored": 21 },
    "td":        { "requireAny": true, "minLongPlayYds": 20 },
    "kicker":    { "minKickerPts": 5 },
    "win":       { "requireWin": true },
    "loss":      { "requireLoss": true }
  }
}')
ON CONFLICT (id) DO NOTHING;

-- Enable realtime updates so all browsers sync instantly
ALTER TABLE league_state REPLICA IDENTITY FULL;

-- Allow public read/write (the app handles its own auth)
ALTER TABLE league_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON league_state
  FOR ALL USING (true) WITH CHECK (true);
