-- phase: expand
-- L55 C3: the apps (services) a person allows to use their own provider key. The person's own choice, per app, for
-- one provider or for all of them. No key material is here: the key stays sealed in subject_credentials. Expand only:
-- a service without this table keeps running (no grant means no service may use a person's key).
CREATE TABLE IF NOT EXISTS ai_key_grants (
    subject    text COLLATE "C" NOT NULL,
    service    text COLLATE "C" NOT NULL,
    provider   text COLLATE "C" NOT NULL DEFAULT '*',
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (subject, service, provider)
);
