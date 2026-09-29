'use strict';
/**
 * The AI authority's PostgreSQL database (ADR-035; migrations/NNNN_*.sql). One table family per canonical record
 * group of the plan (§12.13 / §15.14):
 *
 *   1  providers (+ provider_health)     6  runs
 *   2  models                            7  requests          (request/completion log)
 *   3  routes      (versioned)           8  citations         (sources/citations)
 *   4  templates   (versioned)           9  cache_entries
 *   5  workflows   (versioned)          10  quotas + usage_counters
 *                                       11  audit_log
 *                                       12  provider_stats_daily + placement_state   (T6 provider router)
 *
 * Templates, workflows and routes are append-only per key: an edit inserts version n+1 and the
 * previous version stays readable, so every run can say exactly which versions produced it.
 * import_ledger / import_holds belong to scripts/import-from-live.js; console_sessions to the
 * operator console (server/console/session.js).
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh ai)');
        log.warn(`[AI] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        const db = createDb({ pglite: DEV_PGLITE, service: 'ai', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'ai-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'ai', registry, log });
}

module.exports = { openDb, MIGRATIONS };
