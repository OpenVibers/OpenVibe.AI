'use strict';
/**
 * Account export and deletion → AI (ADR-033; openvibe-sdk/account-data). What AI holds about a person:
 *
 * - their console and person sessions (Console sign-in and the AI chat), erased;
 * - the provider credentials they brought (server/credentials.js), including the keys they hold themselves (owner
 *   `self`, L36): the encrypted key, its hint, status and the budget, erased with them (the key itself is never
 *   exported, only its hint and health);
 * - their ai.me-preferences (server/person-preferences.js): how their runs route. Their own settings, so they go;
 * - their runs: the workflows AI ran for them (runs.on_behalf_of is their SubjectRef) and the requests, citations and
 *   private cache entries under them. Those are the person's own content, so they go with the account (ADR-033);
 * - the free-allowance usage the allowance ledger counts (server/free-allowance.js) and the usage counters: kept,
 *   because the allowance and the spend must still reconcile across their period;
 * - their quota (their own limit) and the marker of what was last pushed to their modules: settings, they go;
 * - the route, template and workflow catalogues: the service's own, with created_by as the staff member's audit trail,
 *   and the audit log itself, which says what was done and by whom.
 *
 * Telemetry samples that name a person are covered by the SDK itself (telemetry.json, then subject NULL).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const ledger = 'money records: the ledger must still balance and reconcile, and the books are kept as the billing policy requires';

// The runs AI made for the person: their SubjectRef sits in the JSON column on_behalf_of.
const PERSON_RUN = `on_behalf_of IS NOT NULL AND on_behalf_of::jsonb ->> 'type' = 'user' AND on_behalf_of::jsonb ->> 'id' = $1`;
const RUN_COLUMNS = 'id, workflow_key, workflow_version, template_key, template_version, route_key, status, model_key, provider_key, input, output, citations_count, error_code, error_detail, tokens_in, tokens_out, cost_usd, created_at, started_at, finished_at';

const TABLES = [
    { table: 'console_sessions', subject: 'subject', file: 'console-sessions.json', columns: ['username', 'created_at', 'expires_at', 'revoked_at'], order: 'created_at' },
    { table: 'person_sessions', subject: 'subject', file: 'person-sessions.json', columns: ['username', 'created_at', 'expires_at', 'revoked_at'], order: 'created_at' },
    { table: 'subject_credentials', subject: 'subject', file: 'provider-credentials.json', order: 'updated_at',
        columns: ['owner', 'subject', 'provider', 'base_url', 'machine', 'key_hint', 'models', 'budget_usd_day', 'is_default', 'spend_key', 'status', 'checked_at', 'last_error', 'models_count', 'created_at', 'updated_at', 'last_used_at'] },
    // L36 Y3: how the person's runs route (only_my_keys, free_first, the price ceiling and the defaults). Their own
    // settings, so they go with the account; the row holds no key.
    { table: 'ai_person_preferences', subject: 'subject', file: 'ai-preferences.json', columns: ['preferences', 'created_at', 'updated_at'], order: 'created_at' },
    // L55 C3: the apps the person allowed to use their own key. Names only: no key, no hint, no material of any kind.
    { table: 'ai_key_grants', subject: 'subject', file: 'key-grants.json', columns: ['service', 'provider', 'created_at'], order: 'created_at' },
    // Memory M2a: the rows are deleted by owner here; the decrypted items are added by extraExport below. The text is
    // never exported sealed (it would be unreadable to the person) and the generic table export stays out of it.
    { table: 'memory_items', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    { table: 'memory_profiles', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    { table: 'memory_reads', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    { table: 'free_allowance_usage', subject: 'subject', file: 'free-allowance.json', erase: { keep: ledger } },
    { table: 'routes', subject: 'created_by', file: null, erase: { keep: 'the route catalogue is the service\'s; created_by is the staff audit trail' } },
    { table: 'templates', subject: 'created_by', file: null, erase: { keep: 'the template catalogue is the service\'s; created_by is the staff audit trail' } },
    { table: 'workflows', subject: 'created_by', file: null, erase: { keep: 'the workflow catalogue is the service\'s; created_by is the staff audit trail' } },
    // The person's own quota (server/quota.js): a limit that only means something while the account lives.
    { table: 'quotas', subject: 'scope_id', value: (usr) => `user:${usr}`, file: null },
    // What the person used, counted against their allowance: the spend ledger, kept.
    { table: 'usage_counters', subject: 'scope_id', value: (usr) => `user:${usr}`, file: null, erase: { keep: ledger } },
    // The audit trail of what was done (and by whom): kept, with the subject a tombstone.
    { table: 'audit_log', subject: 'actor', file: null, erase: { keep: 'the audit trail of what was done and by whom stays; the subject is a tombstone' } },
    // The marker of what was last pushed to the person's modules (server/user-modules.js): their own state.
    { table: 'ai_module_pushes', subject: 'subject_id', file: null },
];

/** The runs AI made for the person, with their input and their answer. */
async function extraExport(db, subject) {
    const runs = await db.many(`SELECT ${RUN_COLUMNS} FROM runs WHERE ${PERSON_RUN} ORDER BY created_at DESC LIMIT 5000`, [subject]);
    return runs.length ? [{ name: 'runs.json', content: runs }] : [];
}

/** The person's runs go, with the rows that hang under them (the requests, the citations, the cached answers). */
async function extraErase(t, subjects, counts) {
    const ids = (await t.many(`SELECT id FROM runs WHERE on_behalf_of IS NOT NULL AND on_behalf_of::jsonb ->> 'type' = 'user' AND on_behalf_of::jsonb ->> 'id' = ANY($1::text[])`, [subjects])).map((r) => r.id);
    if (!ids.length) return;
    counts.add(counts.erased, 'requests', await t.exec('DELETE FROM requests WHERE run_id = ANY($1::text[])', [ids]));
    counts.add(counts.erased, 'citations', await t.exec('DELETE FROM citations WHERE run_id = ANY($1::text[])', [ids]));
    counts.add(counts.erased, 'cache_entries', await t.exec('DELETE FROM cache_entries WHERE run_id = ANY($1::text[])', [ids]));
    counts.add(counts.erased, 'runs', await t.exec('DELETE FROM runs WHERE id = ANY($1::text[])', [ids]));
}

function create({ db, log = console, memory = null } = {}) {
    // Memory text is sealed; the person's own export gets it decrypted from the module that holds the key. Without the
    // key the rest of the account data still exports, and the memory file says it is unavailable (never any text).
    const exportAll = async (handle, subject) => {
        const files = await extraExport(handle, subject);
        if (!memory) return files;
        try { files.push(...(await memory.exportFor(subject))); }
        catch (err) { log.warn(`[account-data] memory export unavailable: ${err.code || err.message}`); files.push({ name: 'memory-items.json', content: { unavailable: 'AI_MEMORY_KEY is not configured on this service' } }); }
        return files;
    };
    return createAccountData({ db, service: 'ai', tables: TABLES, extraExport: exportAll, extraErase, log });
}

module.exports = { create, TABLES, TOPICS, extraExport, extraErase };
