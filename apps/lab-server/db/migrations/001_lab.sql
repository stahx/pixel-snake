CREATE TABLE lab_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE lab_runs (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES lab_keys(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_id, name)
);

CREATE TABLE lab_progress (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES lab_runs(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  episodes integer NOT NULL,
  score_avg double precision,
  score_max double precision,
  ticks_avg double precision,
  eaten_avg double precision,
  boost_avg double precision,
  deaths jsonb NOT NULL,
  metrics jsonb NOT NULL
);
CREATE INDEX lab_progress_run_idx ON lab_progress(run_id, recorded_at);
