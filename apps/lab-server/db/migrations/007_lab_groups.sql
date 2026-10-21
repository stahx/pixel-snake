CREATE TABLE lab_groups (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  config jsonb NOT NULL,
  sessions integer[] NOT NULL,
  running boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
