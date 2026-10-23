ALTER TABLE lab_runs ADD COLUMN starts timestamptz[] NOT NULL DEFAULT '{}';
