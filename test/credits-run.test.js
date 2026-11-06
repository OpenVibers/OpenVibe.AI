'use strict';
// AI Exchange F / P7 + D12 end to end, against a fake Billing. A paid managed request holds Balance before the
// provider runs: an app against its project's Balance (subject app + project_id, no Network lookup) and a person
// against their personal Balance (no project_id). max_cost_usd clamps the output; a pricier managed fallback
// extends the hold (or is skipped if Billing refuses); a settle Billing cannot take is queued and retried exactly
// once; a run with no payer never reaches a paid offer with a versioned card; an exact id then fails 402; a
// provider without a card behaves as before; a sandbox app token never reaches paid supply; with the flag off
// nothing changes.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { boot, request, token, suite, ALL, privateKey, ISSUER } = require('./helpers');

const t = suite('credits-run');
const service = token('live', ALL);
const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ = `prj_${ULID}`;
const APP = `app_${ULID}`;
const PERSON = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A person's own Network token (audience openvibe.ai): the subject in sub and subject_id, no actor_type. */
function userToken(audience, subject = PERSON) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: ISSUER, sub: subject, subject_id: subject, aud: [audience], iat: now, exp: now + 3600, jti: `tok_${crypto.randomBytes(8).toString('hex')}` })}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const appToken = (env) => token('app', ['ai.app.run'], { sub: `app:app_${ULID}`, actorType: 'app', ns: [PRJ, `app.${PRJ}.*`], extra: { project_id: PRJ, env } });
const producer = appToken('production');
const sandbox = appToken('sandbox');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A local fake Billing: the four hold routes, OAuth and the usage relay. D12 makes no Network call. */
async function fakeBilling() {
    const state = { balance: 10_000_000_000n, held: 0n, short: false, failSettle: 0, refuseExtend: false,
        holds: new Map(), settlements: new Map(), releases: [], calls: [], oauthScopes: [], oauthAudiences: [], seq: 0 };
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
            if (path === '/oauth/token') {
                const params = new URLSearchParams(raw);
                state.oauthAudiences.push(String(params.get('audience') || ''));
                state.oauthScopes.push(String(params.get('scope') || ''));
                return send(200, { access_token: 'test-token', token_type: 'Bearer', expires_in: 300, scope: String(params.get('scope') || '') });
            }
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
                if (!hold || state.refuseExtend || state.short || available() < add) return send(402, { code: 'billing.insufficient_funds', detail: 'cannot extend' });
                hold.held_nano_usd = String(BigInt(hold.held_nano_usd) + add);
                hold.status = 'extended';
                state.held += add;
                return send(200, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            m = /^\/internal\/credits\/holds\/([^/]+)\/settle$/.exec(path);
            if (m) {
                if (state.failSettle > 0) { state.failSettle--; return send(500, { code: 'billing.internal', detail: 'settle is down' }); }
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
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    return state;
}

/** A local OpenAI-format upstream whose answer each test scripts; it honours max_tokens for its usage. */
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
            const completion = Math.min(12, Number(body.max_tokens || body.max_completion_tokens) || 12);
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
                chunk({ choices: [], usage: { prompt_tokens: 60, completion_tokens: completion, total_tokens: 60 + completion } });
                res.write('data: [DONE]\n\n');
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-up', object: 'chat.completion', created: 1, model: 'gpt-up', choices: [{ index: 0, message: { role: 'assistant', content: 'an answer from upstream' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: completion, total_tokens: 60 + completion } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.url = `http://127.0.0.1:${server.address().port}/v1`;
    state.close = () => new Promise((r) => { server.closeAllConnections?.(); clearInterval(state.timer); server.close(() => r()); });
    return state;
}

async function seed(h, up, { cost = { in_per_mtok: 1, out_per_mtok: 2 }, rateVersion = 'retail-1', fallbacks = [] } = {}) {
    const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
        key: 'up', kind: 'openai', base_url: up.url, auth_mode: 'none', default_model: 'gpt-up', capabilities: ['chat'],
        provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
    assert.ok(made.status < 300, made.text);
    const model = await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
        provider_key: 'up', model_key: 'gpt-up', type: 'chat', supports: { streaming: true }, cost,
        metadata: { ...(rateVersion ? { rate_version: rateVersion } : {}) } } });
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

/** The run id from an OpenAI answer's x_openvibe. */
const runIdOf = (r) => r.body.x_openvibe && r.body.x_openvibe.run_id;

t.test('a paid app request holds its project\'s Balance: the hold names the app and its project, no Network call', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const first = await chat(h, {});
        assert.strictEqual(first.status, 200, first.text);
        const holds = billing.calls.filter((c) => c.path === '/internal/credits/holds');
        assert.strictEqual(holds.length, 1);
        assert.deepStrictEqual(holds[0].body.subject, { type: 'app', id: APP }, 'an app pays, not its owner');
        assert.strictEqual(holds[0].body.project_id, PRJ, 'the project Balance is the account');
        const second = await chat(h, {});
        assert.strictEqual(second.status, 200, second.text);
        assert.strictEqual(billing.calls.filter((c) => c.path.includes('/internal/projects/')).length, 0, 'Network was never called');
        assert.ok(!billing.oauthAudiences.includes('openvibe.network'), 'no Network service token was minted');
        assert.ok(billing.oauthScopes.every((scope) => !/network\.project\.read/.test(scope)), 'network.project.read was never requested');
        assert.strictEqual(billing.settlements.size, 2);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a service naming a person cannot hold their Balance: no payer, and 402 ai.allowance_spent when no free capacity', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: service, body: {
            workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello as me' }] },
            on_behalf_of: { type: 'user', id: PERSON } } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.run.status, 'failed');
        assert.strictEqual(r.body.run.error.code, 'ai.allowance_spent');
        assert.match(r.body.run.error.detail, /free AI allowance/);
        assert.strictEqual(billing.calls.filter((c) => c.path === '/internal/credits/holds').length, 0, 'never a hold of their Balance');
        assert.strictEqual(billing.settlements.size, 0);
        assert.strictEqual(up.calls, 0, 'the paid offer was not served to a run nobody pays for');
        // The OpenAI route answers the same code as a 402.
        const viaChat = await chat(h, { tok: service, body: { x_openvibe: { on_behalf_of: { type: 'user', id: PERSON } } } });
        assert.strictEqual(viaChat.status, 402, viaChat.text);
        assert.strictEqual(viaChat.body.error.code, 'ai.allowance_spent');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a person\'s own token holds their personal Balance: no project_id and no Network call', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: userToken('openvibe.ai'), body: {
            workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello as me' }] } } });
        assert.ok(r.status < 300, r.text);
        assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error));
        assert.deepStrictEqual(r.body.run.on_behalf_of, { type: 'user', id: PERSON }, 'the run is theirs');
        // The OpenAI-compatible route accepts the same person token and holds the same personal Balance.
        const viaChat = await chat(h, { tok: userToken('openvibe.ai') });
        assert.strictEqual(viaChat.status, 200, viaChat.text);
        const holds = billing.calls.filter((c) => c.path === '/internal/credits/holds');
        assert.strictEqual(holds.length, 2);
        assert.deepStrictEqual(holds[0].body.subject, { type: 'user', id: PERSON });
        assert.ok(!('project_id' in holds[0].body), 'a personal hold has no project_id');
        assert.strictEqual(billing.calls.filter((c) => c.path.includes('/internal/projects/')).length, 0, 'Network was never called');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a person\'s token may run only for themselves, and only the model API', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const someoneElse = await request(h.base, 'POST', '/api/v1/runs', { tok: userToken('openvibe.ai'), body: {
            workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'x' }] },
            on_behalf_of: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1' } } });
        assert.strictEqual(someoneElse.status, 403, someoneElse.text);
        const product = await request(h.base, 'POST', '/api/v1/runs', { tok: userToken('openvibe.ai'), body: { workflow: 'live.viewers.line', input: { role: 'chat', user: 'x' } } });
        assert.strictEqual(product.status, 403, product.text);
        assert.strictEqual(product.body.code, 'capability.namespace_denied');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a subject assertion is not accepted until H1 lands (openvibe-sdk #122)', async () => {
    // The header exists in SDK #122. Until it is released and AI pins it, a service naming a person gets no Balance.
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: service,
            headers: { 'x-ov-subject-assertion': 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln' },
            body: { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: 'hello as me' }] }, on_behalf_of: { type: 'user', id: PERSON } } });
        assert.strictEqual(r.body.run.error.code, 'ai.allowance_spent');
        assert.strictEqual(billing.calls.filter((c) => c.path === '/internal/credits/holds').length, 0);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

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
        assert.strictEqual(r.body.error.message, 'Not enough Balance');
        assert.strictEqual(up.calls, 0, 'no provider call was made');
        assert.strictEqual(billing.settlements.size, 0);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('max_cost_usd clamps the provider\'s max_tokens and the settled charge never exceeds the cap', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        // Input is free here so the cap is entirely about output: $0.002/M = 2 nano per token, cap 10 nano = 5 tokens.
        await seed(h, up, { cost: { in_per_mtok: 0, out_per_mtok: 0.002 } });
        const r = await chat(h, { body: { max_tokens: 100, max_cost_usd: '0.00000001' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(up.bodies[0].max_tokens, 5, 'the provider was asked for the affordable output only');
        const settle = billing.calls.filter((c) => c.path.endsWith('/settle'))[0];
        assert.strictEqual(settle.body.usage.output_tokens, 5);
        const charged = BigInt([...billing.settlements.values()][0].charge_nano_usd);
        assert.ok(charged <= 10n, `charge ${charged} <= cap 10 nano`);
        assert.strictEqual(settle.body.retail.version, 'retail-1');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a pricier managed fallback extends the hold by the difference (clamped by max_cost_usd)', async () => {
    const billing = await fakeBilling();
    const bad = await upstream('fail');
    const good = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, bad, { cost: { in_per_mtok: 0, out_per_mtok: 0.001 } });
        const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key: 'up2', kind: 'openai', base_url: good.url, auth_mode: 'none', default_model: 'gpt-up2', capabilities: ['chat'],
            provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
        assert.ok(made.status < 300, made.text);
        assert.ok((await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
            provider_key: 'up2', model_key: 'gpt-up2', type: 'chat', cost: { in_per_mtok: 0, out_per_mtok: 0.004 }, metadata: { rate_version: 'retail-2' } } })).status < 300);
        assert.ok((await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
            primary: { provider: 'up', model: 'gpt-up' }, fallbacks: [{ provider: 'up2', model: 'gpt-up2' }], timeout_ms: 5000 } })).status < 300);
        // max_tokens 100: up holds 100 nano; up2's worst is 400, capped at 250 => 62 output tokens / 248 nano.
        const r = await chat(h, { body: { max_tokens: 100, max_cost_usd: '0.00000025' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(bad.calls, 1);
        assert.strictEqual(good.calls, 1);
        const extend = billing.calls.filter((c) => c.path.endsWith('/extend'));
        assert.strictEqual(extend.length, 1, 'the hold grew for the pricier fallback');
        assert.strictEqual(extend[0].body.add_nano_usd, '148', '250 cap - 100 held, with 62 affordable tokens');
        assert.strictEqual(good.bodies[0].max_tokens, 62, 'the fallback got the clamped output');
        assert.strictEqual(billing.settlements.size, 1, 'one settlement');
        const settle = billing.calls.filter((c) => c.path.endsWith('/settle'))[0];
        assert.strictEqual(settle.body.attempts.length, 2);
        assert.deepStrictEqual(Object.keys(settle.body.attempts[0]).sort(), ['deployment_id', 'ended_at', 'error_code', 'provider_access', 'started_at']);
    } finally { await h.stop(); await bad.close(); await good.close(); await billing.close(); }
});

t.test('a fallback whose hold cannot be extended is skipped, not run', async () => {
    const billing = await fakeBilling();
    const bad = await upstream('fail');
    const good = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, bad, { cost: { in_per_mtok: 0, out_per_mtok: 0.001 } });
        assert.ok((await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key: 'up2', kind: 'openai', base_url: good.url, auth_mode: 'none', default_model: 'gpt-up2', capabilities: ['chat'],
            provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } })).status < 300);
        assert.ok((await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
            provider_key: 'up2', model_key: 'gpt-up2', type: 'chat', cost: { in_per_mtok: 0, out_per_mtok: 0.004 }, metadata: { rate_version: 'retail-2' } } })).status < 300);
        assert.ok((await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: service, body: {
            primary: { provider: 'up', model: 'gpt-up' }, fallbacks: [{ provider: 'up2', model: 'gpt-up2' }], timeout_ms: 5000 } })).status < 300);
        billing.refuseExtend = true;
        const r = await chat(h, { body: { max_tokens: 100 } });
        assert.ok(r.status >= 500, r.text);
        assert.strictEqual(good.calls, 0, 'the pricier fallback never ran');
        // The skipped attempt is named in the run's explain.
        const listed = await request(h.base, 'GET', '/api/v1/runs?limit=1&all=1', { tok: service });
        const attempts = (listed.body.runs[0].explain && listed.body.runs[0].explain.attempts) || [];
        assert.ok(attempts.some((a) => a.status === 'skipped' && a.error === 'hold_not_extended'), JSON.stringify(attempts));
        assert.strictEqual(billing.releases.length, 1, 'the first hold was released');
    } finally { await h.stop(); await bad.close(); await good.close(); await billing.close(); }
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
        const settleCall = billing.calls.filter((c) => c.path.endsWith('/settle'))[0];
        assert.ok(settleCall.body.usage.output_tokens > 0, `partial output was settled (${JSON.stringify(settleCall.body.usage)})`);
        assert.ok(BigInt([...billing.settlements.values()][0].charge_nano_usd) > 0n);
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
        assert.strictEqual(settles[0].body.attempts.length, 1, 'the single managed attempt is reported');
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

t.test('a settle Billing cannot take is queued and retried with the same key: exactly one settlement', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up);
        billing.failSettle = 2;
        const r = await chat(h, { headers: { 'x-openvibe-request-id': 'req_credits_queue_1' } });
        assert.strictEqual(r.status, 200, r.text);
        const queued = await h.credits.pendingSettlements();
        assert.strictEqual(queued.length, 1, 'the failed settle is kept');
        assert.strictEqual(queued[0].status, 'queued');
        assert.strictEqual(billing.settlements.size, 0, 'nothing was charged yet');
        billing.failSettle = 0;
        const out = await h.credits.drainSettlements({ force: true });
        assert.strictEqual(out.sent, 1, JSON.stringify(out));
        assert.strictEqual(billing.settlements.size, 1, 'exactly one settlement');
        const after = await h.credits.pendingSettlements();
        assert.strictEqual(after[0].status, 'sent');
        const settles = billing.calls.filter((c) => c.path.endsWith('/settle'));
        assert.strictEqual(settles[0].body.idempotency_key, settles[settles.length - 1].body.idempotency_key, 'the same key was retried');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('no payer: paid offers with a versioned card are skipped (payer_required) and a free offer answers', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up, { fallbacks: [{ provider: 'stub', model: 'stub-1' }] });
        const r = await chat(h, { tok: service });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(up.calls, 0, 'the paid managed offer was not served for free');
        assert.strictEqual(r.body.x_openvibe.provider, 'stub', 'the free local offer answered');
        const run = await request(h.base, 'GET', `/api/v1/runs/${runIdOf(r)}`, { tok: service });
        assert.ok(run.body.run.explain.attempts.some((a) => a.status === 'skipped' && a.error === 'payer_required'), JSON.stringify(run.body.run.explain.attempts));
        assert.strictEqual(billing.settlements.size, 0, 'no Balance was spent');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('an exact id whose only offer has a versioned card fails 402 billing.payer_required for a no-payer run', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        const made = await request(h.base, 'POST', '/api/v1/providers', { tok: service, body: {
            key: 'up', kind: 'openai', base_url: up.url, auth_mode: 'none', default_model: 'gpt-up', capabilities: ['chat'],
            provider_access: 'OWN_DEPLOYMENT', billing_profile: 'metered' } });
        assert.ok(made.status < 300, made.text);
        assert.ok((await request(h.base, 'POST', '/api/v1/models', { tok: service, body: {
            provider_key: 'up', model_key: 'gpt-up', type: 'chat', cost: { in_per_mtok: 1, out_per_mtok: 2 },
            metadata: { id: 'acme/only@r1', rate_version: 'retail-1' } } })).status < 300);
        const r = await chat(h, { tok: service, body: { model: 'acme/only@r1' } });
        assert.strictEqual(r.status, 402, r.text);
        assert.strictEqual(r.body.error.code, 'billing.payer_required');
        assert.strictEqual(up.calls, 0);
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a paid offer without a versioned card behaves as before for a no-payer run', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up, { rateVersion: null });
        const r = await chat(h, { tok: service });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(up.calls, 1, 'no card: the offer is not a Balance offer and still runs');
    } finally { await h.stop(); await up.close(); await billing.close(); }
});

t.test('a sandbox app token never reaches paid supply, and is never charged (D10)', async () => {
    const billing = await fakeBilling();
    const up = await upstream('ok');
    const h = await bootWith(billing);
    try {
        await seed(h, up, { fallbacks: [{ provider: 'stub', model: 'stub-1' }] });
        const paid = await chat(h, {});
        assert.strictEqual(paid.status, 200, paid.text);
        assert.strictEqual(up.calls, 1);
        const r = await chat(h, { tok: sandbox });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.x_openvibe.provider, 'stub', 'the free local offer answered');
        assert.strictEqual(up.calls, 1, 'paid supply was never called for a sandbox token');
        assert.strictEqual(billing.calls.filter((c) => c.path.includes('/internal/projects/')).length, 0, 'a sandbox run resolves no payer');
        assert.strictEqual(billing.calls.filter((c) => c.path === '/internal/credits/holds').length, 1, 'only the production run held Balance');
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
