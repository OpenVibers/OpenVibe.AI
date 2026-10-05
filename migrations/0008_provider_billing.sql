-- phase: expand
-- B25: a provider's billing profile and the shared subscription pool it draws on. 'metered' (the default)
-- and 'payg' carry per-token rate cards; 'subscription', 'free' and 'byok' are prepaid — the router offers
-- them with no rate card and never skips them for a missing credential (server/providers/index.js). pool_key
-- names the shared subscription pool a prepaid provider's capacity belongs to; it is a name, never a secret
-- value (secrets stay in secret_ref, which is itself only an env:NAME reference). Additive only: two new
-- columns, every existing row keeps the metered default.
ALTER TABLE providers ADD COLUMN billing_profile text COLLATE "C" NOT NULL DEFAULT 'metered';  -- metered | subscription | payg | free | byok
ALTER TABLE providers ADD COLUMN pool_key text COLLATE "C";                                    -- shared subscription pool name (subscription), or NULL
