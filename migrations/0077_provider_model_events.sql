-- phase: expand
-- Keep the exact model ids behind each owner-visible sync count and public Exchange event.
ALTER TABLE provider_model_syncs ADD COLUMN added_models jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE provider_model_syncs ADD COLUMN missing_models jsonb NOT NULL DEFAULT '[]'::jsonb;
