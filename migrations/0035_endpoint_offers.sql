-- phase: expand
-- Community endpoint offers (design EXCHANGE-REMAKE-2026-11-06, "Gap found while building the SDK"). A seller
-- registers a standalone OpenAI-compatible server by its own https address, with their Network developer key, on the
-- public seller API. Only AI's own egress guard reaches the address (https, a public DNS answer, never an IP literal,
-- timeouts, a response cap, and never the buyer's identity in a header). The verification state, spot re-runs, the
-- reputation and the seller ledger live in community_offers/community_usage: an endpoint is verified exactly as a
-- Node machine is (canaries, the model fingerprint, about 1% spot re-runs, free tier only until verified,
-- self-dealing earns 0). Nothing here stores a prompt, an answer or a buyer.
CREATE TABLE IF NOT EXISTS community_endpoint_offers (
    id              text COLLATE "C" PRIMARY KEY,       -- ep_<ULID>
    owner_subject   text COLLATE "C" NOT NULL CHECK (owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id      text COLLATE "C",                   -- the developer app's project (a person's own token has none)
    app_id          text COLLATE "C",                   -- the app that registered it (null for a person)
    created_by      text COLLATE "C" NOT NULL,          -- app_…, or the person's token sub
    name            text COLLATE "C",
    base_url        text COLLATE "C" NOT NULL,          -- https origin and path, no trailing slash, never an address
    models          jsonb NOT NULL,
    hours           jsonb NOT NULL,
    concurrency     integer NOT NULL CHECK (concurrency BETWEEN 1 AND 8),
    price_in        numeric(20, 6) NOT NULL CHECK (price_in >= 0),
    price_out       numeric(20, 6) NOT NULL CHECK (price_out >= 0),
    audience        text COLLATE "C" NOT NULL CHECK (audience IN ('everyone', 'followers', 'group')),
    group_id        text COLLATE "C",
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS community_endpoint_offers_owner ON community_endpoint_offers (owner_subject, created_at DESC);
