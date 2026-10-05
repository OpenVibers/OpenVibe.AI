-- phase: expand
-- B22: a run's Billing readings are one platform.usage-sample@1 per finished provider attempt per token metric
-- (server/usage-samples.js), keyed ai:<run id>:<attempt>:<kind>. runs.usage_sample_ids links that whole set in
-- order; runs.usage_sample_id (0005) named the single aggregate reading and is no longer written by AI. Additive
-- only: a new nullable column, no existing row rewritten, and the old column left in place.
ALTER TABLE runs ADD COLUMN usage_sample_ids text[];
