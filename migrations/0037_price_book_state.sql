-- phase: expand
-- The living price book's own state: when it last ran, and which instance is running it now.
--
-- The weekly interval has to survive a restart. OpenVibe.AI is deployed several times a day, so a timer that
-- lives in the process would be reset every time and the price book would never run on its own. The last run
-- is therefore a row in the database, not a moment in memory, and the due check reads it.
--
-- The row carries the claim as well: AI runs several workers, and only one of them may read the providers'
-- listings at a time. A worker claims the row before it starts and releases it when it ends; the claim expires
-- on its own, so a worker that dies mid-run does not block the next one for ever.
CREATE TABLE IF NOT EXISTS price_book_state (
    id              text COLLATE "C" PRIMARY KEY CHECK (id = 'pricebook'),   -- one row
    last_run_at     timestamptz,       -- when the last run finished (null before the first one)
    claimed_until   timestamptz,       -- while this is in the future, an instance holds the run
    claimed_by      text COLLATE "C",  -- the instance that holds it
    updated_at      timestamptz NOT NULL
);
INSERT INTO price_book_state (id, last_run_at, claimed_until, claimed_by, updated_at)
VALUES ('pricebook', NULL, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;
