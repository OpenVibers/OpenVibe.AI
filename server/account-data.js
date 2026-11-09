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
    { table: 'exchange_api_keys', subject: 'owner', file: 'exchange-keys.json', columns: ['id','name','prefix','monthly_cap_usd','allowed_models','created_at','revoked_at'], erase: { keep: 'extraErase deletes key usage and cap rows before deleting keys' } },
    { table: 'exchange_supply_settings', subject: 'actor', file: null, erase: { keep: 'owner pricing decisions are the operator audit trail' } },
    { table: 'console_sessions', subject: 'subject', file: 'console-sessions.json', columns: ['username', 'created_at', 'expires_at', 'revoked_at'], order: 'created_at' },
    { table: 'person_sessions', subject: 'subject', file: 'person-sessions.json', columns: ['username', 'created_at', 'expires_at', 'revoked_at'], order: 'created_at' },
    { table: 'subject_credentials', subject: 'subject', file: 'provider-credentials.json', order: 'updated_at',
        columns: ['owner', 'subject', 'provider', 'base_url', 'machine', 'key_hint', 'models', 'budget_usd_day', 'is_default', 'spend_key', 'status', 'checked_at', 'last_error', 'models_count', 'created_at', 'updated_at', 'last_used_at'] },
    // Session-cookie values are never exported; only the person's credential metadata and non-secret reader settings.
    { table: 'session_credentials', subject: 'subject', file: 'provider-session-credentials.json', order: 'created_at',
        columns: ['owner', 'subject', 'provider', 'label', 'created_at', 'last_used_at', 'expires_at', 'expired', 'settings_json'] },
    // L36 Y3: how the person's runs route (only_my_keys, free_first, the price ceiling and the defaults). Their own
    // settings, so they go with the account; the row holds no key.
    { table: 'ai_person_preferences', subject: 'subject', file: 'ai-preferences.json', columns: ['preferences', 'created_at', 'updated_at'], order: 'created_at' },
    // The person's saved model for each AI task (rich-content plan §1): their own setting, and the row holds a model
    // name and a source, never a key.
    { table: 'ai_task_choices', subject: 'subject', file: 'ai-task-choices.json', columns: ['task', 'choice', 'updated_at'], order: 'updated_at' },
    // L55 C3: the apps the person allowed to use their own key. Names only: no key, no hint, no material of any kind.
    { table: 'ai_key_grants', subject: 'subject', file: 'key-grants.json', columns: ['service', 'provider', 'created_at'], order: 'created_at' },
    // Memory M2a: the rows are deleted by owner here; the decrypted items are added by extraExport below. The text is
    // never exported sealed (it would be unreadable to the person) and the generic table export stays out of it.
    { table: 'memory_items', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    { table: 'memory_profiles', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    { table: 'memory_reads', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    // Memory M3: import previews are drafts, never part of the person's export; they go with the account like the
    // notes they would become. The payload is sealed, and the row is never read by the account export.
    { table: 'memory_imports', subject: 'owner', value: (usr) => `user:${usr}`, file: null, erase: 'delete' },
    // Memory M5: a connected memory service's sealed key. It goes with the account and is never exported: the key is
    // not the person's data to read back, and its existence is shown on the Memory page instead.
    { table: 'memory_service_connections', subject: 'subject', file: null, erase: 'delete' },
    { table: 'free_allowance_usage', subject: 'subject', file: 'free-allowance.json', erase: { keep: ledger } },
    // D11 owner settings: the revisions are the service's configuration audit trail, kept like the catalogues.
    { table: 'config_snapshots', subject: 'created_by', file: null, erase: { keep: 'the configuration history is the service\'s; created_by is the operator audit trail' } },
    { table: 'routes', subject: 'created_by', file: null, erase: { keep: 'the route catalogue is the service\'s; created_by is the staff audit trail' } },
    { table: 'templates', subject: 'created_by', file: null, erase: { keep: 'the template catalogue is the service\'s; created_by is the staff audit trail' } },
    { table: 'workflows', subject: 'created_by', file: null, erase: { keep: 'the workflow catalogue is the service\'s; created_by is the staff audit trail' } },
    // Plan E5: the free allowance's daily counter (keyed `user:<subject>` or `device:<hash>`) and the accounts seen
    // on a device. Both are erased by extraErase below, which must see the device rows first to find the shared
    // counter; listing them here is what makes the guard (and the export count) know they exist.
    { table: 'abuse_daily_usage', subject: 'subject', value: (usr) => `user:${usr}`, file: null, erase: { keep: 'erased by extraErase after the device rows are read' } },
    { table: 'abuse_devices', subject: 'subject', file: null, erase: { keep: 'erased by extraErase after the shared counter is found' } },
    // A community endpoint (the design's SDK gap) is the person's own capacity: it goes in their export and is
    // removed when the account goes, so it stops receiving traffic too.
    { table: 'community_endpoint_offers', subject: 'owner_subject', file: 'community-endpoint-offers.json', order: 'created_at',
        columns: ['id', 'name', 'base_url', 'models', 'hours', 'concurrency', 'price_in', 'price_out', 'audience', 'group_id', 'created_at', 'updated_at'] },
    // Your own endpoint (the Exchange remake, build order 7): a private GPU rent. It is the person's own
    // data while the account lives, so it goes in the export. On deletion the row is anonymized at once and
    // marked stopping, and the next reconciler pass gives the GPU back and lets Billing settle the seconds;
    // the money rows themselves are kept like the ledger.
    { table: 'own_endpoints', subject: 'subject', file: 'own-endpoints.json', order: 'created_at',
        columns: ['id', 'status', 'source', 'catalog_key', 'display_name', 'weights_repo', 'weights_file', 'lora_repo', 'lora_file',
            'idle_minutes', 'max_runtime_minutes', 'marketplace', 'price_per_hour', 'charged_nano', 'created_at', 'ready_at', 'stopped_at'],
        erase: { keep: 'the GPU rent and its Billing hold are money records; extraErase anonymizes them and stops the rent so Billing can settle' } },
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
    const usage = await db.many('SELECT u.day,u.model,u.tokens_in,u.tokens_out,u.cost_usd,u.status FROM exchange_key_usage u JOIN exchange_api_keys k ON k.id=u.key_id WHERE k.owner=$1 ORDER BY u.day DESC LIMIT 5000', [subject]);
    return [...(runs.length ? [{ name: 'runs.json', content: runs }] : []), { name:'exchange-key-usage.json', content:usage }];
}

/** The person's runs go, with the rows that hang under them (the requests, the citations, the cached answers). */
async function extraErase(t, subjects, counts) {
    for (const table of ['exchange_key_usage','exchange_key_months']) counts.add(counts.erased, table, await t.exec(`DELETE FROM ${table} WHERE key_id IN (SELECT id FROM exchange_api_keys WHERE owner = ANY($1::text[]))`, [subjects]));
    counts.add(counts.erased, 'exchange_api_keys', await t.exec('DELETE FROM exchange_api_keys WHERE owner = ANY($1::text[])', [subjects]));
    // A private GPU rent is stopped and anonymized now; its Billing hold and money stay until the reconciler
    // gives the instance back and settles the seconds (the table's erase is a keep for that reason).
    counts.add(counts.erased, 'own_endpoints', await t.exec(`UPDATE own_endpoints
        SET status = CASE WHEN status IN ('requested','starting','running','stopping') THEN 'stopping' ELSE status END,
            subject = NULL, display_name = 'deleted endpoint', weights_repo = NULL, weights_file = NULL,
            lora_repo = NULL, lora_file = NULL, url = NULL, updated_at = now()
        WHERE subject = ANY($1::text[])`, [subjects]));
    // Plan E5: the free-tier counters. A shared device counter is kept while another account still uses the device;
    // when this person was the last one, the device counter and its velocity bucket go too.
    const hashes = (await t.many('SELECT DISTINCT device_hash FROM abuse_devices WHERE subject = ANY($1::text[])', [subjects])).map((r) => r.device_hash);
    counts.add(counts.erased, 'abuse_devices', await t.exec('DELETE FROM abuse_devices WHERE subject = ANY($1::text[])', [subjects]));
    counts.add(counts.erased, 'abuse_daily_usage', await t.exec('DELETE FROM abuse_daily_usage WHERE subject = ANY($1::text[])', [subjects.map((s) => `user:${s}`)]));
    for (const hash of hashes) {
        const left = Number(await t.value('SELECT COUNT(*)::int FROM abuse_devices WHERE device_hash = $1', [hash])) || 0;
        if (left) continue;
        counts.add(counts.erased, 'abuse_daily_usage', await t.exec('DELETE FROM abuse_daily_usage WHERE subject = $1', [`device:${hash}`]));
        counts.add(counts.erased, 'abuse_velocity', await t.exec("DELETE FROM abuse_velocity WHERE kind = 'device' AND key_hash = $1", [hash]));
    }
    const ids = (await t.many(`SELECT id FROM runs WHERE on_behalf_of IS NOT NULL AND on_behalf_of::jsonb ->> 'type' = 'user' AND on_behalf_of::jsonb ->> 'id' = ANY($1::text[])`, [subjects])).map((r) => r.id);
    // Memory M5: the store's share rows. The person's own store goes, their memberships and requests go, and a
    // transfer with them on either side goes. The append-only log stays as a tombstone, like every other audit row.
    const forms = subjects.map((s) => JSON.stringify({ type: 'user', id: s }));
    const members = await t.exec('DELETE FROM share_members WHERE subject = ANY($1::jsonb[])', [forms]);
    const requests = await t.exec('DELETE FROM share_access_requests WHERE subject = ANY($1::jsonb[])', [forms]);
    const owned = await t.exec("DELETE FROM shares WHERE service = 'ai' AND kind = 'memory-store' AND owner_subject = ANY($1::jsonb[])", [forms]);
    const transfers = await t.exec("DELETE FROM share_transfers WHERE service = 'ai' AND kind = 'memory-store' AND (from_subject = ANY($1::jsonb[]) OR to_subject = ANY($1::jsonb[]))", [forms]);
    if (Number(members) || Number(requests) || Number(owned) || Number(transfers)) {
        counts.add(counts.erased, 'share_rows', Number(members) + Number(requests) + Number(owned) + Number(transfers));
    }
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

// The sharing system's own tables carry a person as a jsonb subject (a member, an access request), which the table
// map cannot express; they are erased in extraErase above, with the rest of the person's rows.
const EXEMPT = {
    share_members: 'the sharing system own member rows: the subject is a jsonb subject, so they are erased in extraErase',
    share_access_requests: 'the sharing system own access requests: the subject is a jsonb subject, so they are erased in extraErase',
};

module.exports = { create, TABLES, TOPICS, EXEMPT, extraExport, extraErase };
