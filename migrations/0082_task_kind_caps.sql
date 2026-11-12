-- phase: expand
-- The monthly spend cap per task kind on the Setup page (OpenVibe.Network /admin/ai/setup).
-- 0 means no cap: the kind is metered but never refused by this table. The spend itself is the
-- runs' own cost, read for the current month; this table only holds the ceiling a person set.
CREATE TABLE task_kind_caps (
    task_kind text COLLATE "C" PRIMARY KEY,
    monthly_cap_usd double precision NOT NULL DEFAULT 0 CHECK (monthly_cap_usd >= 0),
    updated_at timestamptz NOT NULL,
    updated_by text COLLATE "C"
);
