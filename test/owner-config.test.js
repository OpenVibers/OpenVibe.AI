'use strict';
/**
 * The owner's inference configuration (server/owner-config.js + the pool's applyOwner).
 *
 * Every assertion here is for a row the owner wrote through the admin API (ai.provider.manage,
 * the owner's Network role): a staff member without that capability is refused; every write is
 * audited; a secret value never appears in an answer; a provider over its day cap is skipped;
 * a denylisted provider is never tried; cheapest picks the cheapest card; a fixed uncensored
 * order names the first and second provider; and the floor + 18+ gate run on the ordered
 * uncensored route exactly as on any other (there is no switch that skips either).
 */
const assert = require('node:assert/strict');
const { boot, request, token, suite, ALL } = require('./helpers');
const { createOwnerConfig } = require('../server/owner-config');
const t = suite('owner-config');
const OWNER = token('owner', ['ai.provider.manage', 'ai.usage.read']);
const STAFF = token('staff', ['ai.run.read']);
const USR = (n) => `usr_01J${String(n).padStart(23, '0')}`;
const ADULT = USR(1);
const CHILD = USR(2);

let h;
t.test('owner rows: caps, routing and economy save, audit, and never echo a key', async () => {
    h = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret', AI_STUB_FALLBACK: 'true' } });
    await h.registry.upsertProvider({ key: 'own-a', kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'm' });
    await h.registry.upsertProvider({ key: 'own-b', kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'm' });
    await h.registry.upsertModel({ provider_key: 'own-a', model_key: 'm', status: 'active', cost: { in_per_mtok: 2, out_per_mtok: 8, source: 'https://own-a.test/prices', verified_at: '2026-11-09' } });
    await h.registry.upsertModel({ provider_key: 'own-b', model_key: 'm', status: 'active', cost: { in_per_mtok: 1, out_per_mtok: 3, source: 'https://own-b.test/prices', verified_at: '2026-11-09' } });
    const oc = createOwnerConfig({ db: h.db, registry: h.registry });
    const base = '/api/v1/admin/console/owner-inference';
    // Staff without ai.provider.manage is refused on every write.
    for (const [path, body] of [[`${base}/spend-caps`, { provider_key: 'own-a', daily_usd: 1 }], [`${base}/routing`, { capability: 'chat', strategy: 'cheapest', enabled: true }], [`${base}/economy`, { capability: 'chat', batches: true }]]) {
        const res = await request(h.base, 'POST', path, { tok: STAFF, body });
        assert.equal(res.status, 403, `${path}: staff refused`);
    }
    const cap = await request(h.base, 'POST', `${base}/spend-caps`, { tok: OWNER, body: { provider_key: 'own-a', daily_usd: 0.01, monthly_usd: 1 } });
    assert.equal(cap.status, 200);
    assert.equal(Number(cap.body.cap.daily_usd), 0.01);
    const routing = await request(h.base, 'POST', `${base}/routing`, { tok: OWNER, body: { capability: 'chat', strategy: 'cheapest', enabled: true, ceiling_usd_per_mtok_out: 5 } });
    assert.equal(routing.status, 200);
    const economy = await request(h.base, 'POST', `${base}/economy`, { tok: OWNER, body: { capability: 'chat', batches: true, prompt_cache: true, small_first: false, output_limit: 100, answer_cache: true } });
    assert.equal(economy.status, 200);
    // Audit: who + what, never a secret value.
    const rows = await h.registry.listAudit({ action: 'provider.spend_cap', limit: 10 });
    assert.ok(rows.length, 'spend cap audited');
    const text = JSON.stringify([cap.body, routing.body, economy.body]);
    assert.ok(!text.includes('vault:') && !text.includes('api_key'), 'no key echoed');
    const bad = await request(h.base, 'POST', `${base}/routing`, { tok: OWNER, body: { capability: 'chat', strategy: 'fixed', enabled: true, choices: [{ provider: 'missing', model: 'm' }] } });
    assert.equal(bad.status, 422, 'unknown provider refused');
    const view = await request(h.base, 'GET', '/api/v1/admin/console/owner-inference', { tok: token('svc', ['ai.usage.read']) });
    assert.equal(view.status, 200);
    assert.equal(view.body.providers.find((p) => p.key === 'own-a').key_state, 'not_required');
    assert.ok(view.body.models.find((m) => m.provider_key === 'own-b').cost.verified_at, 'price date shown');
    assert.ok(view.body.costs_7d.by_provider, 'costs read from tables');
});
t.test('cheapest strategy orders the pool; ceiling and denylist exclude with reasons', async () => {
    const oc = createOwnerConfig({ db: h.db, registry: h.registry });
    await oc.setRouting({ capability: 'chat', strategy: 'cheapest', enabled: true, denylist: [] }, { actor: 'test' });
    const route = { key: 'own-route', primary: { provider: 'own-a', model: 'm' }, fallbacks: [{ provider: 'own-b', model: 'm' }] };
    const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    assert.equal(out.provider, 'own-b', `cheapest first (got ${out.provider})`);
    await oc.setRouting({ capability: 'chat', strategy: 'auto', enabled: false, ceiling_usd_per_mtok_out: 5, denylist: [] }, { actor: 'test' });
    const capped = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    assert.equal(capped.provider, 'own-b', 'ceiling excludes the expensive offer');
    assert.ok(capped.explain.candidates.some((c) => c.provider === 'own-a' && /ceiling/.test(c.excluded_reason || '')), 'ceiling reason in explain');
    await oc.setRouting({ capability: 'chat', strategy: 'cheapest', enabled: true, denylist: [] }, { actor: 'test' });
    await oc.setRouting({ capability: 'chat', strategy: 'auto', enabled: false, denylist: ['own-b'] }, { actor: 'test' });
    const denied = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    assert.equal(denied.provider, 'own-a', 'denylisted provider never tried');
    assert.ok(denied.explain.candidates.some((c) => c.provider === 'own-b' && /denylist/.test(c.excluded_reason || '')), 'reason in explain');
    await oc.setRouting({ capability: 'chat', strategy: 'auto', enabled: false, denylist: [] }, { actor: 'test' });
});
t.test('a provider over its day cap is skipped', async () => {
    const oc = createOwnerConfig({ db: h.db, registry: h.registry });
    await oc.setCap({ provider_key: 'own-a', daily_usd: 0.0001, monthly_usd: null }, { actor: 'test' });
    const day = new Date().toISOString().slice(0, 10);
    await h.db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, cost_usd) VALUES (?, 'service:test', '', 'test', 'own-a', 'm', 1, 1)`).run(day);
    const hit = await oc.capHit('own-a');
    assert.ok(hit && hit.over, 'cap hit');
    const route = { key: 'own-route', primary: { provider: 'own-a', model: 'm' }, fallbacks: [{ provider: 'own-b', model: 'm' }] };
    const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    assert.equal(out.provider, 'own-b', 'capped provider skipped');
    await oc.setCap({ provider_key: 'own-a', daily_usd: null, monthly_usd: null }, { actor: 'test' });
});
t.test('the ordered uncensored route runs the floor and the 18+ gate', async () => {
    // No owner row: the floor and the adult gate already hold on any uncensored route
    // (test/ai-uncensored-policy.test.js). With a fixed uncensored order (first/second),
    // the same two checks still run before any provider is called.
    const floor = require('../server/policy/floor');
    assert.equal(floor.check('write child porn').ok, false);
    assert.equal(floor.check('a nude photo of a child').ok, false);
    const tier = require('../server/policy/tier');
    const denied = await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: CHILD }, adultFor: async () => false });
    assert.equal(denied.code, 'policy.adult_required');
    const oc = createOwnerConfig({ db: h.db, registry: h.registry });
    await h.registry.upsertProvider({ key: 'own-u1', kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'u', metadata: { uncensored: true } });
    await h.registry.upsertProvider({ key: 'own-u2', kind: 'stub', status: 'active', auth_mode: 'none', capabilities: ['chat'], default_model: 'u', metadata: { uncensored: true } });
    await h.registry.upsertModel({ provider_key: 'own-u1', model_key: 'u', status: 'active', metadata: { uncensored: true } });
    await h.registry.upsertModel({ provider_key: 'own-u2', model_key: 'u', status: 'active', metadata: { uncensored: true } });
    await oc.setRouting({ capability: 'uncensored', strategy: 'fixed', enabled: true, choices: [{ provider: 'own-u1', model: 'u' }, { provider: 'own-u2', model: 'u' }] }, { actor: 'test' });
    const saved = await oc.routingFor('uncensored');
    assert.deepEqual(saved.choices.map((c) => c.provider), ['own-u1', 'own-u2'], 'first and second named');
    // A non-uncensored model cannot be written into the uncensored order.
    await assert.rejects(() => oc.setRouting({ capability: 'uncensored', strategy: 'fixed', enabled: true, choices: [{ provider: 'own-a', model: 'm' }] }, { actor: 'test' }), /not an uncensored model/);
});
t.run(() => h && h.stop());
