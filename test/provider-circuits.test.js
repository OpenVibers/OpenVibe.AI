'use strict';
// Provider failure classes and the per provider+model circuit (migrations/0060).
//
// The recorded shapes of every provider's error answer are replayed against a local seam (no test
// reaches the network). A balance or auth answer opens that offer's circuit at once; a run of
// transient failures opens it for 30 s doubling to 10 min; rate limits and malformed requests never
// open it. The state survives a restart, a key change resets it, the catalogue says up/degraded/down
// with a plain reason and since when, and the owner hears about a balance/auth circuit once.
const assert = require('assert');
const { boot, request, token, suite, seamServer, ALL, tmpDir } = require('./helpers');
const { ProviderError } = require('../server/providers/common');
const { classifyFailure } = require('../server/providers/failure');
const { createCatalog } = require('../server/exchange/catalog');
const fixtures = require('./fixtures/provider-failures.json');

const t = suite('provider-circuits');
const admin = token('live', ALL);

async function provider(h, body) {
    const r = await request(h.base, 'POST', '/api/v1/providers', { tok: admin, body: { kind: 'http', auth_mode: 'none', timeout_ms: 5000, capabilities: ['chat', 'generate', 'json'], ...body } });
    assert.strictEqual(r.status, 201, r.text);
}
async function model(h, providerKey, modelKey) {
    const r = await request(h.base, 'POST', '/api/v1/models', { tok: admin, body: { provider_key: providerKey, model_key: modelKey, type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 1 } } });
    assert.strictEqual(r.status, 201, r.text);
}
async function route(h, primary, fallbacks = []) {
    const r = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: admin, body: { primary, fallbacks, timeout_ms: 5000 } });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.route;
}
const ask = (h, r, logs = []) => h.pool.execute(r, 'chat', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 30, timeoutMs: 3000 }, { routeKey: r.key, routeVersion: r.version, logRequest: (e) => logs.push(e) });

t.test('every recorded provider error shape maps to the right class', async () => {
    for (const [name, fx] of Object.entries(fixtures)) {
        if (!fx || !fx.class) continue;
        const err = new ProviderError(String((fx.body && fx.body.error && fx.body.error.message) || name), { status: fx.status, body: fx.body, code: 'provider.http' });
        assert.strictEqual(classifyFailure(err).class, fx.class, `${name} is ${fx.class}, got ${JSON.stringify(classifyFailure(err))}`);
    }
    const timeout = new ProviderError('no response within 5s', { code: 'provider.timeout' });
    assert.strictEqual(classifyFailure(timeout).class, 'transient', 'a timeout is transient');
    const unreachable = new ProviderError('connection failed: fetch failed', { code: 'provider.unreachable' });
    assert.strictEqual(classifyFailure(unreachable).class, 'transient', 'a connection failure is transient');
    assert.strictEqual(classifyFailure(new ProviderError('cancelled', { code: 'provider.cancelled' })), null, 'a cancellation is not a provider failure');
    assert.strictEqual(classifyFailure(new Error('the backend fell over')).class, 'request', 'an unshaped non-retryable error is a request error');
});

t.test('balance opens only that offer: the next model answers, the owner hears once, the catalogue says down', async () => {
    const seam = await seamServer((body) => {
        if (body.model === 'model-a') return { status: 402, body: fixtures.deepseek_balance.body };
        return { text: 'from model-b', model: 'model-b', usage: { input: 3, output: 2 } };
    });
    let now = 1762400000000;
    const clock = { now: () => now };
    const heard = [];
    let h = await boot({ clock, ownerNotify: async (n) => { heard.push(n); return true; }, env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '5', AI_BREAKER_EXHAUSTED_COOLDOWN_MS: '900000',
    } });
    try {
        await provider(h, { key: 'seam', base_url: seam.url });
        await model(h, 'seam', 'model-a');
        await model(h, 'seam', 'model-b');
        const r = await route(h, { provider: 'seam', model: 'model-a' }, [{ provider: 'seam', model: 'model-b' }]);
        const logs = [];
        const first = await ask(h, r, logs);
        assert.strictEqual(first.provider, 'seam');
        assert.strictEqual(first.model, 'model-b', 'the same provider, the next offer, answers');
        assert.strictEqual(seam.calls, 2, 'one call to each offer: the balance offer is not retried');
        assert.strictEqual(seam.last.model, 'model-b');
        const log = logs.find((e) => e.provider_key === 'seam' && e.model_key === 'model-a');
        assert.ok(log, 'the failed offer is logged');
        assert.strictEqual(log.error_class, 'balance', 'the request log records the class, not the body');

        const a = await h.pool.health('seam', 'model-a');
        const b = await h.pool.health('seam', 'model-b');
        assert.strictEqual(a.state, 'open');
        assert.strictEqual(a.failure_class, 'balance');
        assert.ok(a.exhausted_at, 'a balance circuit is exhausted');
        assert.strictEqual(a.status_reason, 'the provider says the account is out of credit');
        assert.strictEqual(b.state, 'closed', 'the other model on the same provider is untouched');
        assert.strictEqual((await h.pool.health('seam')).state, 'open', 'the provider roll-up is open');

        const again = await ask(h, r);
        assert.strictEqual(again.provider, 'seam');
        assert.strictEqual(again.model, 'model-b');
        assert.strictEqual(seam.calls, 3, 'the open offer is skipped on the next request');
        const skipped = again.explain.attempts.find((x) => x.model === 'model-a' && x.status === 'skipped');
        assert.strictEqual(skipped.error, 'exhausted', 'the skip says why');
        assert.strictEqual(heard.length, 1, 'one owner message, not one per request');
        assert.match(heard[0].message, /out of credit/);

        const adminView = await request(h.base, 'GET', '/api/v1/providers/seam', { tok: admin });
        assert.strictEqual(adminView.status, 200, adminView.text);
        const health = adminView.body.provider.health;
        assert.strictEqual(health.status_reason, 'the provider says the account is out of credit');
        const circuit = health.circuits.find((c) => c.model_key === 'model-a');
        assert.strictEqual(circuit.state, 'open');

        const catalog = await request(h.base, 'GET', '/api/v1/exchange/catalog');
        assert.strictEqual(catalog.status, 200, catalog.text);
        const offer = catalog.body.models.find((m) => m.slug === 'seam/model-a').offers.find((o) => o.provider === 'seam');
        assert.strictEqual(offer.status, 'down');
        assert.strictEqual(offer.status_reason, 'the provider says the account is out of credit');
        assert.strictEqual(offer.status_class, 'balance');
        assert.ok(offer.status_since, 'the catalogue says since when');
        const healthy = catalog.body.models.find((m) => m.slug === 'seam/model-b').offers.find((o) => o.provider === 'seam');
        assert.strictEqual(healthy.status, 'up');

        const metrics = await request(h.base, 'GET', '/metrics');
        assert.ok(/ai_provider_circuit_open\{provider="seam",model="model-a",class="balance"\} 1\n/.test(metrics.text), metrics.text);
        assert.ok(/ai_provider_circuit_open\{provider="seam",model="model-b",class=""\} 0\n/.test(metrics.text), metrics.text);
        assert.ok(/ai_provider_failures_total\{provider="seam",class="balance"\} 1\n/.test(metrics.text), metrics.text);

        // The 15-minute probe: still open before it, half-open after, and a second 402 restarts the pause.
        now += 899999;
        assert.strictEqual((await h.pool.health('seam', 'model-a')).state, 'open');
        now += 2;
        assert.strictEqual((await h.pool.health('seam', 'model-a')).state, 'half_open');
        const probe = await ask(h, r);
        assert.strictEqual(probe.model, 'model-b', 'the probe failed and the same request moved to the next offer');
        assert.strictEqual(seam.calls, 5, 'the probe reached the half-open offer once, then the next offer answered');
        assert.strictEqual((await h.pool.health('seam', 'model-a')).state, 'open', 'the failed probe opens it again');
        assert.strictEqual(heard.length, 1, 'a reopened circuit is the same open episode: no second alert');
    } finally { await h.stop(); await seam.close(); }
});

t.test('a run of transient failures opens for 30 s, doubles on a failed probe, and closes on success', async () => {
    let failing = true;
    const seam = await seamServer(() => failing ? { status: 503, body: { error: { message: 'overloaded' } } } : { text: 'back', model: 'm', usage: { input: 2, output: 1 } });
    let now = 1762400000000;
    const clock = { now: () => now };
    const h = await boot({ clock, env: {
        AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '3',
        AI_BREAKER_BACKOFF_MS: '30000', AI_BREAKER_MAX_BACKOFF_MS: '60000',
    } });
    try {
        await provider(h, { key: 'seam', base_url: seam.url });
        await model(h, 'seam', 'm');
        const r = await route(h, { provider: 'seam', model: 'm' });
        for (let i = 0; i < 2; i++) await ask(h, r).catch(() => {});
        assert.strictEqual((await h.pool.health('seam', 'm')).state, 'closed', 'two failures are below the threshold');
        await ask(h, r).catch(() => {});
        let health = await h.pool.health('seam', 'm');
        assert.strictEqual(health.state, 'open');
        assert.strictEqual(health.failure_class, 'transient');
        assert.strictEqual(health.backoff_ms, 30000, 'the first pause is 30 seconds');
        assert.strictEqual(health.retry_at - health.opened_at, 30000);

        now += 30000;
        assert.strictEqual((await h.pool.health('seam', 'm')).state, 'half_open', 'one real request may probe');
        await ask(h, r).catch(() => {});
        health = await h.pool.health('seam', 'm');
        assert.strictEqual(health.state, 'open');
        assert.strictEqual(health.backoff_ms, 60000, 'a failed probe doubles the pause');

        now += 60000;
        failing = false;
        const ok = await ask(h, r);
        assert.strictEqual(ok.provider, 'seam');
        health = await h.pool.health('seam', 'm');
        assert.strictEqual(health.state, 'closed', 'a successful probe closes it');
        assert.strictEqual(health.consecutive_failures, 0);
    } finally { await h.stop(); await seam.close(); }
});

t.test('rate limits and malformed requests never open a circuit; the class is logged', async () => {
    const seam = await seamServer((body) => {
        const fx = fixtures[body.model];
        return fx ? { status: fx.status, body: fx.body } : { text: 'ok', model: body.model, usage: { input: 1, output: 1 } };
    });
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', AI_BREAKER_FAILURES: '5' } });
    try {
        await provider(h, { key: 'seam', base_url: seam.url });
        for (const name of ['deepseek_balance', 'anthropic_credit', 'openai_auth', 'anthropic_auth', 'openrouter_rate', 'gemini_quota', 'deepseek_transient', 'context_too_long', 'bad_image']) {
            await model(h, 'seam', name);
            const r = await route(h, { provider: 'seam', model: name });
            const logs = [];
            await ask(h, r, logs).catch(() => {});
            const health = await h.pool.health('seam', name);
            const expected = fixtures[name].class;
            assert.strictEqual(logs.find((e) => e.status === 'error').error_class, expected, `${name} logged as ${expected}`);
            if (expected === 'rate_limit' || expected === 'request' || expected === 'transient') {
                assert.strictEqual(health.state, 'closed', `${name} must not open the circuit`);
            } else {
                assert.strictEqual(health.state, 'open', `${name} opens at once`);
            }
        }
        const counts = await h.db.prepare('SELECT failure_class, SUM(count)::bigint AS n FROM provider_failure_counts GROUP BY failure_class').all();
        const by = Object.fromEntries(counts.map((x) => [x.failure_class, Number(x.n)]));
        assert.ok(by.balance >= 2 && by.auth >= 2 && by.rate_limit >= 2 && by.request >= 2 && by.transient >= 1, JSON.stringify(by));
    } finally { await h.stop(); await seam.close(); }
});

t.test('the catalogue measures degraded from the last hour, never below 10 requests', async () => {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        await provider(h, { key: 'seam', base_url: 'http://127.0.0.1:1/x' });
        await model(h, 'seam', 'm');
        const catalog = createCatalog({ db: h.db, registry: h.registry, pool: h.pool, env: h.env, config: h.config });
        const offerOf = async () => (await catalog.models({ days: 7 })).models.find((m) => m.slug === 'seam/m').offers.find((o) => o.provider === 'seam');
        assert.strictEqual((await offerOf()).status, 'up');
        const now = Date.now();
        const ins = h.db.prepare('INSERT INTO requests (operation, provider_key, model_key, status, error_class, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (let i = 0; i < 9; i++) await ins.run('chat', 'seam', 'm', 'ok', null, new Date(now - 300000).toISOString());
        await ins.run('chat', 'seam', 'm', 'error', 'transient', new Date(now - 120000).toISOString());
        let offer = await offerOf();
        assert.strictEqual(offer.status, 'degraded', '1 of 10 is over 5%');
        assert.strictEqual(offer.status_reason, 'too many errors in the last hour');
        assert.ok(offer.status_since, 'the first error of the window');
        await h.db.prepare("DELETE FROM requests WHERE provider_key='seam' AND model_key='m' AND status='ok' AND created_at < ?").run(new Date(now - 1000).toISOString());
        offer = await offerOf();
        assert.strictEqual(offer.status, 'up', '9 requests is below the measured floor');
    } finally { await h.stop(); }
});

t.test('a restart keeps the circuit; a new provider key clears it', async () => {
    const seam = await seamServer(() => ({ status: 401, body: fixtures.openai_auth.body }));
    const dir = tmpDir();
    const env = { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0', TEST_KEY_A: 'key-aaa', TEST_KEY_B: 'key-bbb' };
    let h = await boot({ dir, env });
    try {
        await provider(h, { key: 'keyed', base_url: seam.url, auth_mode: 'bearer', secret_ref: 'env:TEST_KEY_A' });
        await model(h, 'keyed', 'm');
        const r = await route(h, { provider: 'keyed', model: 'm' });
        await ask(h, r).catch(() => {});
        assert.strictEqual((await h.pool.health('keyed', 'm')).state, 'open');
        assert.strictEqual((await h.pool.health('keyed', 'm')).failure_class, 'auth');
        assert.strictEqual((await h.pool.health('keyed', 'm')).status_reason, 'the key was refused');
        await h.stop();
        h = await boot({ dir, env });
        assert.strictEqual((await h.pool.health('keyed', 'm')).state, 'open', 'the circuit survived the restart');
        const counts = await h.db.prepare("SELECT count FROM provider_failure_counts WHERE provider_key='keyed' AND failure_class='auth'").get();
        assert.ok(Number(counts.count) >= 1, 'the failure count survived too');
        const changed = await request(h.base, 'PATCH', '/api/v1/providers/keyed', { tok: admin, body: { secret_ref: 'env:TEST_KEY_B' } });
        assert.strictEqual(changed.status, 200, changed.text);
        assert.strictEqual((await h.pool.health('keyed', 'm')).state, 'closed', 'a new key closes the old key\'s circuit');
    } finally { await h.stop(); await seam.close(); }
});

t.run();
