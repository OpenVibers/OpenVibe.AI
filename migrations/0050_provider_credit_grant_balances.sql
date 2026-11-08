-- phase: expand
ALTER TABLE provider_credit_grants ADD COLUMN IF NOT EXISTS received_at text COLLATE "C";
ALTER TABLE provider_credit_grants ADD COLUMN IF NOT EXISTS remaining_as_of_usd numeric(14, 6);
ALTER TABLE provider_credit_grants ADD COLUMN IF NOT EXISTS remaining_as_of text COLLATE "C";
UPDATE provider_credit_grants SET received_at = as_of WHERE received_at IS NULL;
UPDATE provider_credit_grants SET remaining_as_of_usd = amount_usd WHERE remaining_as_of_usd IS NULL;
UPDATE provider_credit_grants SET remaining_as_of = as_of WHERE remaining_as_of IS NULL;
