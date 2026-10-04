# Cutover — provider free allowance (`migrations/0006_free_allowance.sql`, T6 step 2)

The change: an accounted run first claims its subject's provider free allowance (§2.1.8: the rate
card's `free_allowance` per provider, metric and `reset_period`) in the transaction that accounts
it. The free tokens are reported as `free_allowance_used` on the run's `platform.usage-sample@1`
and their price is left out of its `cost_estimate`. Pricing only: quotas, request counting and the
run's own cost are unchanged, and no call is refused because of it. Details in
`server/free-allowance.js`.

## What the migration changes

`migrations/0006_free_allowance.sql` is an **expand** migration, additive and transactional:

- a new table `free_allowance_usage (subject, provider, metric, period_start, period_end, free_used,
  updated_at)`, primary key `(subject, provider, metric, period_start)`, one row per subject,
  provider, metric and reset period;
- one index, `idx_free_allowance_period (period_end)`, for the current periods.

No existing table or row is touched, no data moves. The previous release (N-1) does not know the
table, so a rollback to it needs no data change. The only writer is the AI service itself: there is
no import, no dual-write window and no backfill. Every rate card defaults to `free_allowance` 0, so
until an operator configures an allowance the table stays empty and readings are unchanged.

## Order

1. **Preconditions (pre-merge).** CI green on the branch head; the PR body carries the `cutover`
   manifest; the rehearsal below recorded green. Billing does not have to change:
   `free_allowance_used` is an optional field of `platform.usage-sample@1` it already accepts.

2. **Backup (before anything touches the schema).**
   `ov access run openvibe-ovh db-backup ai` — ovhost takes a backup of AI's declared database and
   logs it. Keep the backup id/artifact for the deployment until the verify step is signed off.
   By hand (owner role, same result): `pg_dump --format=custom --no-owner "$DATABASE_DIRECT_URL" >
   ai-<utc-timestamp>.dump`, then `pg_restore --list` on it to prove it is complete. This is the
   only backup the cutover needs; the migration itself loses nothing.

3. **Rehearse on a copy.** Restore the backup into a scratch database (`pg_restore` into
   `ai-rehearsal`, or copy `/…/data/pglite`), start the release against it as the owner
   (`DATABASE_URL`/`DATABASE_DIRECT_URL` pointed at the copy, `node server/index.js`), and run the
   verify checks below against the copy. The migration is applied by the service at boot
   (`server/db.js` `openDb()`), as the owner on the direct connection, in a transaction, serialised
   by the SDK's advisory lock, and recorded in `ov_migrations` with a checksum. Whoever runs this
   writes the marker `ds/deploy/rehearsals/ai-free-allowance-0006.json` as `{"ok": true}` — the
   author never writes it.

4. **Apply in production.** Merged work deploys through its pipeline (the recipe runs with every
   guard). The migration runs on the next service start, in the same boot path as the rehearsal.
   No manual `psql` step.

5. **Verify** (see below). Sign the deploy off only when the schema checks pass and one run on
   default cards still produces a reading without `free_allowance_used`.

## How the result is verified

Schema, as the owner on the direct connection:

```sql
SELECT id, name, phase, applied_at FROM ov_migrations WHERE id = '0006';   -- one row, phase expand
\d free_allowance_usage                                                    -- table, primary key + the index
SELECT count(*) FROM free_allowance_usage;                                 -- 0 while every card's allowance is 0
```

Service and follow-through:

- `ov access run openvibe-ovh health ai` → ready (`GET /api/ready`).
- `ov access run openvibe-ovh journal openvibe-ai.service 200` → no migration error.
- One accounted run on default cards: its reading has no `free_allowance_used` and the same
  `cost_estimate` as before —
  `SELECT envelope FROM usage_sample_outbox ORDER BY id DESC LIMIT 1;`.
- Once an operator sets an allowance (a models row's `cost.free_allowance`/`reset_period`, or
  `AI_PRICING_JSON`), one run against it: a row per metric appears with `free_used` never above the
  card's `free_allowance`, and the run's reading carries `free_allowance_used` equal to the free
  tokens.

  ```sql
  SELECT subject, provider, metric, period_start, period_end, free_used FROM free_allowance_usage ORDER BY updated_at DESC LIMIT 5;
  ```

## Way back

- **Roll back the release (the normal way).** The migration is expand and additive and N-1 ignores
  the table, so `ov access run openvibe-ovh rollback ai` (owner) is enough; leave the table in
  place, it is harmless. N-1 prices every token again; readings it writes carry no
  `free_allowance_used`.
- **Stop granting free tokens without changing code or schema:** set the cards' `free_allowance`
  back to 0 (the models row or `AI_PRICING_JSON`) and restart — nothing more is claimed; the rows
  already written stay as the record of what was free.
- **Only if the table itself must go** (not required for a rollback), with the owner's approval and
  the backup in hand, after the previous release is running:

  ```sql
  DROP TABLE IF EXISTS free_allowance_usage;
  DELETE FROM ov_migrations WHERE id = '0006';
  ```

  The only loss is the record of free tokens used in the current periods (a later release would
  grant them again); `usage_daily`, the run ledger and the readings are untouched.
- **Never edit `0006_free_allowance.sql` in place:** `ov_migrations` records its checksum and the
  runner refuses a changed file. Undo with new SQL (or a later migration), not by rewriting it.

## Notes

- Not a `migrate`/`contract` pair: nothing depends on the new table outside this service and
  nothing needs the N-1 window, so no follow-up migration is scheduled.
- `deploy/` and `.env.example` need no change: no new env; `AI_PRICING_JSON` already documents
  `free_allowance` and `reset_period`.
- T6 step 8 (`openvibe-sdk/govern` tiers) moves this counter's store; its semantics and the
  reading's field stay.
