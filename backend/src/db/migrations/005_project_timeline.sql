-- ETS 0.7.0 — project timeline and daily progress snapshots.
--
-- schedule.end_date: planned project close date, set in Settings together with the start date. When it is
-- set, the number of periods is derived from start → close (the last period ends on the close date).
-- progress_snapshots: one row per day with the whole-project progress (taken hourly by the API, the latest
-- value of the day wins). Used for the progress trend, the current pace and the forecast close date.

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS end_date date;

CREATE TABLE IF NOT EXISTS progress_snapshots (
  day         date PRIMARY KEY,
  total_pct   numeric(6,2) NOT NULL,
  fn_pct      numeric(6,2) NOT NULL,
  functions   integer NOT NULL,
  done        integer NOT NULL,
  tested_ok   integer NOT NULL,
  notes       integer NOT NULL,
  departments jsonb NOT NULL DEFAULT '{}',          -- { "<department id>": pct }
  taken_at    timestamptz NOT NULL DEFAULT now()
);
