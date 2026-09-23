#!/usr/bin/env node
'use strict';
/**
 * Import the AI records that belong to OpenVibe.AI from a snapshot of OpenVibe.Live's database.
 *
 *   node scripts/import-from-live.js --live-db /path/to/live-snapshot.db [--ai-db ./data/ai.db] [--dry-run]
 *
 * Reads the Live snapshot READ-ONLY. Idempotent: every imported source row is recorded in
 * import_ledger (source, key, content hash), so a second run imports nothing new and a changed
 * setting is applied once. Rows this service cannot represent are recorded in import_holds with a
 * reason — never silently dropped, never guessed. --dry-run prints the plan and writes nothing.
 *
 * What moves (see docs/migration.md for the full table):
 *   site_settings ai_model_<role>      -> a new version of route live.<role> with that model (origin import)
 *   site_settings ai_pricing_json      -> model rows with cost metadata for provider `shared`
 *   site_settings ai_max_cost_usd_per_day          -> quota global/day max_cost_usd
 *   site_settings ai_viewers_global_cap_usd_per_day -> quota global/day max_cost_usd, workflow_prefix live.viewers.
 *   site_settings ai_provider / ai_base_url / ai_model / ai_api_key -> HELD: these are environment
 *        (AI_PROVIDER, AI_BASE_URL, AI_MODEL, AI_API_KEY); the script prints which names to set, never values of secrets
 *   ai_usage                           -> usage_daily (per day, requester service:live, attribution live:user:<owner>,
 *                                         workflow by Live kind), plus today's quota windows
 *   channel_ai_config                  -> attribution quota live:user:<id>/day for live.viewers.* (shared key budgets);
 *                                         BYO keys are HELD (per-actor provider secrets are not stored here yet)
 *   translations, ai_timeline_cache, ai_chatbot_configs -> HELD (one row each; reasons in the hold)
 * Everything else AI-shaped in Live (stream_memories, streamer_overviews, stream_recaps, vod/clip_ai_state,
 * chat_ai_summaries, channel_ai_bots, ai_viewer_*) is Live product state and stays in Live.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { load } = require('../server/config');
const { openDb } = require('../server/db');
const { createRegistry } = require('../server/registry');
const { createQuotas } = require('../server/quota');
const { seed } = require('../server/workflows/seed');
const { KIND_TO_WORKFLOW } = require('../server/workflows/live');
const { sha256, iso } = require('../server/util');

/** Live ai_usage.kind -> the workflow that now does that job. */
const KIND_MAP = {
    ...KIND_TO_WORKFLOW,
    translate: 'live.translate', paste_image: 'live.paste.describe_image', moment_frame: 'live.paste.describe_image', paste_text: 'live.paste.summarize_text',
    stream_memory: 'live.stream.summarize', streamer_overview: 'live.streamer.overview', media_overview: 'live.media.overview', stream_recap: 'live.stream.recap',
    site_copy: 'network.site_copy',
};
const ROLES = ['chat', 'vision', 'director', 'summary'];

function parseArgs(argv) {
    const out = { dryRun: false, liveDb: null, aiDb: null, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--quiet') out.quiet = true;
        else if (a === '--live-db') out.liveDb = argv[++i];
        else if (a === '--ai-db') out.aiDb = argv[++i];
        else if (a === '-h' || a === '--help') out.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

function hasTable(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function run({ liveDb, aiDb, dryRun = false, env = process.env, log = console.log, now = Date.now() } = {}) {
    if (!liveDb || !fs.existsSync(liveDb)) throw new Error('--live-db <snapshot> is required and must exist');
    const live = new Database(liveDb, { readonly: true, fileMustExist: true });
    const config = load({ ...env, AI_DB_PATH: aiDb || env.AI_DB_PATH || './data/ai.db' });
    const aiPath = path.resolve(config.dbPath);

    // Dry run: never create or write the AI database; read its ledger if it already exists.
    let db = null;
    let registry = null;
    let quotas = null;
    if (!dryRun) {
        db = openDb(aiPath);
        registry = createRegistry(db, { env });
        quotas = createQuotas(db, { registry });
        seed({ registry, quotas, config, env, db });
    } else if (fs.existsSync(aiPath)) {
        db = new Database(aiPath, { readonly: true, fileMustExist: true });
    }
    const ledgerGet = (source, key) => (db && hasTable(db, 'import_ledger') ? db.prepare('SELECT target FROM import_ledger WHERE source = ? AND source_key = ?').get(source, String(key)) : null);
    const holdGet = (source, key) => (db && hasTable(db, 'import_holds') ? db.prepare('SELECT 1 FROM import_holds WHERE source = ? AND source_key = ?').get(source, String(key)) : null);
    const stats = {};
    const bump = (source, what, n = 1) => { stats[source] = stats[source] || { imported: 0, unchanged: 0, held: 0 }; stats[source][what] += n; };
    const ledger = (source, key, target) => { if (!dryRun) db.prepare('INSERT OR REPLACE INTO import_ledger (source, source_key, target, imported_at) VALUES (?, ?, ?, ?)').run(source, String(key), target, iso(now)); };
    const hold = (source, key, reason, detail = null) => {
        if (holdGet(source, key)) return bump(source, 'unchanged');
        if (!dryRun) db.prepare('INSERT OR REPLACE INTO import_holds (source, source_key, reason, detail, held_at) VALUES (?, ?, ?, ?, ?)').run(source, String(key), reason, detail, iso(now));
        bump(source, 'held');
    };
    /** Apply once per (source, key, content): unchanged content is skipped on re-runs. */
    const once = (source, key, content, apply) => {
        const h = sha256(content);
        const prev = ledgerGet(source, key);
        if (prev && prev.target.endsWith(`#${h}`)) return bump(source, 'unchanged');
        const target = dryRun ? 'dry-run' : apply();
        ledger(source, key, `${target}#${h}`);
        bump(source, 'imported');
    };

    // ── site_settings ──
    const settings = hasTable(live, 'site_settings') ? Object.fromEntries(live.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'ai_%'").all().map(r => [r.key, r.value])) : {};
    const envAdvice = [];
    for (const [k, envName] of [['ai_provider', 'AI_PROVIDER'], ['ai_base_url', 'AI_BASE_URL'], ['ai_model', 'AI_MODEL'], ['ai_enabled', 'AI_ENABLED'], ['ai_input_cost_per_mtok', 'AI_INPUT_COST_PER_MTOK'], ['ai_output_cost_per_mtok', 'AI_OUTPUT_COST_PER_MTOK']]) {
        if (settings[k] != null && settings[k] !== '') { envAdvice.push(`${envName}=${settings[k]}`); hold('live.site_settings', k, 'environment', `set ${envName} in /etc/openvibe/ai.env`); }
    }
    if (settings.ai_api_key) {
        envAdvice.push('AI_API_KEY=<copy the value of Live\'s ai_api_key setting; not printed>');
        hold('live.site_settings', 'ai_api_key', 'secret', 'secrets are environment references (env:AI_API_KEY); set it in /etc/openvibe/ai.env');
    }
    for (const role of ROLES) {
        const m = String(settings[`ai_model_${role}`] || '').trim();
        if (!m) continue;
        once('live.site_settings', `ai_model_${role}`, m, () => {
            const cur = registry.getRoute(`live.${role}`);
            const v = registry.createRouteVersion(`live.${role}`, { primary: { provider: 'shared', model: m }, fallbacks: cur ? cur.fallbacks : [] }, { actor: 'import' });
            return `route:live.${role}@${v.version}`;
        });
    }
    if (settings.ai_pricing_json) {
        let table = null;
        try { table = JSON.parse(settings.ai_pricing_json); } catch { table = null; }
        if (!table || typeof table !== 'object') hold('live.site_settings', 'ai_pricing_json', 'unparseable', 'not JSON');
        else {
            for (const [model, p] of Object.entries(table)) {
                if (model === 'default' || !p || typeof p !== 'object') { hold('live.site_settings', `ai_pricing_json.${model}`, 'environment', 'prefix/default pricing stays in AI_PRICING_JSON'); continue; }
                once('live.site_settings', `ai_pricing_json.${model}`, p, () => {
                    registry.upsertModel({ provider_key: 'shared', model_key: model, type: 'chat', cost: { in_per_mtok: Number(p.in), out_per_mtok: Number(p.out), cached_per_mtok: p.cached != null ? Number(p.cached) : null }, metadata: { imported_from: 'live.ai_pricing_json' } }, { actor: 'import' });
                    return `model:shared/${model}`;
                });
            }
        }
    }
    const cap = Number(settings.ai_max_cost_usd_per_day);
    if (cap > 0) once('live.site_settings', 'ai_max_cost_usd_per_day', cap, () => `quota:${quotas.upsert({ scope_type: 'global', window: 'day', max_cost_usd: cap }, { actor: 'import', origin: 'import' }).id}`);
    const vcap = Number(settings.ai_viewers_global_cap_usd_per_day);
    if (vcap > 0) once('live.site_settings', 'ai_viewers_global_cap_usd_per_day', vcap, () => `quota:${quotas.upsert({ scope_type: 'global', window: 'day', max_cost_usd: vcap, workflow_prefix: 'live.viewers.' }, { actor: 'import', origin: 'import' }).id}`);

    // ── ai_usage -> usage_daily (+ today's windows) ──
    if (hasTable(live, 'ai_usage')) {
        const cols = live.prepare('PRAGMA table_info(ai_usage)').all().map(c => c.name);
        const has = (c) => cols.includes(c);
        const rows = live.prepare(`SELECT id, kind, model, input_tokens, output_tokens, cost_usd, created_at,
            ${has('owner_user_id') ? 'owner_user_id' : 'NULL AS owner_user_id'}, ${has('cached_tokens') ? 'cached_tokens' : '0 AS cached_tokens'}, ${has('provider') ? 'provider' : "'shared' AS provider"}
            FROM ai_usage ORDER BY id`).all();
        const today = iso(now).slice(0, 10);
        const dayStart = Math.floor(now / 86400000) * 86400;
        const insDaily = db && !dryRun ? db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, tokens_cached, cost_usd)
            VALUES (?, 'service:live', ?, ?, ?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT(day, requester, attribution, workflow_key, provider_key, model_key) DO UPDATE SET requests = requests + 1,
              tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, tokens_cached = tokens_cached + excluded.tokens_cached, cost_usd = cost_usd + excluded.cost_usd`) : null;
        const insCounter = db && !dryRun ? db.prepare(`INSERT INTO usage_counters (scope_type, scope_id, window, window_start, workflow_prefix, requests, tokens, cost_usd) VALUES (?, ?, 'day', ?, '', 1, ?, ?)
            ON CONFLICT(scope_type, scope_id, window, window_start, workflow_prefix) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd`) : null;
        const tx = (fn) => (db && !dryRun ? db.transaction(fn)() : fn());
        tx(() => {
            for (const r of rows) {
                if (ledgerGet('live.ai_usage', r.id)) { bump('live.ai_usage', 'unchanged'); continue; }
                const day = String(r.created_at || '').slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { hold('live.ai_usage', r.id, 'unrepresentable', 'no valid created_at'); continue; }
                const wf = KIND_MAP[r.kind] || 'live.complete';
                const attribution = r.owner_user_id ? `live:user:${r.owner_user_id}` : '';
                const provider = r.provider === 'byo' ? 'live-byo' : 'shared';
                const tokens = (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0);
                if (!dryRun) {
                    insDaily.run(day, attribution, wf, provider, r.model || '', Number(r.input_tokens) || 0, Number(r.output_tokens) || 0, Number(r.cached_tokens) || 0, Number(r.cost_usd) || 0);
                    if (day === today && provider === 'shared') {
                        insCounter.run('global', '*', dayStart, tokens, Number(r.cost_usd) || 0);
                        insCounter.run('service', 'live', dayStart, tokens, Number(r.cost_usd) || 0);
                        if (attribution) insCounter.run('attribution', attribution, dayStart, tokens, Number(r.cost_usd) || 0);
                    }
                }
                ledger('live.ai_usage', r.id, `usage_daily:${day}/${wf}#`);
                bump('live.ai_usage', 'imported');
            }
        });
    }

    // ── channel_ai_config -> per-streamer AI-viewer budgets; BYO keys held ──
    if (hasTable(live, 'channel_ai_config')) {
        for (const c of live.prepare('SELECT user_id, use_shared_key, daily_budget_cents, byo_key, byo_base_url FROM channel_ai_config').all()) {
            if (Number(c.use_shared_key) === 1 || c.use_shared_key == null) {
                const usd = (Number(c.daily_budget_cents) || 0) / 100;
                if (usd <= 0) { bump('live.channel_ai_config', 'unchanged'); continue; }
                once('live.channel_ai_config', c.user_id, usd, () => `quota:${quotas.upsert({ scope_type: 'attribution', scope_id: `live:user:${c.user_id}`, window: 'day', max_cost_usd: usd, workflow_prefix: 'live.viewers.' }, { actor: 'import', origin: 'import' }).id}`);
            } else {
                let host = '';
                try { host = c.byo_base_url ? new URL(c.byo_base_url).host : ''; } catch { host = ''; }
                hold('live.channel_ai_config', c.user_id, 'byo_provider', `streamer ${c.user_id} uses their own ${c.byo_key ? 'key' : 'self-hosted endpoint'}${host ? ` (${host})` : ''}; BYO providers keep running in Live (llm.js provider override) until per-actor provider secrets exist here`);
            }
        }
    }

    // ── Whole-table holds ──
    const tableHold = (table, reason, detail) => {
        if (!hasTable(live, table)) return;
        const n = live.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        hold(`live.${table}`, '*', reason, `${n} row(s): ${detail}`);
    };
    tableHold('translations', 'unrepresentable', 'keyed by sha1(from|to|text) without the source text, so they cannot become input-hashed cache entries; Live keeps them as its local read-through cache and new translations are cached here per service');
    tableHold('ai_timeline_cache', 'stays_in_live', 'an assembled Live read model (no model output); Live keeps serving it');
    tableHold('ai_chatbot_configs', 'superseded', 'Live already migrated these rows into channel_ai_config');

    live.close();
    if (db) db.close();
    const report = { dry_run: dryRun, ai_db: aiPath, sources: stats, environment: envAdvice };
    log(JSON.stringify(report, null, 2));
    return report;
}

if (require.main === module) {
    require('dotenv').config();
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    if (args.help || !args.liveDb) {
        console.error('usage: node scripts/import-from-live.js --live-db <snapshot.db> [--ai-db <ai.db>] [--dry-run]');
        process.exit(args.help ? 0 : 2);
    }
    try { run({ liveDb: args.liveDb, aiDb: args.aiDb, dryRun: args.dryRun }); } catch (e) { console.error(`[import] ${e.message}`); process.exit(1); }
}

module.exports = { run, KIND_MAP };
