'use strict';
// AI Exchange F / P7 + D12: the Balance session (server/credits.js) against a fake Billing, without HTTP. Covers
// the review's money rules and D12's payer: the worst-case hold at the retail card, a decimal-only max_cost_usd
// that clamps the output, an app holding its project's Balance (subject app + project_id, no Network lookup), a
// person holding their personal Balance (no project_id), a pricier managed fallback extending the hold, one settle
// per request, the partial usage of an abort, release before a first token, BYOK never held, the streaming
// extension, contract-valid request bodies, and AI_CREDITS off.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { suite } = require('./helpers');
const { createCredits, retailOf, parseCostUsd, affordable } = require('../server/credits');

const t = suite('credits');

const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const APP = 'app_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP7';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const R1 = { version: 'retail-1', input_nano_usd_per_m: '1000000000', output_nano_usd_per_m: '2000000000', cached_read_nano_usd_per_m: '0', cache_write_nano_usd_per_m: '0', per_request_nano_usd: '0' };
const R2 = { version: 'retail-2', input_nano_usd_per_m: '500000000', output_nano_usd_per_m: '4000000000', cached_read_nano_usd_per_m: '0', cache_write_nano_usd_per_m: '0', per_request_nano_usd: '0' };
const FACTS = { resolved_model: 'org/model@r1', revision: 'r1', deployment: 'up', provider_access: 'OWN_DEPLOYMENT', rate_version: 'retail-1', policy: null, fallback_reason: null };
const BYOK_FACTS = { ...FACTS, provider_access: 'CUSTOMER_BYOK' };

/** A tiny Billing: holds/settlements like PR #187. Network is not part of D12's hold path. */
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
            if (state.refuseExtend) return json(402, { code: 'billing.insufficient_funds', detail: 'cannot extend' });
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
            const result = { charge_nano_usd: String(charge), released_nano_usd: String(charge >= held ? 0n : held - charge), journal_id: `txn_${state.settlements.size + 1}`, settlement: { usage: body.usage, retail: body.retail, attempts: body.attempts } };
            state.settlements.set(body.idempotency_key, { hold_id: id, result });
            hold.status = 'settled';
            state.held -= held;
            state.balance -= charge;
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

function managerFor(billing, overrides = {}) {
    return createCredits({
        config: { credits: { enabled: true, billingUrl: 'http://billing.test', audience: 'openvibe.billing', timeoutMs: 1000 }, console: { clientId: 'ai' } },
        tokens: { getToken: async () => 'billing-token' },
        fetchImpl: billing.fetchImpl, log: { warn() {}, log() {}, error() {} },
        ...overrides,
    });
}

function begin(manager, { requestId = 'req_credits_0001', input = {}, extra = {} } = {}) {
    return manager.begin({ requestId, ctx: { runId: 'run_1', requesterType: 'app', requesterId: APP, appId: APP, projectId: PRJ, ...extra }, input: { messages: [{ role: 'user', content: 'hello' }], ...input } });
}

/** A person's own run: a user subject, and (deliberately) a project attribution the hold must not use. */
function beginPerson(manager, { requestId = 'req_credits_person_0001', input = {}, attribution = { type: 'project', id: PRJ } } = {}) {
    return manager.begin({ requestId, ctx: { runId: 'run_person', requesterType: 'service', requesterId: 'live' }, attribution, onBehalfOf: OWNER, input: { messages: [{ role: 'user', content: 'hello' }], ...input } });
}

const callsTo = (billing, suffix) => billing.state.calls.filter((c) => c.path.endsWith(suffix));

t.test('max_cost_usd is an exact decimal: 0.29, 0.000000001, and 0.0000000011 rounding up to 2 nano', () => {
    assert.strictEqual(parseCostUsd(0.29), 290000000n);
    assert.strictEqual(parseCostUsd('0.000000001'), 1n);
    assert.strictEqual(parseCostUsd('0.0000000011'), 2n);
    assert.strictEqual(parseCostUsd('1.0000000004'), 1000000001n);
    assert.strictEqual(parseCostUsd('0'), 0n);
    assert.throws(() => parseCostUsd('1e-9'), (err) => err.status === 422 && err.code === 'input.invalid');
    assert.throws(() => parseCostUsd('0.1e2'), (err) => err.status === 422);
    assert.throws(() => parseCostUsd('-1'), (err) => err.status === 422);
    assert.throws(() => parseCostUsd('abc'), (err) => err.status === 422);
});

t.test('max_cost_usd caps the worst case by clamping the affordable output tokens in BigInt', () => {
    const retail = retailOf({ ...R1, input_nano_usd_per_m: '0' });
    assert.deepStrictEqual(affordable(retail, { inputTokens: 0, maxTokens: 100, maxCostNano: 10000n }), { maxTokens: 5, amount: 10000n });
    assert.deepStrictEqual(affordable(retail, { inputTokens: 0, maxTokens: 100, maxCostNano: 9999n }).maxTokens, 4);
    assert.throws(() => affordable(retail, { inputTokens: 0, maxTokens: 100, maxCostNano: 1999n }), (err) => err.status === 402 && err.code === 'billing.insufficient_funds');
    assert.deepStrictEqual(affordable(retail, { inputTokens: 0, maxTokens: 3 }), { maxTokens: 3, amount: 6000n });
});

t.test('an app\'s hold names the app and its project: no Network lookup, and nothing is cached', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    const routed = await session.onRoute(FACTS, { retail: R1, maxTokens: 1000 });
    const call = billing.state.calls.find((c) => c.path === '/internal/credits/holds');
    const expected = BigInt(session.inputTokens) * 1000n + 1000n * 2000n;   // $1/M input, $2/M output, in nano
    assert.strictEqual(call.body.max_nano_usd, String(expected));
    assert.strictEqual(call.body.rate_version, 'retail-1');
    assert.deepStrictEqual(call.body.subject, { type: 'app', id: APP }, 'an app is the payer, not its owner');
    assert.strictEqual(call.body.project_id, PRJ, 'the hold spends the project\'s Balance');
    assert.match(call.body.request_fingerprint, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(routed, { maxTokens: 1000 });
    // A second app request holds too; there is no owner to resolve or cache.
    const second = begin(manager, { requestId: 'req_credits_0002' });
    await second.onRoute(FACTS, { retail: R1, maxTokens: 10 });
    assert.strictEqual(callsTo(billing, '/holds').length, 2);
    assert.strictEqual(billing.state.calls.filter((c) => c.path.includes('/internal/projects/')).length, 0, 'Network was never called');
});

t.test('a person\'s own run holds their personal Balance: subject user, no project_id', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = beginPerson(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const call = callsTo(billing, '/holds').pop();
    assert.deepStrictEqual(call.body.subject, { type: 'user', id: OWNER });
    assert.ok(!Object.prototype.hasOwnProperty.call(call.body, 'project_id'), 'a personal hold carries no project_id');
    assert.strictEqual(callsTo(billing, '/holds').length, 1);
    assert.strictEqual(billing.state.calls.filter((c) => c.path.includes('/internal/projects/')).length, 0, 'Network was never called');
});

t.test('an app without a project gets no session, so no unpaid paid offer can run', () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const raw = manager.begin({ requestId: 'req_credits_noproject', ctx: { requesterType: 'app', requesterId: APP, appId: APP }, input: { messages: [] } });
    assert.strictEqual(raw, null);
    assert.strictEqual(billing.state.calls.length, 0);
});

t.test('a 402 from Billing is AI\'s own 402, raised before the provider (onRoute never returns)', async () => {
    const billing = fakeBilling({ balance: '0' });
    const manager = managerFor(billing);
    const session = begin(manager);
    await assert.rejects(session.onRoute(FACTS, { retail: R1, maxTokens: 100 }), (err) => err.status === 402 && err.code === 'billing.insufficient_funds' && err.detail === 'Not enough Balance');
    assert.strictEqual(session.holdId, null, 'no hold exists to settle or release');
    assert.strictEqual(billing.state.settlements.size, 0);
});

t.test('one settle per request: the second call is a no-op, and a retried request replays Billing\'s answer', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const first = await session.settle({ usage: { input: 100, output: 10 }, supplyCostUsd: 0.000001, attempts: [{ deployment_id: 'up:gpt-up', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: null }] });
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

t.test('a pricier managed fallback extends the hold by the difference, and a refused extension skips it', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const before = BigInt(session.heldNano);
    const routed = await session.onRoute({ ...FACTS, resolved_model: 'org/two@r1', deployment: 'up2', rate_version: 'retail-2' }, { retail: R2, maxTokens: 100 });
    const extend = callsTo(billing, '/extend').pop();
    const after = BigInt(session.heldNano);
    assert.ok(after > before, 'the hold grew');
    assert.strictEqual(extend.body.add_nano_usd, String(after - before));
    assert.deepStrictEqual(routed, { maxTokens: 100 });
    const out = await session.settle({ usage: { input: 100, output: 20 }, attempts: [
        { deployment_id: 'up:one', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: 'provider.error' },
        { deployment_id: 'up2:two', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: null },
    ] });
    assert.strictEqual(billing.state.settlements.size, 1);
    const saved = [...billing.state.settlements.values()][0];
    assert.strictEqual(saved.result.settlement.retail.version, 'retail-2', 'the card of the model that answered');
    assert.strictEqual(saved.result.settlement.attempts.length, 2);
    assert.ok(out.charge_nano_usd);

    // The same fallback, but Billing refuses the extension: the offer is skipped, never run.
    const refused = fakeBilling();
    refused.state.refuseExtend = true;
    const m2 = managerFor(refused);
    const s2 = begin(m2);
    await s2.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    const skip = await s2.onRoute({ ...FACTS, resolved_model: 'org/two@r1', deployment: 'up2' }, { retail: R2, maxTokens: 100 });
    assert.deepStrictEqual(skip, { skip: 'hold_not_extended' });
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

    // max_cost_usd caps the total: a second session holds at most the cap and clamps its max_tokens.
    const capped = begin(manager, { requestId: 'req_credits_cap', extra: { maxCostNano: '2000' } });
    const routed = await capped.onRoute(FACTS, { retail: cheap, maxTokens: 16000 });
    assert.deepStrictEqual(routed, { maxTokens: 2 });
    assert.strictEqual(capped.heldNano, 2000n);
});

t.test('the outgoing app and personal hold, extend and settle bodies validate against v0.289.1', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    await session.onRoute({ ...FACTS, resolved_model: 'org/two@r1', deployment: 'up2', rate_version: 'retail-2' }, { retail: R2, maxTokens: 100 });
    await session.settle({ usage: { input: 100, output: 20 }, attempts: [
        { deployment_id: 'up:one', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: 'provider.error' },
        { deployment_id: 'up2:two', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), error_code: null },
    ] });
    const person = beginPerson(manager);
    await person.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    await person.settle({ usage: { input: 100, output: 20 }, attempts: [] });
    const holds = callsTo(billing, '/holds').map((c) => c.body);
    const extend = callsTo(billing, '/extend').pop().body;
    const settle = callsTo(billing, '/settle')[0].body;
    assert.strictEqual(holds.length, 2);
    assert.strictEqual(holds[0].project_id, PRJ, 'the app hold names its project');
    assert.ok(!('project_id' in holds[1]), 'the personal hold does not');
    for (const hold of holds) {
        const v = contracts.validate('billing.credit-hold-create-request@1', hold);
        assert.ok(v.valid, `billing.credit-hold-create-request@1: ${JSON.stringify(v.errors && v.errors.slice(0, 3))}`);
    }
    for (const [schema, body] of [['billing.credit-hold-extend-request@1', extend], ['billing.credit-hold-settle-request@1', settle]]) {
        const v = contracts.validate(schema, body);
        assert.ok(v.valid, `${schema}: ${JSON.stringify(v.errors && v.errors.slice(0, 3))}`);
    }
    assert.deepStrictEqual(Object.keys(settle.attempts[0]).sort(), ['deployment_id', 'ended_at', 'error_code', 'provider_access', 'started_at'], 'the contract\'s exact attempt shape');
});

t.test('BYOK is never held, never charged and Billing is never called', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    const session = begin(manager);
    await session.onRoute(BYOK_FACTS, { retail: R1, maxTokens: 100 });     // a person's own key: no meta, or CUSTOMER_BYOK
    await session.onRoute(BYOK_FACTS);
    assert.strictEqual(session.holdId, null);
    assert.strictEqual(billing.state.calls.length, 0, 'Billing was never called');
    assert.strictEqual(await session.settle({ usage: { input: 100, output: 20 } }), null);
});

t.test('no payer means no session; a person without a project does get one; no Billing refuses paid offers', async () => {
    const billing = fakeBilling();
    const manager = managerFor(billing);
    assert.strictEqual(manager.begin({ requestId: 'req_1', ctx: { requesterType: 'service', requesterId: 'live' } }), null, 'a first-party service with no person has no payer');
    const person = manager.begin({ requestId: 'req_2', ctx: { requesterType: 'service', requesterId: 'live' }, onBehalfOf: OWNER });
    assert.ok(person, 'a person gets a personal session with no project');
    const created = await person.onRoute(FACTS, { retail: R1, maxTokens: 100 });
    assert.deepStrictEqual(created, { maxTokens: 100 });
    const hold = callsTo(billing, '/holds')[0].body;
    assert.deepStrictEqual(hold.subject, { type: 'user', id: OWNER });
    assert.ok(!('project_id' in hold));
    assert.strictEqual(createCredits({ config: { credits: { enabled: false } }, tokens: { getToken: async () => 't' }, fetchImpl: billing.fetchImpl }), null, 'AI_CREDITS off -> no manager, nothing changes');
    // Billing on, Billing URL missing: a paid managed offer must refuse rather than run free.
    const unconfigured = createCredits({ config: { credits: { enabled: true, billingUrl: '' }, console: { clientId: 'ai' } }, env: { OV_OAUTH_CLIENT_SECRET: 'test-secret' }, tokens: { getToken: async () => 't' }, fetchImpl: billing.fetchImpl, log: { warn() {}, log() {}, error() {} } });
    const blocked = unconfigured.begin({ requestId: 'req_4', ctx: { requesterType: 'service', requesterId: 'live' }, onBehalfOf: OWNER });
    await assert.rejects(blocked.onRoute(FACTS, { retail: R1, maxTokens: 100 }), (err) => err.status === 503 && err.code === 'billing.unavailable');
});

t.run();
