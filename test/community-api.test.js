'use strict';
// The community AI API Exchange reads (design: "Offer to the network"): /api/v1/community/offers is public and never
// names an owner; /api/v1/community/sell is the seller's dashboard (tokens, credits, uptime, verification,
// reputation) for the owner a service names in X-OV-Subject with ai.run.read.
const assert = require('assert');
const { boot, request, token, suite } = require('./helpers');

const OWNER = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1';

const t = suite('community-api');

t.test('the seller dashboard is guarded and reads the recorded tokens and credits', async () => {
    const h = await boot({ env: { AI_COMMUNITY: 'false' } });
    try {
        const key = `ai:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1|llama3.1:8b`;
        await h.db.prepare(`INSERT INTO community_offers (offer_key, offer_id, machine_id, owner_subject, model, models, price_in, price_out, status,
            canary_passes, last_canary_at, checks, up_checks, reputation, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'llama3.1:8b', '["llama3.1:8b"]', 10, 30, 'verified', 3, now(), 4, 4, 90, now(), now())`)
            .run(key, 'ai:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', OWNER);
        await h.db.prepare(`INSERT INTO community_usage (id, offer_key, offer_id, machine_id, owner_subject, model, request_id, tokens_in, tokens_out, credits_micro, verified, created_at)
            VALUES ('cu_test', ?, 'ai:dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', ?, 'llama3.1:8b', 'run-1', 1000, 500, 25000, true, now())`)
            .run(key, OWNER);
        const anon = await request(h.base, 'GET', '/api/v1/community/sell', { headers: { 'X-OV-Subject': OWNER } });
        assert.strictEqual(anon.status, 401);
        const tok = token('exchange', ['ai.run.read']);
        const out = await request(h.base, 'GET', '/api/v1/community/sell', { tok, headers: { 'X-OV-Subject': OWNER } });
        assert.strictEqual(out.status, 200, out.text);
        assert.strictEqual(out.body.owner, OWNER);
        assert.deepStrictEqual([out.body.totals.tokens_in, out.body.totals.tokens_out, out.body.totals.credits_micro], [1000, 500, 25000]);
        assert.strictEqual(out.body.totals.credits, 0.025);
        assert.strictEqual(out.body.offers[0].verification.status, 'verified');
        assert.strictEqual(out.body.offers[0].uptime_pct, 100);
        assert.strictEqual(out.body.offers[0].reputation, 90);
        const bad = await request(h.base, 'GET', '/api/v1/community/sell', { tok, headers: { 'X-OV-Subject': 'not-a-subject' } });
        assert.strictEqual(bad.status, 422);
        const pub = await request(h.base, 'GET', '/api/v1/community/offers');
        assert.strictEqual(pub.status, 200);
        assert.deepStrictEqual(pub.body.offers, [], 'with community offers off, the public list is empty');
    } finally { await h.stop(); }
});

t.run();
