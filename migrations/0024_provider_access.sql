-- phase: expand
-- AI Exchange D3: the commercial access a provider's capacity is offered under. Paid managed routing on the
-- catalog flag (AI_MODEL_CATALOG) uses only OWN_DEPLOYMENT or AUTHORIZED_WHOLESALE offers; a person's own key
-- (CUSTOMER_BYOK) never goes through this pool. The default is UNVERIFIED: an offer that has not recorded an
-- agreement or an owned deployment is never silently treated as resellable. Additive only: every existing row
-- keeps the UNVERIFIED default until an operator records its access.
ALTER TABLE providers ADD COLUMN provider_access text COLLATE "C" NOT NULL DEFAULT 'UNVERIFIED';  -- OWN_DEPLOYMENT | AUTHORIZED_WHOLESALE | CUSTOMER_BYOK | RESTRICTED | UNVERIFIED
