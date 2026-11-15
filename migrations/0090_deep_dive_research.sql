-- phase: expand
-- The general deep dive (workflow research.deep_dive, report ai.research@1): any question, its pages read as text
-- and answered with their sources (the owner, 11-15: Exchange's search deep dives any query; OpenVibe.Design's
-- design deep dive builds on it). A deep dive row now says which kind it is (the design dive, which captures sites,
-- is every row so far), the questions its plan wrote, and the pages it read, live, while it runs.
ALTER TABLE deep_dives ADD COLUMN kind text COLLATE "C" NOT NULL DEFAULT 'design';
ALTER TABLE deep_dives ADD COLUMN plan jsonb;
ALTER TABLE deep_dives ADD COLUMN reads jsonb NOT NULL DEFAULT '[]'::jsonb;
