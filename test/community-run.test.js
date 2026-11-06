'use strict';
// Opting a request in to community capacity (design: "Offer to the network"): x-openvibe-community: 1 is the only
// thing that lets the router place a run on a person's machine, the answer is labelled in x_openvibe.community and
// X-OpenVibe-Community, and a request without it never reaches the community layer.
const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('community-run');
const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';
let h;
let calls = [];

const result = (ctx) => ({
    result: { completion: { choices: [{ index: 0, message: { role: 'assistant', content: 'from a community box' }, finish_reason: 'stop' }], system_fingerprint: null },
        text: 'from a community box', json: null, model: 'llama3.1:8b', usage: { input: 10, output: 5 } },
    provider: 'community:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', providerKind: 'community', model: 'llama3.1:8b', fallbackUsed: false,
    usage: { input: 10, output: 5 }, cost: 0, latencyMs: 1, ttftMs: null, synthetic: false, tried: [], startedAt: 0,
    explain: { objective: 'community', reasons: ['a community machine offered llama3.1:8b'], selected: 'community:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1/llama3.1:8b',
        paid_by: 'community', candidates: [], attempts: [], community: { machine_id: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', owner: OWNER, model: 'llama3.1:8b', verification: 'verified', reputation: 50 },
        openvibe: { resolved_model: 'community/llama3.1:8b', revision: null, deployment: 'community:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', provider_access: 'COMMUNITY',
            rate_version: 'community', policy: 'community', community: { machine_id: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', owner: OWNER, model: 'llama3.1:8b',
                price: { in_per_million: 10, out_per_million: 30 }, verification: 'verified', reputation: 50, free_tier: true } } },
});

t.test('boot', async () => {
    h = await boot({ community: {
        enabled: true, publicOffers: async () => [], sell: async () => ({ offers: [], totals: {} }),
        execute: async ({ ctx }) => { calls.push(ctx); return result(ctx); },
    } });
});

t.test('a request without the opt-in never reaches a person\'s machine', async () => {
    calls = [];
    const r = await request(h.base, 'POST', '/v1/chat/completions', { tok: token('live', ALL), body: { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(r.headers.get('x-openvibe-community'), null);
});

t.test('x-openvibe-community places it and labels the answer', async () => {
    calls = [];
    const r = await request(h.base, 'POST', '/v1/chat/completions', { tok: token('live', ALL), headers: { 'x-openvibe-community': '1' },
        body: { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].communityOptIn, true);
    assert.strictEqual(r.headers.get('x-openvibe-community'), '1');
    assert.strictEqual(r.body.x_openvibe.community.owner, OWNER);
    assert.strictEqual(r.body.x_openvibe.community.verification, 'verified');
    assert.strictEqual(r.body.choices[0].message.content, 'from a community box');
});

t.test('a failed community machine falls back to the network and is not labelled', async () => {
    calls = [];
    const before = h.community;
    // The real pool catches the failure and answers from the ordinary route.
    const saved = before.execute;
    before.execute = async () => { const err = new Error('community machine failed its canary'); err.code = 'community.verification_failed'; err.status = 502; throw err; };
    try {
        const r = await request(h.base, 'POST', '/v1/chat/completions', { tok: token('live', ALL), headers: { 'x-openvibe-community': '1' },
            body: { model: 'openvibe/auto', messages: [{ role: 'user', content: 'hi' }] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('x-openvibe-community'), null);
        assert.ok(r.body.x_openvibe.community == null, 'no community label on a network answer');
    } finally { before.execute = saved; }
});

t.test('the body flag says the same as the header', async () => {
    calls = [];
    const r = await request(h.base, 'POST', '/v1/chat/completions', { tok: token('live', ALL),
        body: { model: 'openvibe/auto', x_openvibe: { community: true }, messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(calls.length, 1);
});

t.run();
