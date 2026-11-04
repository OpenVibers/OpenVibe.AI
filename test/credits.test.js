'use strict';
// AI Exchange F / P7: the Credits session (server/credits.js) against a fake Billing, without HTTP.
// Covers the decisions the run-level tests lean on: the worst-case hold at the retail card, a 402 before any
// provider (the session refuses in onRoute), one settle per request, the partial usage of an abort, release
// before a first token, a managed fallback settling once with both attempts, BYOK never held, the streaming
// extension, max_cost_usd, and AI_CREDITS off.
const assert = require('assert');
const { suite } = require('./helpers');
const { createCredits, retailOf } = require('../server/credits');

const t = suite('credits');

const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const APP = 'app_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const R1 = { version: 'retail-1', input_nano_usd_per_m: '1000000000', output_nano_usd_per_m: '2000000000', cached_read_nano_usd_per_m: '0', cache_write_nano_usd_per_m: '0', per_request_nano_usd: '0' };
const R2 = { version: 'retail-2', input_nano_usd_per_m: '500000000', output_nano_usd_per_m: '4000000000', cached_read_nano_usd_per_m: '0', cache_write_nano_usd_per_m: '0', per_request_nano_usd: '0' };
const FACTS = { resolved_model: 'org/model@r1', revision: 'r1', deployment: 'up', provider_access: 'OWN_DEPLOYMENT', rate_version: 'retail-1', policy: null, fallback_reason: null };
const BYOK_FACTS = { ...FACTS, provider_access: 'CUSTOMER_BYOK' };

/** A tiny Billing that keeps holds/settlements the way PR #187 does (idempotent, 402 on a short balance). */
function fakeBilling({ balance = '100000000000' } = {}) {
    const state = { balance: BigInt(balance), held: 0n, holds: new Map(), settlements: new Map(), released: new Map(), calls: [], seq: 0 };
    const available = () => state.balance - state.held;
    const chargeOf = (usage, retail) => {
        const perM = retail.nano_usd_per_m || {};
        const part = (tokens, rate) => {
            const n = BigInt(tokens || 0) * BigInt(rate || 0);
            return n === 0n ? 0n : (n % 1000000n === 0n ? n / 1000000n : n / 1000000n + 1n);
        };
        return part(usage.input_tokens, perM.input) + part(usage.cached_read_tokens, perM.cached_read)
            + part(usage.cache_write_tokens, perM.cache_write) + part(usage.output_tokens, perM.output) + BigInt(retail.per_request_nano_usd || 0);
    };
    async function fetchImpl(url, opts = {}) {
        const path = new URL(url).pathname;
        const body = opts.body ? JSON.parse(opts.body) : {};
        state.calls.push({ path, body });
        if (path === '/internal/credits/holds') {
            const key = body.idempotency_key;
            const prev = state.holds.get(key);
            if (prev) {
                if (prev.fingerprint !== body.request_fingerprint) return json(409, { code: 'billing.hold_key_reused', detail: 'different fingerprint' });
                return json(201, { hold_id: prev.hold_id, held_nano_usd: prev.held_nano_usd, available_nano_usd: String(available() < 0n ? 0n : available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
            }
            const amount = BigInt(String(body.max_nano_usd));
            if (available() < amount) return json(402, { code: 'billing.insufficient_funds', detail: `need ${amount}, have ${available()}` });
            const hold = { hold_id: `hld_${String(++state.seq).padStart(26, '0')}`, held_nano_usd: String(amount), fingerprint: body.request_fingerprint, status: 'active', rate_version: body.rate_version };
            state.holds.set(key, hold);
            state.held += amount;
            return json(201, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
        }
        const extend = /^\/internal\/credits\/holds\/([^/]+)\/extend$/.exec(path);
        if (extend) {
            const hold = [...state.holds.values()].find((h) => h.hold_id === decodeURIComponent(extend[1]));
            if (!hold) return json(404, { code: 'billing.hold_not_found' });
            const add = BigInt(String(body.add_nano_usd));
            if (available() < add) return json(402, { code: 'billing.insufficient_funds', detail: 'cannot extend' });
            hold.held_nano_usd = String(BigInt(hold.held_nano_usd) + add);
            hold.status = 'extended';
            state.held += add;
            return json(200, { hold_id: hold.hold_id, held_nano_usd: hold.held_nano_usd, available_nano_usd: String(available()), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
        }
        const settle = /^\/internal\/credits\/holds\/([^/]+)\/settle$/.exec(path);
        if (settle) {
            const id = decodeURIComponent(settle[1]);
            const prev = state.settlements.get(body.idempotency_key);
            if (prev) return json(201, prev.result);
            const hold = [...state.holds.values()].find((h) => h.hold_id === id);
            if (!hold) return json(404, { code: 'billing.hold_not_found' });
            const charge = body.byok ? 0n : chargeOf(body.usage, body.retail);
            const held = BigInt(hold.held_nano_usd);
            const collected = charge; // enough balance in these fixtures
            const result = { charge_nano_usd: String(collected), released_nano_usd: String(collected >= held ? 0n : held - collected), journal_id: `txn_${state.settlements.size + 1}`, settlement: { usage: body.usage, retail: body.retail, attempts: body.attempts } };
            state.settlements.set(body.idempotency_key, { hold_id: id, result });
            hold.status = 'settled';
            state.held -= held;
            state.balance -= collected;
            state.settlements.get(body.idempotency_key).hold = hold;
            return json(201, result);
        }
        const release = /^\/internal\/credits\/holds\/([^/]+)\/release$/.exec(path);
        if (release) {
            const id = decodeURIComponent(release[1]);
            const hold = [...state.holds.values()].find((h) => h.hold_id === id);
            if (hold && hold.status !== 'settled') {
                state.released.set(id, { hold_id: id, released_nano_usd: hold.held_nano_usd });
                state.held -= BigInt(hold.held_nano_usd);
                hold.status = 'released';
            }
            return json(200, state.released.get(id) || { hold_id: id, released_nano_usd: '0' });
        }
        return json(404, { code: 'not_found', detail: path });
    }
    return { state, fetchImpl, available, chargeOf };
}

function managerFor(billing, { balance } = {}) {
    return createCredits({
        config: { credits: { enabled: true, billingUrl: 'http://billing.test', audience: 'openvibe.billing', timeoutMs: 1000 }, console: { clientId: 'ai' } },
        tokens: { getToken: async () => 'test-token' }, fetchImpl: billing.fetchImpl, log: { warn() {}, log() {}, error() {} },
    });
}

function begin(manager, { requestId = 'req_credits_0001', input = {}, extra = {} } = {}) {
    return manager.begin({ requestId, ctx: { runId: 'run_1', requesterType: 'app', requesterId: APP, appId: APP, projectId: PRJ, ...extra }, input: { messages: [{ role: 'user', content: 'hello' }], ...input } });
}

t.test('the hold is the worst case at the retail card: the input estimate plus max_tokens of output', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    const before = billing.state.calls.length;
    await session.onRoute(FACTS, { retail: R1, maxTokens: 1000 });
    const call = billing.state.calls[before];
    assert.strictEqual(call.path, '/internal/credits/holds');
    const expected = BigInt(session.inputTokens) * 1000n + 1000n * 2000n;   // $1/M input, $2/M output, in nano
    assert.strictEqual(call.body.max_nano_usd, String(expected));
    assert.strictEqual(call.body.rate_version, 'retail-1');
    assert.deepStrictEqual(call.body.subject, { type: 'app', id: APP });
    assert.strictEqual(call.body.project_id, PRJ);
    assert.match(call.body.request_fingerprint, /^[0-9a-f]{64}$/);
});

t.test('a 402 from Billing is AI\'s own 402, raised before the provider (onRoute never returns)', async () => {
    const billing = fakeBilling({ balance: '0' });
    const manager = managerFor(billing);
    const session = begin(manager);
    await assert.rejects(session.onRoute(FACTS, { retail: R1, maxTokens: 100 }), (err) => err.status === 402 && err.code === 'billing.insufficient_funds');
    assert.strictEqual(session.holdId, null, 'no hold exists to settle or release');
    assert.strictEqual(billing.state.settlements.size, 0);
});

t.test('one settle per request: the second call is a no-op, and a retried request replays Billing\'s answer', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const first = await session.settle({ usage: { input: 100, output: 10 }, supplyCostUsd: 0.000001, attempts: [{ deployment_id: 'up:gpt-up', provider: 'up', model: 'gpt-up', started_at: new Date().toISOString(), ended_at: new Date().toISOString() }] });
    const again = await session.settle({ usage: { input: 100, output: 10 } });
    assert.ok(first && first.charge_nano_usd);
    assert.strictEqual(again, null, 'the same session settles once');
    assert.strictEqual(billing.state.settlements.size, 1, 'one settlement');
    // A retried request (same request id) replays the hold and the settlement: no second charge.
    const retried = begin(manager);
    await retried.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const replay = await retried.settle({ usage: { input: 100, output: 10 }, attempts: [] });
    assert.strictEqual(replay.charge_nano_usd, first.charge_nano_usd);
    assert.strictEqual(billing.state.settlements.size, 1, 'still one settlement, replayed');
    assert.strictEqual(billing.chargeOf({ input_tokens: 100, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 10 }, retailOf(R1)).toString(), first.charge_nano_usd);
});

t.test('an abort mid-stream settles the partial usage it streamed', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 1000 });
    session.observe({ delta: { content: 'x'.repeat(80) } });          // 20 output tokens estimated
    assert.strictEqual(session.streamedChars, 80);
    await session.settle({ usage: { input: session.inputTokens, output: Math.ceil(session.streamedChars / 4) } });
    const settlement = [...billing.state.settlements.values()][0];
    assert.strictEqual(settlement.result.settlement.usage.output_tokens, 20);
    assert.ok(BigInt(settlement.result.charge_nano_usd) > 0n, 'the partial answer was charged');
});

t.test('an error before the first token releases the hold with nothing charged', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const out = await session.release();
    assert.ok(out.released_nano_usd);
    assert.strictEqual(billing.state.settlements.size, 0);
    assert.strictEqual(await session.settle({ usage: { input: 10, output: 0 } }), null);
});

t.test('a fallback settles once with both attempts and the answering model\'s card', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute({ ...FACTS, resolved_model: 'org/one@r1' }, { retail: R1, maxTokens: 100 });
    await session.onRoute({ ...FACTS, resolved_model: 'org/two@r1', deployment: 'up2', rate_version: 'retail-2' }, { retail: R2, maxTokens: 100 });
    const attempts = [
        { deployment_id: 'up:one', provider: 'up', model: 'one', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: 'provider.error' },
        { deployment_id: 'up2:two', provider: 'up2', model: 'two', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: null },
    ];
    const out = await session.settle({ usage: { input: 100, output: 20 }, attempts });
    assert.strictEqual(billing.state.settlements.size, 1);
    const saved = [...billing.state.settlements.values()][0];
    assert.strictEqual(saved.result.settlement.retail.version, 'retail-2', 'the card of the model that answered');
    assert.strictEqual(saved.result.settlement.attempts.length, 2);
    assert.strictEqual(billing.state.calls.filter((c) => c.path.endsWith('/settle')).length, 1);
    assert.ok(out.charge_nano_usd);
});

t.test('BYOK is never held and never charged', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(BYOK_FACTS, { retail: R1, maxTokens: 100 });     // a person's own key: no meta, or CUSTOMER_BYOK
    await session.onRoute(BYOK_FACTS);
    assert.strictEqual(session.holdId, null);
    assert.strictEqual(billing.state.calls.length, 0, 'Billing was never called');
    assert.strictEqual(await session.settle({ usage: { input: 100, output: 20 } }), null);
});

t.test('a stream near the hold is extended in a step (and never past max_cost_usd)', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    // A tiny hold: $1/M output, max_tokens 1 => 1000 nano-USD held for the output.
    const cheap = { ...R1, input_nano_usd_per_m: '0', output_nano_usd_per_m: '1000000000' };
    await session.onRoute(FACTS, { retail: cheap, maxTokens: 1 });
    const hold = BigInt(session.heldNano);
    assert.ok(hold > 0n);
    // 40 chars => 10 output tokens => 10,000 nano, past 80% of the hold.
    session.observe({ delta: { content: 'y'.repeat(40) } });
    await new Promise((r) => setTimeout(r, 20));
    const extend = billing.state.calls.find((c) => c.path.endsWith('/extend'));
    assert.ok(extend, 'the hold was extended');
    assert.ok(BigInt(extend.body.add_nano_usd) > 0n);

    // max_cost_usd caps the total: a second session holds at most the cap.
    const capped = begin(manager, { requestId: 'req_credits_cap', extra: { maxCostUsd: 0.000002 } });   // 2,000 nano
    await capped.onRoute(FACTS, { retail: cheap, maxTokens: 16000 });
    assert.strictEqual(capped.heldNano, 2000n);
});

t.test('no project, no subject or the flag off means no session at all', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    assert.strictEqual(manager.begin({ requestId: 'req_1', ctx: { requesterType: 'service', requesterId: 'live' } }), null, 'a first-party run with no project is not held');
    assert.strictEqual(manager.begin({ requestId: 'req_2', ctx: { requesterType: 'user', requesterId: 'usr_x', projectId: PRJ } }), null, 'an unknown payer is not held');
    assert.strictEqual(createCredits({ config: { credits: { enabled: false } }, tokens: { getToken: async () => 't' }, fetchImpl: billing.fetchImpl }), null, 'AI_CREDITS off -> no manager, nothing changes');
});

t.test('credits on with no Billing configured refuses a paid managed offer instead of serving it free', async () => {
    const manager = createCredits({ config: { credits: { enabled: true, billingUrl: '' }, console: { clientId: 'ai' } }, env: { OV_OAUTH_CLIENT_SECRET: 'test-secret' }, tokens: { getToken: async () => 't' }, fetchImpl: fakeBilling().fetchImpl, log: { warn() {}, log() {}, error() {} } });
    const session = begin(manager);
    await assert.rejects(session.onRoute(FACTS, { retail: R1, maxTokens: 100 }), (err) => err.status === 503 && err.code === 'billing.unavailable');
});

t.run();
