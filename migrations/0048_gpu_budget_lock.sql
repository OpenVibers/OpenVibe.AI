-- phase: expand
CREATE TABLE IF NOT EXISTS gpu_budget_lock (id integer PRIMARY KEY);
INSERT INTO gpu_budget_lock (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE own_endpoints ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'cheapest';
