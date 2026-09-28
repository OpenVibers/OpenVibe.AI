#!/usr/bin/env node
'use strict';
/**
 * The one-time move of AI's SQLite database (AI_DB_PATH) into its PostgreSQL schema (ADR-035; the procedure is
 * openvibe-sdk docs/migrating-to-postgresql.md, section 6, carried out by openvibe-sdk/db runSqliteMigration).
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 * Applies migrations/ as the owner (DATABASE_DIRECT_URL), copies every table into emptied tables, verifies row counts
 * and checksums, and exits 1 unless everything verified. The SQLite file is opened read-only. Every table keeps its
 * name and columns.
 */
require('dotenv').config();
const { runSqliteMigration } = require('openvibe-sdk/db');
const configLib = require('../server/config');
const { MIGRATIONS } = require('../server/db');

const TABLES = {};

if (require.main === module) {
    const config = (configLib.load || configLib.loadConfig)();
    runSqliteMigration({ service: 'ai', sqlite: config.dbPath, directUrl: config.db.directUrl, migrations: MIGRATIONS, tables: TABLES })
        .then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES };
