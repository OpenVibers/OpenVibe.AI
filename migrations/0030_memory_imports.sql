-- phase: expand
-- OpenVibe Memory M3: one sealed draft per import preview. The person drops a ChatGPT, Claude or Google Takeout
-- export, sees every candidate, and keeps or removes each; nothing enters memory_items until they choose.
--
-- payload_enc is the whole draft (summary and candidates) sealed with AI_MEMORY_KEY, AAD
-- `memory-import|<owner>|<id>`, so the table holds no plaintext. A draft lives for two hours and is deleted on
-- commit, on discard, on expiry and with the person's account (server/account-data.js).
CREATE TABLE IF NOT EXISTS memory_imports (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    provider text COLLATE "C" NOT NULL,
    payload_enc text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_imports_owner_expires ON memory_imports (owner, expires_at);
