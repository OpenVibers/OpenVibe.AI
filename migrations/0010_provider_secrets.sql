-- phase: expand
-- Provider keys an owner adds from the operator console (server/vault.js): a provider whose secret_ref is
-- 'vault:<provider key>' reads its key from here, AES-256-GCM encrypted with AI_CREDENTIALS_KEY and bound to the
-- provider's key (the additional data), so a row copied to another provider does not decrypt. Only a hint (the last
-- four characters) is ever shown back; the key never leaves the service.
CREATE TABLE IF NOT EXISTS provider_secrets (
    provider_key  text COLLATE "C" PRIMARY KEY,
    sealed        text NOT NULL,
    hint          text COLLATE "C",
    updated_by    text COLLATE "C",
    updated_at    text COLLATE "C" NOT NULL
);
