# Cutover — AI usage readings to Billing (`migrations/0005_usage_samples.sql`, PR #13)

The change: every accounted run writes one `platform.usage-sample@1` reading into a retry-safe
outbox, and a relay posts it to Billing's `billing.usage.record` (`POST /api/v1/usage`, audience
`openvibe.billing`). Details in `server/usage-samples.js`.

## What the migration changes

`migrations/0005_usage_samples.sql` is an **expand** migration, additive and transactional:

- a new table `usage_sample_outbox` (one row per reading) and two partial indexes,
  `usage_sample_outbox_due` and `usage_sample_outbox_sent`;
- one new **nullable** column `runs.usage_sample_id text COLLATE "C"`, naming the reading a run
  produced.

No existing row is rewritten, no column gains `NOT NULL`, no data moves. The previous release
(N-1) neither reads the table nor the column, so a rollback to it needs no data change. Both
writers are the AI service itself: there is no import, no dual-write window and no backfill.

## Order

1. **Preconditions (pre-merge).** CI green on the branch head; the PR body carries the `cutover`
   manifest; the rehearsal below recorded green. Billing does **not** have to ship first: a missing
   route, a missing grant (`401`/`403`/`404`) or a `429`/`5xx` leaves the row queued and retried
   with backoff across restarts; only `400`/`409`/`413`/`422` mark a reading rejected.

2. **Backup (before anything touches the schema).**
   `ov access run openvibe-ovh db-backup ai` — ovhost takes a backup of AI's declared database and
   logs it. Keep the backup id/artifact for the deployment until the verify step is signed off.
   By hand (owner role, same result): `pg_dump --format=custom --no-owner "$DATABASE_DIRECT_URL" >
   ai-<utc-timestamp>.dump`, then `pg_restore --list` on it to prove it is complete. This is the
   only backup the cutover needs; the migration itself loses nothing.

3. **Rehearse on a copy.** Restore the backup into a scratch database (`pg_restore` into
   `ai-rehearsal`, or copy `/…/data/pglite`), start the release against it as the owner
   (`DATABASE_URL`/`DATABASE_DIRECT_URL` pointed at the copy, e.g. `USAGE_SAMPLES=on node
   server/index.js`), and run the verify checks below against the copy. The migration is applied by
   the service at boot (`server/db.js` `openDb()`), as the owner on the direct connection, in a
   transaction, serialised by the SDK's advisory lock, and recorded in `ov_migrations` with a
   checksum. Whoever runs this writes the marker `ds/deploy/rehearsals/ai-usage-samples-0005.json`
   as `{"ok": true}` — the author never writes it.

4. **Apply in production.** Merged work deploys through its pipeline (the recipe runs with every
   guard). The migration runs on the next service start, in the same boot path as the rehearsal.
   No manual `psql` step.

5. **Verify** (see below). Sign the deploy off only when both the schema checks and one end-to-end
   reading pass.

## How the result is verified

Schema, as the owner on the direct connection:

```sql
SELECT id, name, phase, applied_at FROM ov_migrations WHERE id = '0005';   -- one row, phase expand
\d usage_sample_outbox                                                     -- table + the two indexes
SELECT usage_sample_id FROM runs LIMIT 1;                                  -- column exists, nullable
```

Service and follow-through:

- `ov access run openvibe-ovh health ai` → ready (`GET /api/ready`).
- `ov access run openvibe-ovh journal openvibe-ai.service 200` → no migration error; at most a
  `[Billing] usage sample send failed (will retry)` line while Billing is unavailable.
- One accounted run end to end: with `USAGE_SAMPLES` on and the relay configured
  (`OV_BILLING_INTERNAL_URL`, `OV_OAUTH_CLIENT_SECRET`), drive one workflow run, then

  ```sql
  SELECT event_id, attempts, sent_at, last_error FROM usage_sample_outbox ORDER BY id DESC LIMIT 5;
  SELECT usage_sample_id FROM runs WHERE id = '<run id>';
  ```

  The reading's id is `ai:<run id>:tokens`, the same value lands in `runs.usage_sample_id`, and
  `sent_at` is set with `last_error` null when Billing accepted it. If Billing is not deployed yet,
  rows waiting with `attempts`/`last_error` are the expected state, not a failure — they drain when
  it is. A person's own key, and runs that called no provider without a cache hit, produce no
  reading.
- The envelope carries ids only (`service`, `subject`, `resource`, `operation`, `quantity`, `unit`,
  `cost_estimate`, `provider`, `trace_id`) — never the input, the output or a prompt. Spot-check one:
  `SELECT envelope FROM usage_sample_outbox ORDER BY id DESC LIMIT 1;`.

## Way back

- **Roll back the release (the normal way).** The migration is expand and additive and N-1 ignores
  both objects, so `ov access run openvibe-ovh rollback ai` (owner) is enough; the schema stays and
  is harmless. Readings queued by the failed release simply wait.
- **Stop the flow without changing code or schema:** set `USAGE_SAMPLES=off` and restart — nothing
  is queued while it is off; rows already queued stay until they are sent.
- **Only if the objects themselves must go** (not required for a rollback), with the owner's
  approval and the backup in hand, after the previous release is running:

  ```sql
  DROP TABLE IF EXISTS usage_sample_outbox;
  ALTER TABLE runs DROP COLUMN IF EXISTS usage_sample_id;
  DELETE FROM ov_migrations WHERE id = '0005';
  ```

  The only loss is readings not yet sent; `usage_daily` and the run ledger are untouched.
- **Never edit `0005_usage_samples.sql` in place:** `ov_migrations` records its checksum and the
  runner refuses a changed file. Undo with new SQL (or a later migration), not by rewriting it.

## Notes

- Not a `migrate`/`contract` pair: nothing depends on the new objects and nothing needs the N-1
  window, so no follow-up migration is scheduled.
- `deploy/` needs no change: the service already reads `DATABASE_DIRECT_URL` for migrations, and
  `.env.example` documents the `OV_BILLING_INTERNAL_URL` / `USAGE_SAMPLES` /
  `USAGE_SAMPLES_INTERVAL_MS` names.
