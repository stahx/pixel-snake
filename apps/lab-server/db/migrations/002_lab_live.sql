CREATE UNLOGGED TABLE lab_live (
  instance text PRIMARY KEY,
  runs jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
