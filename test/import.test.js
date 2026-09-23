'use strict';
// scripts/import-from-live.js against a synthetic Live snapshot: --dry-run writes nothing; a real
// run imports usage, budgets, per-role models and pricing, and holds what cannot be represented
// (secrets, BYO keys, text-less translation cache); a second run imports nothing; a new Live row
// is picked up alone. Secret values never appear in the report or the holds.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { suite, tmpDir } = require('./helpers');
const { run } = require('../scripts/import-from-live');

const t = suite('import');
const dir = tmpDir();
const liveDb = path.join(dir, 'live-snapshot.db');
const aiDb = path.join(dir, 'ai.db');
const SECRET = 'sk-live-snapshot-secret-DO-NOT-PRINT';
const env = { NODE_ENV: 'test', AI_QUOTA_SERVICE_RPM: '0', AI_QUOTA_SERVICE_RPD: '0' };
const quiet = () => {};
const today = new Date().toISOString().slice(0, 10);

t.test('build a Live snapshot', () => {
    const d = new Database(liveDb);
    d.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT, type TEXT, updated_at DATETIME);
        CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, owner_user_id INTEGER, source TEXT, created_at DATETIME, cached_tokens INTEGER, role TEXT, provider TEXT, latency_ms INTEGER);
        CREATE TABLE channel_ai_config (user_id INTEGER PRIMARY KEY, enabled INTEGER, use_shared_key INTEGER, daily_budget_cents INTEGER, byo_key TEXT, byo_base_url TEXT, byo_model TEXT, settings_json TEXT);
        CREATE TABLE translations (key TEXT PRIMARY KEY, src TEXT, dst TEXT, text TEXT NOT NULL, created_at DATETIME);
        CREATE TABLE ai_timeline_cache (user_id INTEGER PRIMARY KEY, payload TEXT, generated_at DATETIME);
        CREATE TABLE ai_chatbot_configs (user_id INTEGER PRIMARY KEY, api_token TEXT);`);
    const set = d.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
    for (const [k, v] of [['ai_enabled', 'true'], ['ai_provider', 'openai'], ['ai_api_key', SECRET], ['ai_model', 'gpt-5-mini'], ['ai_model_director', 'gpt-5'], ['ai_model_vision', ''],
        ['ai_pricing_json', '{"gpt-5-nano":{"in":0.05,"out":0.4,"cached":0.005},"default":{"in":1,"out":2}}'], ['ai_max_cost_usd_per_day', '5'], ['ai_viewers_global_cap_usd_per_day', '2']]) set.run(k, v);
    const use = d.prepare('INSERT INTO ai_usage (kind, model, input_tokens, output_tokens, cost_usd, owner_user_id, created_at, cached_tokens, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    use.run('translate', 'gpt-5-nano', 100, 20, 0.01, null, `${today} 10:00:00`, 0, 'shared');
    use.run('ai_viewers_director', 'gpt-5', 1000, 200, 0.2, 42, `${today} 10:01:00`, 500, 'shared');
    use.run('ai_viewers', 'llama3', 50, 10, 0, 7, '2026-09-01 08:00:00', 0, 'byo');
    use.run('weird_kind', 'gpt-5-mini', 10, 10, 0.001, null, '2026-09-02 08:00:00', 0, 'shared');
    use.run('paste_text', 'gpt-5-mini', 10, 10, 0.001, null, 'garbage', 0, 'shared');
    const ch = d.prepare('INSERT INTO channel_ai_config (user_id, use_shared_key, daily_budget_cents, byo_key, byo_base_url) VALUES (?, ?, ?, ?, ?)');
    ch.run(42, 1, 20, '', '');
    ch.run(7, 0, 20, 'sk-byo-streamer-secret', 'https://llm.example.org/v1');
    d.prepare("INSERT INTO translations (key, src, dst, text) VALUES ('abc', 'ja', 'en', 'hello')").run();
    d.close();
});

t.test('--dry-run reports the plan and writes nothing', () => {
    const r = run({ liveDb, aiDb, dryRun: true, env, log: quiet });
    assert.strictEqual(r.dry_run, true);
    assert.strictEqual(fs.existsSync(aiDb), false, 'no AI database created');
    assert.strictEqual(r.sources['live.ai_usage'].imported, 4);
    assert.strictEqual(r.sources['live.ai_usage'].held, 1);
    assert.ok(!JSON.stringify(r).includes(SECRET));
});

t.test('a real run imports and holds, without leaking secrets', () => {
    const r = run({ liveDb, aiDb, env, log: quiet });
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes('sk-byo'));
    assert.ok(r.environment.some(l => l.startsWith('AI_API_KEY=<')), 'tells the operator which secret NAME to set');
    const d = new Database(aiDb, { readonly: true });
    const quotas = d.prepare('SELECT * FROM quotas WHERE origin = ?').all('import');
    assert.ok(quotas.some(q => q.scope_type === 'global' && q.max_cost_usd === 5 && !q.workflow_prefix));
    assert.ok(quotas.some(q => q.scope_type === 'global' && q.max_cost_usd === 2 && q.workflow_prefix === 'live.viewers.'));
    assert.ok(quotas.some(q => q.scope_type === 'attribution' && q.scope_id === 'live:user:42' && q.max_cost_usd === 0.2));
    const route = d.prepare("SELECT * FROM routes WHERE key = 'live.director' ORDER BY version DESC LIMIT 1").get();
    assert.strictEqual(route.primary_model, 'gpt-5');
    assert.strictEqual(route.created_by, 'import');
    const model = d.prepare("SELECT * FROM models WHERE provider_key = 'shared' AND model_key = 'gpt-5-nano'").get();
    assert.strictEqual(model.cost_in_per_mtok, 0.05);
    const usage = d.prepare('SELECT * FROM usage_daily').all();
    assert.ok(usage.some(u => u.workflow_key === 'live.translate' && u.day === today));
    assert.ok(usage.some(u => u.workflow_key === 'live.viewers.plan' && u.attribution === 'live:user:42' && u.tokens_cached === 500));
    assert.ok(usage.some(u => u.provider_key === 'live-byo'));
    assert.ok(usage.some(u => u.workflow_key === 'live.complete'), 'unknown kinds land on live.complete');
    const counter = d.prepare("SELECT * FROM usage_counters WHERE scope_type = 'global' AND window = 'day'").get();
    assert.ok(Math.abs(counter.cost_usd - 0.21) < 1e-9, "today's spend counts toward today's cap");
    const holds = d.prepare('SELECT * FROM import_holds').all();
    const reasons = Object.fromEntries(holds.map(h => [`${h.source}:${h.source_key}`, h.reason]));
    assert.strictEqual(reasons['live.site_settings:ai_api_key'], 'secret');
    assert.strictEqual(reasons['live.channel_ai_config:7'], 'byo_provider');
    assert.strictEqual(reasons['live.translations:*'], 'unrepresentable');
    assert.strictEqual(reasons['live.ai_usage:5'], 'unrepresentable');
    assert.ok(!JSON.stringify(holds).includes(SECRET) && !JSON.stringify(holds).includes('sk-byo'));
    d.close();
});

t.test('a second run imports nothing and changes no totals', () => {
    const before = new Database(aiDb, { readonly: true });
    const sum = (x) => x.prepare('SELECT SUM(requests) r, SUM(cost_usd) c FROM usage_daily').get();
    const s1 = sum(before);
    before.close();
    const r = run({ liveDb, aiDb, env, log: quiet });
    for (const [src, s] of Object.entries(r.sources)) assert.strictEqual(s.imported + s.held, 0, `${src} imported again: ${JSON.stringify(s)}`);
    const after = new Database(aiDb, { readonly: true });
    assert.deepStrictEqual(sum(after), s1);
    assert.strictEqual(after.prepare("SELECT COUNT(*) n FROM routes WHERE key = 'live.director'").get().n, 2, 'no extra route version');
    after.close();
});

t.test('new Live rows and changed settings are picked up alone', () => {
    const d = new Database(liveDb);
    d.prepare("INSERT INTO ai_usage (kind, model, input_tokens, output_tokens, cost_usd, created_at, provider) VALUES ('hero_slogans', 'gpt-5-mini', 5, 5, 0.002, ?, 'shared')").run(`${today} 11:00:00`);
    d.prepare("UPDATE site_settings SET value = '8' WHERE key = 'ai_max_cost_usd_per_day'").run();
    d.close();
    const r = run({ liveDb, aiDb, env, log: quiet });
    assert.strictEqual(r.sources['live.ai_usage'].imported, 1);
    assert.strictEqual(r.sources['live.site_settings'].imported, 1);
    const a = new Database(aiDb, { readonly: true });
    assert.strictEqual(a.prepare("SELECT max_cost_usd FROM quotas WHERE scope_type = 'global' AND workflow_prefix IS NULL").get().max_cost_usd, 8);
    a.close();
});

t.run();
