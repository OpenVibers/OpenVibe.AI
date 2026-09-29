-- phase: expand
-- T6 provider router, phase 1 (brief-t6-ai.out.md §4/§7, decisions-t4-t6.md "T6"):
-- a route either pins [primary, ...fallbacks] (unchanged) or names a capability and lets the router
-- assemble the pool from every provider that can serve it, ordered by openvibe-sdk/placement. The
-- run keeps the placement explanation the router produced (objective, reasons, selected, candidates),
-- so POST /runs, the direct operations and GET /runs/:id all carry it.

ALTER TABLE routes ADD COLUMN capability text COLLATE "C";                          -- a feature the pool must cover (chat|transcribe|embed|...) or NULL for pinned routes
ALTER TABLE routes ADD COLUMN constraints text COLLATE "C" NOT NULL DEFAULT '{}';   -- placement requirements: objective, latency_class, max_latency_ms, max_cost_usd, trust, model, authority
ALTER TABLE routes ADD COLUMN pinned text COLLATE "C" NOT NULL DEFAULT '[]';        -- [{provider, model}] always kept in the pool (migration)

ALTER TABLE runs ADD COLUMN explain text COLLATE "C";                               -- platform.placement-result@1 plus the candidate view, as the router returned it
