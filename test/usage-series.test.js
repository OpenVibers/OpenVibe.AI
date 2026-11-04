'use strict';
// GET /api/v1/usage/series: aggregate demand for Host's inference planner. Per UTC day and model only —
// requests, successes and the four token totals — never a person, app, project, prompt or answer.
// The table rows are inserted directly because the point is the query, not the run that wrote them.

const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');

const t = suite('usage-series');
const clock = { now: () => Date.parse('2026-11-03T12:00:00Z') };
const TODAY = '2026-11-03';
const YESTERDAY = '2026-11-02';
const OLD = '2026-10-20';            // inside 30 days
const OUTSIDE = '2026-08-01';        // outside 30 days
let h;

const addStats = (day, provider, model, { requests, ok, errors = 0, tokensIn = 0, tokensOut = 0 }) =>
    h.db.prepare(`INSERT INTO provider_stats_daily (day, provider, model, requests, ok, errors, tokens_in, tokens_out)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(day, provider, model, requests, ok, errors, tokensIn, tokensOut);

const addUsage = (day, requester, attribution, workflow, provider, model, cached) =>
    h.db.prepare(`INSERT INTO usage_daily (day, requester, attribution, workflow_key, provider_key, model_key, requests, tokens_in, tokens_out, tokens_cached, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`).run(day, requester, attribution, workflow, provider, model, cached * 2, cached, cached);

async function series(query = '') {
    return await request(h.base, 'GET', `/api/v1/usage/series${query}`, { tok: token('planner', ['ai.usage.read']) });
}

t.test('boot with the aggregate demand feed on and two models, one with exact-id metadata', async () => {
    h = await boot({ clock, env: { AI_USAGE_SERIES: 'on' } });
    const now = new Date(clock.now()).toISOString();
    await h.db.prepare(`INSERT INTO models (provider_key, model_key, type, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'chat', 'active', ?, ?, ?), (?, ?, 'chat', 'active', ?, ?, ?)`)
        .run('openai', 'gpt-4o-mini', JSON.stringify({ revision: '3f2a1c9' }), now, now,
            'anthropic', 'claude-sonnet-4-5', '{}', now, now);
    // Provider attempts once rolled up (a retry would be a second attempt): today and yesterday.
    await addStats(TODAY, 'openai', 'gpt-4o-mini', { requests: 3, ok: 2, errors: 1, tokensIn: 1000, tokensOut: 200 });
    await addStats(TODAY, 'anthropic', 'claude-sonnet-4-5', { requests: 1, ok: 1, tokensIn: 5000, tokensOut: 100 });
    await addStats(YESTERDAY, 'openai', 'gpt-4o-mini', { requests: 4, ok: 4, tokensIn: 2000, tokensOut: 400 });
    await addStats(OLD, 'openai', 'gpt-4o-mini', { requests: 1, ok: 1, tokensIn: 10, tokensOut: 1 });
    await addStats(OUTSIDE, 'openai', 'gpt-4o-mini', { requests: 99, ok: 99, tokensIn: 1, tokensOut: 1 });
    // Two callers, a service and an app, on the same model and day: their cache reads aggregate.
    await addUsage(TODAY, 'service:live', 'live:user:42', 'live.translate', 'openai', 'gpt-4o-mini', 100);
    await addUsage(TODAY, 'app:app_01J8', '', 'app.summarise', 'openai', 'gpt-4o-mini', 50);
    await addUsage(TODAY, 'service:live', '', 'live.translate', 'anthropic', 'claude-sonnet-4-5', 500);
    await addUsage(OUTSIDE, 'service:live', '', 'live.translate', 'openai', 'gpt-4o-mini', 777);
});

t.test('the shape: per day and model, four token totals, success count, and no caller or text', async () => {
    const r = await series('?days=30');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.days, 30);
    assert.strictEqual(r.body.to, TODAY);
    assert.strictEqual(r.body.from, '2026-10-05');
    assert.match(r.body.note, /cache_write/);
    assert.ok(Array.isArray(r.body.series));

    const today = r.body.series.filter((x) => x.day === TODAY);
    const openai = today.find((x) => x.provider === 'openai');
    assert.deepStrictEqual(openai, {
        day: TODAY,
        model: 'openai/gpt-4o-mini@3f2a1c9',
        provider: 'openai',
        model_key: 'gpt-4o-mini',
        requests: 3,
        successes: 2,
        tokens: { input: 850, cached_read: 150, cache_write: 0, output: 200 },
    });
    const anthropic = today.find((x) => x.provider === 'anthropic');
    assert.strictEqual(anthropic.model, 'anthropic/claude-sonnet-4-5', 'no artifact revision: provider/model');
    assert.strictEqual(anthropic.requests, 1);
    assert.strictEqual(anthropic.successes, 1);
    assert.deepStrictEqual(anthropic.tokens, { input: 4500, cached_read: 500, cache_write: 0, output: 100 });
    assert.strictEqual(r.body.series.find((x) => x.day === YESTERDAY).requests, 4);

    // The caller rows (a service and an app) are one number here: no person, app, project or cost, and
    // no prompt or answer text.
    const text = JSON.stringify(r.body.series);
    for (const forbidden of ['requester', 'attribution', 'project', 'prompt', 'answer', 'cost', 'live:user:42', 'app_01J8']) {
        assert.ok(!text.includes(forbidden), `the aggregate carries no ${forbidden}`);
    }
    assert.ok(!r.body.series.some((x) => x.day === OUTSIDE), 'outside the requested window');
});

t.test('days is an integer from 1 to 90', async () => {
    assert.strictEqual((await series()).body.days, 30, 'default 30');
    assert.strictEqual((await series('?days=1')).body.days, 1);
    assert.strictEqual((await series('?days=90')).body.days, 90);
    for (const q of ['?days=0', '?days=91', '?days=abc', '?days=1.5', '?days=-1']) {
        const r = await series(q);
        assert.strictEqual(r.status, 422, q);
        assert.strictEqual(r.body.code, 'ai.invalid', q);
    }
});

t.test('the capability gate: ai.usage.read, or 401 without a token', async () => {
    const denied = await request(h.base, 'GET', '/api/v1/usage/series?days=30', { tok: token('planner', ['ai.run.read']) });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'capability.denied');
    const missing = await request(h.base, 'GET', '/api/v1/usage/series?days=30');
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(missing.body.code, 'token.missing');
});

t.test('AI_USAGE_SERIES off: the route is absent', async () => {
    const off = await boot({ clock, env: { AI_USAGE_SERIES: 'off' } });
    try {
        const r = await request(off.base, 'GET', '/api/v1/usage/series?days=30', { tok: token('planner', ['ai.usage.read']) });
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.body.code, 'ai.not_found');
    } finally { await off.close(); }
});

(async () => { await t.run(); })();
