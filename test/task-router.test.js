'use strict';
/**
 * The task-aware router (plan L33 P3 "the router picks for the task", L36 Y7 "a smarter router").
 *   - a vision request never goes to a model that cannot see: the hard needs come first;
 *   - a light job takes the cheapest capable model, a heavy one the catalogue's strength tier;
 *   - the person's free-first, price ceiling and per-kind default are respected;
 *   - a warm prompt cache wins a near tie;
 *   - the fallback chain stops after three attempts, and only_my_keys never leaves the person's keys;
 *   - the explain carries the requirement set (task), the ranked candidates and every attempt.
 */
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');

const t = suite('task-router');
const tok = token('live', ALL);
let h;

async function provider(body) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok, body: { kind: 'http', auth_mode: 'none', timeout_ms: 3000, ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
async function model(providerKey, modelKey, body) {
    const r = await request(h.base, 'POST', '/api/v1/models', { tok, body: { provider_key: providerKey, model_key: modelKey, type: 'chat', status: 'active', ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
async function route(key, body) {
    const r = await request(h.base, 'POST', '/api/v1/routes/' + key + '/versions', { tok, body });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.route;
}
const prefs = (over) => ({ only_my_keys: false, free_first: true, price_ceiling_usd_per_mtok: null, defaults: { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' }, ...(over || {}) });
const DESCRIBED = { listed: true, synced_at: '2026-10-31T00:00:00.000Z' };

t.test('a vision request never goes to a model that cannot see', async () => {
    const seer = await seamServer(() => ({ text: 'a picture of a cat', model: 'seer-m', usage: { input: 5, output: 2 } }));
    const blind = await seamServer(() => ({ text: 'I never saw it', model: 'blind-m', usage: { input: 5, output: 2 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    // Both providers serve images; the catalogue says one of the two models does not.
    await provider({ key: 'seer', base_url: seer.url, capabilities: ['chat', 'generate', 'vision', 'json'], default_model: 'seer-m' });
    await model('seer', 'seer-m', { supports: { json: true, vision: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    await provider({ key: 'blind', base_url: blind.url, capabilities: ['chat', 'generate', 'vision', 'json'], default_model: 'blind-m' });
    await model('blind', 'blind-m', { supports: { json: true, vision: false }, metadata: { tier: 'balanced', ...DESCRIBED } });
    const r = await route('test.vision', { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });

    const exec = await h.pool.execute(r, 'chat', { messages: [{ role: 'user', content: 'what is in this picture?' }], image: { base64: 'aGk=' }, timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version });
    assert.strictEqual(exec.provider, 'seer', 'the model that cannot see is never tried');
    assert.strictEqual(blind.calls, 0, 'the text-only model was never called');
    assert.strictEqual(exec.explain.task.vision, true, 'the explain says the task needed vision');
    assert.deepStrictEqual(Object.keys(exec.explain.task).sort(), ['json', 'min_context', 'output', 'reasoning', 'tools', 'vision', 'weight']);
    const c = exec.explain.candidates.find((x) => x.provider === 'blind');
    assert.strictEqual(c.eligible, false, 'the text-only model is excluded');
    assert.match(c.excluded_reason, /no_vision/);
    await h.stop(); await seer.close(); await blind.close();
});

t.test('a light job takes the cheapest capable model; a heavy one the strong tier', async () => {
    const srv = await seamServer(() => ({ text: 'an answer', model: 'm', usage: { input: 3, output: 1 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await provider({ key: 'weak', base_url: srv.url, capabilities: ['chat', 'classify', 'generate', 'json'], default_model: 'weak-m' });
    await model('weak', 'weak-m', { cost: { in_per_mtok: 1, out_per_mtok: 1 }, supports: { json: true }, metadata: { tier: 'fast', ...DESCRIBED } });
    await provider({ key: 'strong', base_url: srv.url, capabilities: ['chat', 'classify', 'generate', 'json'], default_model: 'strong-m' });
    await model('strong', 'strong-m', { cost: { in_per_mtok: 50, out_per_mtok: 50 }, supports: { json: true }, metadata: { tier: 'strong', reasoning: true, ...DESCRIBED } });
    const r = await route('test.task-fit', { capability: 'classify', constraints: { objective: 'balanced' }, timeout_ms: 3000 });

    const light = await h.pool.execute(r, 'classify', { messages: [{ role: 'user', content: 'is this positive?' }], timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version });
    assert.strictEqual(light.explain.task.weight, 'light', 'a short classification is light work');
    assert.strictEqual(light.provider, 'weak', 'a light job takes the cheapest capable model');
    assert.strictEqual(light.explain.ranked[0].provider, 'weak');
    assert.match(light.explain.ranked[0].why, /cheapest/);

    const heavy = await h.pool.execute(r, 'chat', { messages: [{ role: 'user', content: 'write the function' }], reasoning: true, maxTokens: 8000, timeoutMs: 3000 }, { routeKey: 'code.demo', routeVersion: r.version, workflowKey: 'code.demo' });
    assert.strictEqual(heavy.explain.task.weight, 'heavy', 'code with deep reasoning is heavy work');
    assert.strictEqual(heavy.explain.task.reasoning, 'deep');
    assert.strictEqual(heavy.provider, 'strong', 'a heavy job takes the strong tier, whatever it costs');
    assert.match(heavy.explain.ranked[0].why, /strong tier/);
    await h.stop(); await srv.close();
});

t.test("the person's free-first and price ceiling are respected", async () => {
    const srv = await seamServer(() => ({ text: 'an answer', model: 'm', usage: { input: 3, output: 1 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await provider({ key: 'freebie', base_url: srv.url, capabilities: ['chat', 'generate'], default_model: 'free-m', metadata: { billing_profile: 'free', paid: false } });
    await model('freebie', 'free-m', { supports: { json: true }, metadata: { tier: 'fast', ...DESCRIBED } });
    await provider({ key: 'paywall', base_url: srv.url, capabilities: ['chat', 'generate'], default_model: 'pay-m' });
    await model('paywall', 'pay-m', { cost: { in_per_mtok: 2, out_per_mtok: 20 }, supports: { json: true }, metadata: { tier: 'strong', ...DESCRIBED } });
    const r = await route('test.prefs', { capability: 'chat', constraints: { objective: 'balanced' }, timeout_ms: 3000 });
    const ctx = { routeKey: r.key, routeVersion: r.version, selfSubject: 'user:1' };
    const req = { messages: [{ role: 'user', content: 'hello' }], timeoutMs: 3000 };

    const free = await h.pool.execute(r, 'chat', req, { ...ctx, selfPreferences: prefs() });
    assert.strictEqual(free.provider, 'freebie', 'free_first puts the free tier first');

    const noFree = await h.pool.execute(r, 'chat', { ...req, messages: [{ role: 'user', content: 'third' }] }, { ...ctx, selfPreferences: prefs({ free_first: false }) });
    assert.strictEqual(noFree.provider, 'paywall', 'without free_first the strength tier leads');

    // With the free tier away, the paid model is over the person's ceiling and is never called.
    const off = await request(h.base, 'POST', '/api/v1/providers/freebie/disable', { tok });
    assert.strictEqual(off.status, 200, off.text);
    let err = null;
    try {
        await h.pool.execute(r, 'chat', { ...req, messages: [{ role: 'user', content: 'fourth' }] }, { ...ctx, selfPreferences: prefs({ price_ceiling_usd_per_mtok: 5 }) });
    } catch (e) { err = e; }
    assert.ok(err, 'nothing under the ceiling could answer');
    assert.strictEqual(err.code, 'provider.unavailable');
    const over = err.extra.explain.attempts.find((a) => a.provider === 'paywall');
    assert.ok(over && /over_price_ceiling/.test(over.error), 'the model over the ceiling is skipped with its reason');
    await h.stop(); await srv.close();
});

t.test('a warm prompt cache wins a near tie', async () => {
    const one = await seamServer(() => ({ text: 'from one', model: 'm', usage: { input: 3, output: 1 } }));
    const two = await seamServer(() => ({ text: 'from two', model: 'm', usage: { input: 3, output: 1 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await provider({ key: 'warm-one', base_url: one.url, capabilities: ['chat', 'generate'], default_model: 'w1' });
    await model('warm-one', 'w1', { cost: { in_per_mtok: 10, out_per_mtok: 10 }, supports: { json: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    await provider({ key: 'warm-two', base_url: two.url, capabilities: ['chat', 'generate'], default_model: 'w2' });
    await model('warm-two', 'w2', { cost: { in_per_mtok: 9.5, out_per_mtok: 9.5 }, supports: { json: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    const r = await route('test.warm', { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });
    const ctx = { routeKey: r.key, routeVersion: r.version, selfSubject: 'user:1' };
    const req = { messages: [{ role: 'user', content: 'the same prompt, again and again' }], timeoutMs: 3000 };

    // The cheaper provider is away, so the other one answers and its prompt cache is warm.
    const off = await request(h.base, 'POST', '/api/v1/providers/warm-two/disable', { tok });
    assert.strictEqual(off.status, 200, off.text);
    const first = await h.pool.execute(r, 'chat', req, ctx);
    assert.strictEqual(first.provider, 'warm-one', 'the one that could answer did');
    const on = await request(h.base, 'POST', '/api/v1/providers/warm-two/enable', { tok });
    assert.strictEqual(on.status, 200, on.text);

    const second = await h.pool.execute(r, 'chat', req, ctx);
    assert.strictEqual(second.provider, 'warm-one', 'the warm cache wins the near tie');
    assert.strictEqual(second.explain.ranked[0].why, 'warm cache');
    assert.ok(second.explain.ranked.length <= 5, 'the ranked list stays short');
    await h.stop(); await one.close(); await two.close();
});

t.test('the fallback chain stops after three attempts', async () => {
    const dead = await seamServer(() => ({ status: 500, body: { error: { message: 'down' } } }));
    const good = await seamServer(() => ({ text: 'never reached', model: 'm', usage: { input: 1, output: 1 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '50' } });
    for (const k of ['d1', 'd2', 'd3', 'd4']) {
        await provider({ key: k, base_url: dead.url, capabilities: ['chat', 'generate'], default_model: k + '-m' });
        await model(k, k + '-m', { cost: { in_per_mtok: 1, out_per_mtok: 1 }, supports: { json: true } });
    }
    await provider({ key: 'last', base_url: good.url, capabilities: ['chat', 'generate'], default_model: 'last-m' });
    await model('last', 'last-m', { cost: { in_per_mtok: 99, out_per_mtok: 99 }, supports: { json: true } });
    const r = await route('test.chain', { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });

    let err = null;
    try { await h.pool.execute(r, 'chat', { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version }); } catch (e) { err = e; }
    assert.ok(err, 'the chain gave up');
    assert.strictEqual(err.code, 'provider.unavailable');
    const attempts = err.extra.explain.attempts;
    assert.strictEqual(attempts.filter((a) => a.status === 'failed').length, 3, 'three attempts, no more');
    assert.ok(attempts.every((a) => a.why), 'every attempt says why it was chosen');
    assert.ok(attempts[0].error, 'a failed attempt says what went wrong');
    assert.strictEqual(good.calls, 0, 'the fourth candidate was never tried');
    await h.stop(); await dead.close(); await good.close();
});

t.test("only_my_keys never leaves the person's keys", async () => {
    const srv = await seamServer(() => ({ text: 'a network answer', model: 'm', usage: { input: 1, output: 1 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await provider({ key: 'network', base_url: srv.url, capabilities: ['chat', 'generate'], default_model: 'n-m' });
    await model('network', 'n-m', { supports: { json: true } });
    const r = await route('test.onlymine', { capability: 'chat', constraints: { objective: 'cheapest' }, timeout_ms: 3000 });

    let err = null;
    try {
        await h.pool.execute(r, 'chat', { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 3000 },
            { routeKey: r.key, routeVersion: r.version, selfSubject: 'user:1', selfPreferences: prefs({ only_my_keys: true }) });
    } catch (e) { err = e; }
    assert.ok(err, 'the run failed');
    assert.strictEqual(err.status, 422);
    assert.strictEqual(err.code, 'ai.needs_key');
    assert.strictEqual(srv.calls, 0, 'no network provider was called');
    await h.stop(); await srv.close();
});

t.test('the run carries the task and the ranked candidates', async () => {
    const srv = await seamServer(() => ({ text: 'the answer', model: 'm', usage: { input: 4, output: 2 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    await provider({ key: 'runner', base_url: srv.url, capabilities: ['chat', 'generate'], default_model: 'run-m' });
    await model('runner', 'run-m', { cost: { in_per_mtok: 1, out_per_mtok: 2 }, supports: { json: true }, metadata: { tier: 'balanced', ...DESCRIBED } });
    const res = await request(h.base, 'POST', '/api/v1/generate?wait=8000', { tok, body: { prompt: 'say something', options: { cache: false } } });
    assert.strictEqual(res.status, 201, res.text);
    const run = res.body.run;
    assert.strictEqual(run.status, 'succeeded', JSON.stringify(run).slice(0, 400));
    assert.ok(run.explain.task, 'the run explains the task it read');
    assert.strictEqual(run.explain.task.output, 'text');
    assert.ok(Array.isArray(run.explain.ranked) && run.explain.ranked.length, 'the run explains the ranked candidates');
    assert.ok(run.explain.ranked.every((x) => x.provider && x.why), 'every ranked candidate has a reason');
    assert.ok(run.explain.attempts.length && run.explain.attempts.every((a) => a.why), 'every attempt says why it was chosen');
    await h.stop(); await srv.close();
});

t.run();
