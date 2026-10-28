-- phase: expand
-- Person sessions for the run page (plan 2026-10-28 §3.10): a signed-in person's receipt for one run.
-- The cookie is a random 256-bit id; only its SHA-256 is stored. Staff console sessions stay in console_sessions.
CREATE TABLE IF NOT EXISTS person_sessions (
    id_hash text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,                     -- the Network person (usr_…)
    username text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL,
    revoked_at text COLLATE "C",
    ip_hash text COLLATE "C"
);
