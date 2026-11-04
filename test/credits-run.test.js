'use strict';
// AI Exchange F / P7 end to end: a paid managed request holds Billing Credits before the provider runs, settles
// once with the real token counts and attempts, releases when nothing was produced, and settles an aborted
// stream's partial usage. Billing is a local fake; the providers are local OpenAI-format servers. With the flag
// off nothing changes, and a sandbox app token never reaches paid supply (D10).
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('credits-run');
const service = token('live', ALL);
const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ = `prj_${ULID}`;
const appToken = (env) => token('app', ['ai.app.run'], { sub: `app:app_${ULID}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env } });
const producer = appToken('production');
const sandbox = appToken('sandbox');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const RETAIL = { rate_version: 'retail-1', in_per_mtok: 1, out_per_mtok: 2 };

/** A local fake Billing: the four Credits routes, an OAuth token, and the usage relay's endpoint. */
async function fakeBilling() {
    const state = { balance: 10_000_000_000n, held: 0n, short: false, holds: new Map(), settlements: new Map(), releases: [], calls: [], seq: 0 };
    const available = () => state.balance - state.held;
    const part = (tokens, rate) => {
        const n = BigInt(tokens || 0) * BigInt(rate || 0);
        return n === 0n ? 0n : (n % 1000000n === 0n ? n / 1000000n : n / 1000000n + 1n);
    };
    const chargeOf = (usage, retail) => {
        const perM = retail.nano_usd_per_m || {};
        return part(usage.input_tokens, perM.input) + part(usage.cached_read_tokens, perM.cached_read)
            + part(usage.cache_write_tokens, perM.cache_write) + part(usage.output_tokens, perM.output) + BigInt(retail.per_request_nano_usd || 0);
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const path = new URL(req.url, 'http://x').pathname;
            const body = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } })();
            state.calls.push({ path, body });
            const send = (status, out) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); };
            if (path === '/oauth/token') return send(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 300, scope: 'billing.credit.hold.create billing.credit.hold.extend billing.credit.hold.settle billing.credit.hold.release' });
            if (path === '/api/v1/usage') return send(201, { ok: true });
            if (path === '/internal/credits/holds') {
                const key = body.idempotency_key;
                const prev = state.holds.get(key);
                if (prev) {
                    if (prev.fingerprint !== body.request_fingerprint) return send(409, { code: 'billing.hold_key_reused', detail: 'different fingerprint' });
                    return send(201, { hold_id: prev.hold_id, held_nano_usd: prev.held_nano_usd, available_nano_usd: String(available() < 0n ? 0n : available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
                }
                const amount = BigInt(String(body.max_nano_usd));
                if (state.short || available() < amount) return send(402, { code: 'billing.insufficient_funds', detail: `need ${amount}, have ${state.short ? 0 : available()}` });
                const hold = { hold_id: `hld_${String(++state.seq).padStart(26, '0')}`, held_nano_usd: String(amount), fingerprint: body.request_fingerprint, status: 'active' };
                state.holds.set(key, hold);
                state.held += amount;
                return send(201, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            let m = /^\/internal\/credits\/holds\/([^/]+)\/extend$/.exec(path);
            if (m) {
                const hold = [...state.holds.values()].find((h) => h.hold_id === decodeURIComponent(m[1]));
                const add = BigInt(String(body.add_nano_usd));
                if (!hold || state.short || available() < add) return send(402, { code: 'billing.insufficient_funds', detail: 'cannot extend' });
                hold.held_nano_usd = String(BigInt(hold.held_nano_usd) + add);
                hold.status = 'extended';
                state.held += add;
                return send(200, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            m = /^\/internal\/credits\/holds\/([^/]+)\/settle$/.exec(path);
            if (m) {
                const prev = state.settlements.get(body.idempotency_key);
                if (prev) return send(201, prev);
                const hold = [...state.holds.values()].find((h) => h.hold_id === decodeURIComponent(m[1]));
                if (!hold) return send(404, { code: 'billing.hold_not_found' });
                const charge = body.byok ? 0n : chargeOf(body.usage, body.retail);
                const held = BigInt(hold.held_nano_usd);
                const out = { charge_nano_usd: String(charge), released_nano_usd: String(charge >= held ? 0n : held - charge), journal_id: `txn_${state.settlements.size + 1}`, shortfall_nano_usd: '0' };
                state.settlements.set(body.idempotency_key, out);
                hold.status = 'settled';
                state.held -= held;
                state.balance -= charge;
                return send(201, out);
            }
            m = /^\/internal\/credits\/holds\/([^/]+)\/release$/.exec(path);
            if (m) {
                const id = decodeURIComponent(m[1]);
                const hold = [...state.holds.values()].find((h) => h.hold_id === id);
                if (hold && hold.status !== 'settled') {
                    state.releases.push({ hold_id: id, released_nano_usd: hold.held_nano_usd });
                    state.held -= BigInt(hold.held_nano_usd);
                    hold.status = 'released';
                }
                return send(200, state.releases[state.releases.length - 1] || { hold_id: id, released_nano_usd: '0' });
            }
            return send(404, { code: 'not_found', detail: path });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.settledOf = (key) => state.settlements.get(key);
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

/** A local OpenAI-format upstream whose answer each test scripts. */
async function upstream(kind = 'ok') {
    const state = { kind, calls: 0, bodies: [] };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            state.calls++;
            state.bodies.push(body);
            if (state.kind === 'fail') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: { message: 'upstream is down' } }));
            }
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const chunk = (o) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-up', ...o })}\n\n`);
                chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'from ' }, finish_reason: null }] });
                chunk({ choices: [{ index: 0, delta: { content: 'the upstream' }, finish_reason: null }] });
                if (state.kind === 'slow') {
                    state.timer = setInterval(() => chunk({ choices: [{ index: 0, delta: { content: ' more' }, finish_reason: null }] }), 25);
                    req.on('close', () => clearInterval(state.timer));
                    return;
                }
                chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                chunk({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 } });
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion', created: 1, model: 'gpt-up', choices: [{ index: 0, message: { role: 'assistant', content: 'an answer from upstream' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}/v1`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); clearInterval(state.timer); server.close(() => r()); });
    return state;
}

async function seed(h, up, { fallbacks = [] } = {}) {
    const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
        key: 'up', kind: 'openai', base_url: up.url, auth_mode: 'none', default_model: 'gpt-up', capabilities: ['chat'],
        provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
    assert.ok(made.status < 300, made.text);
    const model = await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
        provider_key: 'up', model_key: 'gpt-up', type: 'chat', supports: { streaming: true }, cost: { in_per_mtok: RETAIL.in_per_mtok, out_per_mtok: RETAIL.out_per_mtok },
        metadata: { rate_version: RETAIL.rate_version } } });
    assert.ok(model.status < 300, model.text);
    const route = await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
        primary: { provider: 'up', model: 'gpt-up' }, fallbacks, timeout_ms: 5000 } });
    assert.ok(route.status < 300, route.text);
}

async function bootWith(billing, env = {}) {
    return boot({ env: {
        AI_CREDITS: '1', AI_MODEL_CATALOG: '1', AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0',
        AI_GOVERN_TIERS: '1', AI_GOVERN_POLICY_JSON: JSON.stringify({ 'ai-token': { free: {} }, 'ai-usd': { free: {} } }),
        OV_BILLING_INTERNAL_URL: billing.url, OV_NETWORK_INTERNAL_URL: billing.url, OV_OAUTH_CLIENT_SECRET: 'test-secret', OV_OAUTH_CLIENT_ID: 'ai',
        USAGE_SAMPLES: 'off',
        ...env,
    } });
}

const chat = (h, { tok = producer, body = {}, headers = {} } = {}) => request(h.base, 'POST', '/v1/chat/completions', {
    tok, headers, body: { messages: [{ role: 'user', content: 'hello' }], ...body } });

t.test('insufficient credit: a 402 billing.insufficient_funds, and the provider is never called', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        billing.short = true;
        const r = await chat(h, {});
        assert.strictEqual(r.status, 402, r.text);
        assert.strictEqual(r.body.error.code, 'billing.insufficient_funds');
        assert.strictEqual(up.calls, 0, 'no provider call was made');
        assert.strictEqual(billing.settlements.size, 0);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('one settle per request, even when the request is retried with the same request id', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const headers = { 'x-openvibe-request-id': 'req_credits_retry_1' };
        const first = await chat(h, { headers });
        const second = await chat(h, { headers });
        assert.strictEqual(first.status, 200, first.text);
        assert.strictEqual(second.status, 200, second.text);
        const settles = billing.calls.filter((c) => c.path.endsWith('/settle'));
        assert.strictEqual(settles.length, 2, 'each attempt asked Billing');
        assert.strictEqual(billing.settlements.size, 1, '...and Billing settled once: the second is a replay');
        const settled = [...billing.settlements.values()][0];
        assert.ok(BigInt(settled.charge_nano_usd) > 0n);
        const settleCall = billing.calls.filter((c) => c.path.endsWith('/settle'))[0];
        assert.strictEqual(settleCall.body.attempts.length, 1, 'the single managed attempt is reported');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('an abort mid-stream settles the partial usage, never a release', async () => {
    const billing = await fakeBilling();
    const up = await upstream('slow');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const res = await fetch(`${h.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${producer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
            stream: true, messages: [{ role: 'user', content: 'stream please' }] }) });
        assert.strictEqual(res.status, 200);
        const runId = res.headers.get('x-openvibe-run-id');
        assert.match(String(runId), /^run_/);
        const reader = res.body.getReader();
        const { value } = await reader.read();
        assert.ok(value && value.length > 0, 'a first chunk arrived');
        // The cancel route takes first-party service tokens (ai.workflow.manage), not app tokens.
        const cancelled = await request(h.base, 'POST', `/api/v1/runs/${runId}/cancel`, { tok: service });
        assert.ok(cancelled.status < 300, cancelled.text);
        await reader.cancel().catch(() => {});
        let run = null;
        for (let i = 0; i < 100; i++) {
            const got = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: service });
            if (['cancelled', 'failed', 'succeeded'].includes(got.body.run.status)) { run = got.body.run; break; }
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.ok(run, 'the run reached a terminal state');
        assert.strictEqual(run.status, 'cancelled');
        assert.strictEqual(billing.releases.length, 0, 'an abort settles; it does not release');
        assert.strictEqual(billing.settlements.size, 1);
        const settled = [...billing.settlements.values()][0];
        const settleCall = billing.calls.filter((c) => c.path.endsWith('/settle'))[0];
        assert.ok(settleCall.body.usage.output_tokens > 0, `partial output was settled (${JSON.stringify(settleCall.body.usage)})`);
        assert.ok(BigInt(settled.charge_nano_usd) > 0n);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a provider failure before the first token releases the hold', async () => {
    const billing = await fakeBilling();
    const up = await upstream('fail');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const r = await chat(h, {});
        assert.ok(r.status >= 500, r.text);
        assert.strictEqual(billing.releases.length, 1, 'the hold was released');
        assert.strictEqual(billing.settlements.size, 0, 'nothing was charged');
        assert.strictEqual(up.calls, 1);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a fallback to a second provider settles once, with both attempts', async () => {
    const billing = await fakeBilling();
    const bad = await upstream('fail');
    const good = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, bad);
        // A second metered offer on the same route, after the failing one.
        const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key: 'up2', kind: 'openai', base_url: good.url, auth_mode: 'none', default_model: 'gpt-up2', capabilities: ['chat'],
            provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
        assert.ok(made.status < 300, made.text);
        assert.ok((await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
            provider_key: 'up2', model_key: 'gpt-up2', type: 'chat', supports: { streaming: true }, cost: { in_per_mtok: 3, out_per_mtok: 4 }, metadata: { rate_version: 'retail-2' } } })).status < 300);
        assert.ok((await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
            primary: { provider: 'up', model: 'gpt-up' }, fallbacks: [{ provider: 'up2', model: 'gpt-up2' }], timeout_ms: 5000 } })).status < 300);
        const r = await chat(h, {});
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(bad.calls, 1);
        assert.strictEqual(good.calls, 1);
        assert.strictEqual(billing.settlements.size, 1, 'one settlement');
        const settle = billing.calls.filter((c) => c.path.endsWith('/settle'))[0];
        assert.strictEqual(settle.body.attempts.length, 2, 'both attempts are reported');
        assert.deepStrictEqual(settle.body.attempts.map((a) => a.provider), ['up', 'up2']);
        assert.strictEqual(settle.body.retail.version, 'retail-2', 'the answering model\'s card');
    } finally { await h.stop(); await bad.close(); await good.close(); await billing.close(); }
});

t.test('a sandbox app token never reaches paid supply, and is never charged', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up, { fallbacks: [{ provider: 'stub', model: 'stub-1' }] });
        // A production app under an unrestricted free tier budget may reach the paid offer.
        const paid = await chat(h, {});
        assert.strictEqual(paid.status, 200, paid.text);
        assert.strictEqual(up.calls, 1);
        const before = billing.calls.length;
        const r = await chat(h, { tok: sandbox });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.x_openvibe.provider, 'stub', 'the free local offer answered');
        assert.strictEqual(up.calls, 1, 'paid supply was never called for a sandbox token');
        assert.strictEqual(billing.calls.length, before, 'a sandbox run spent no Credits');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('with AI_CREDITS off, a request runs exactly as before and Billing is never called', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing, { AI_CREDITS: '0' });
    try {
        await seed(h, up);
        const r = await chat(h, {});
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.choices[0].message.content, 'an answer from upstream');
        assert.strictEqual(up.calls, 1);
        assert.strictEqual(billing.calls.length, 0, 'no hold, extend, settle or release');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.run();
