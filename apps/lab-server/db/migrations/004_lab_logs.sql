CREATE UNLOGGED TABLE lab_logs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  line text NOT NULL
);
CREATE INDEX lab_logs_run_idx ON lab_logs(run_id, id);
