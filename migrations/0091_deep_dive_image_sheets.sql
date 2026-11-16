-- phase: expand
-- A design deep dive's image search sheets (11-15: a whole page of recent image results laid out as one sheet and
-- read at once), live while the run works, like its captures.
ALTER TABLE deep_dives ADD COLUMN image_sheets jsonb NOT NULL DEFAULT '[]'::jsonb;
