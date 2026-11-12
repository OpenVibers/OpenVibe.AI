'use strict';
// Decisions (2026-11-12): POST /api/v1/decisions answers closed-set questions about one input. With a Gemini key the
// call goes to Google's Decisions API (gemini-decision-1) and comes back calibrated, metered at $0.10 per 1M input
// tokens; without one (or when Google fails) the router's cheap structured route answers text through decide.fallback,
// normalized to the same shape and marked calibrated: false; pictures without the Decisions API are refused honestly.
const assert = require('assert');
const { boot, request, seamServer, suite, token } = require('./helpers');
const { checked } = require('../server/api/decisions');
const { answerOf } = require('../server/workflows/decide');

const t = suite('decisions');
const CAP = token('network', ['ai.run.create'], { sub: 'svc:network' });
const NOCAP = token('network', ['ai.layout.suggest'], { sub: 'svc:network' });
const QUESTIONS = {
    is_spam: { type: 'noul', instructions: 'Is this message spam?' },
    kind: { type: 'choice', instructions: 'What is it?', criteria: { bug: 'Something is broken.', idea: 'A wish for something new.' } },
    severity: { type: 'score', instructions: 'How bad is it?', criteria: ['fine', 'minor', 'major'] },
};

t.test('the request is checked: names, types, choices, rubric levels', async () => {
    assert.throws(() => checked({ input: 'x', questions: {} }), /1 to 1000 questions/);
    assert.throws(() => checked({ input: 'x', questions: { 'Bad Name': { type: 'noul', instructions: 'x' } } }), /question name/);
    assert.throws(() => checked({ input: 'x', questions: { a: { type: 'maybe', instructions: 'x' } } }), /noul, choice or score/);
    assert.throws(() => checked({ input: 'x', questions: { a: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } } }), /2 to 255 options/);
    assert.throws(() => checked({ input: 'x', questions: { a: { type: 'score', instructions: 'x', criteria: ['one'] } } }), /2 to 20 rubric levels/);
    assert.throws(() => checked({ input: [{ type: 'image', uri: 'http://insecure' }], questions: { a: { type: 'noul', instructions: 'x' } } }), /https uri/);
    const ok = checked({ input: 'hello', questions: QUESTIONS });
    assert.strictEqual(ok.onlyText, true);
    assert.strictEqual(ok.prefer, 'calibrated');
});

t.test('the fallback\'s answers are normalized to the Decisions API\'s shape', async () => {
    assert.deepStrictEqual(answerOf(QUESTIONS.is_spam, { noul: 1.4 }), { type: 'noul', noul: 0.99, confidence: 0.99 });
    const c = answerOf(QUESTIONS.kind, { choice: 'nonsense', probabilities: { bug: 3, idea: 1 } });
    assert.deepStrictEqual([c.choice, c.probabilities], ['bug', { bug: 0.75, idea: 0.25 }], 'probabilities sum to 1 and the winner is a listed option');
    const s = answerOf(QUESTIONS.severity, { probabilities: { 0: 0, 1: 1, 2: 1 } });
    assert.strictEqual(s.score, 1.5);
    assert.deepStrictEqual(s.legend, { 0: 'fine', 1: 'minor', 2: 'major' });
});

t.test('with a Gemini key: Google\'s Decisions API, calibrated and metered; without one: the router, not calibrated', async () => {
    const google = [];
    let googleDown = false;
    const fetchImpl = async (url, opts) => {
        if (String(url) === 'https://generativelanguage.googleapis.com/v1beta/decisions') {
            google.push({ key: opts.headers['x-goog-api-key'], body: JSON.parse(opts.body) });
            if (googleDown) return { ok: false, status: 503, json: async () => ({ error: { message: 'down' } }) };
            return { ok: true, status: 200, json: async () => ({ answers: { is_spam: { type: 'noul', noul: 0.04, confidence: 0.96 } }, usage: { total_input_tokens: 2000000, total_output_tokens: 0 } }) };
        }
        return globalThis.fetch(url, opts);
    };
    const seam = await seamServer(async () => ({ json: { answers: { is_spam: { noul: 0.2 }, kind: { choice: 'idea', probabilities: { bug: 0.1, idea: 0.9 } }, severity: { probabilities: { 0: 1 } } } } }));
    const h = await boot({ fetchImpl, env: { AI_HTTP_SEAM_URL: seam.url, AI_USER_MODULES: 'off', AI_FREE_PROVIDERS: 'http-seam', AI_FREE_DAILY_TOKENS: '100000', GEMINI_DECIDE_TEST_KEY: 'g-key' } });
    try {
        await h.registry.upsertProvider({ key: 'http-seam', capabilities: ['chat', 'generate', 'json', 'classify'], default_model: 'decide-fake', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'http-seam', model_key: 'decide-fake', type: 'chat', status: 'active', supports: { json: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });
        await h.registry.upsertProvider({ key: 'stub', status: 'disabled' }, { actor: 'test' });

        assert.strictEqual((await request(h.base, 'POST', '/api/v1/decisions', { tok: NOCAP, body: { input: 'buy cheap pills', questions: QUESTIONS } })).status, 403, 'needs ai.run.create');

        // No Gemini key yet: the router answers, estimated.
        let r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'Could the menu remember my last tab?', questions: QUESTIONS } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.calibrated, false);
        assert.strictEqual(r.body.answers.kind.choice, 'idea');
        assert.strictEqual(r.body.answers.is_spam.noul, 0.2);
        assert.strictEqual(r.body.receipt.model, 'decide-fake');
        assert.strictEqual(google.length, 0);

        // Pictures need the Decisions API.
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: [{ type: 'image', uri: 'https://example.com/a.png' }], questions: { is_cat: { type: 'noul', instructions: 'Is it a cat?' } } } });
        assert.strictEqual(r.status, 503, r.text);

        // With the gemini provider's key: Google answers, calibrated, and the call is metered.
        await h.registry.upsertProvider({ key: 'gemini', secret_ref: 'env:GEMINI_DECIDE_TEST_KEY' }, { actor: 'test' });
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'buy cheap pills', questions: { is_spam: QUESTIONS.is_spam } } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.calibrated, true);
        assert.deepStrictEqual(r.body.answers.is_spam, { type: 'noul', noul: 0.04, confidence: 0.96 });
        assert.deepStrictEqual([google[0].key, google[0].body.model, google[0].body.input], ['g-key', 'gemini-decision-1', 'buy cheap pills']);
        assert.strictEqual(r.body.receipt.cost_usd, 0.2, '2M input tokens at $0.10 per 1M, nothing for output');
        const row = await h.db.prepare("SELECT provider_key, model_key, cost_usd FROM requests WHERE provider_key = 'gemini' ORDER BY id DESC LIMIT 1").get();
        assert.deepStrictEqual([row.model_key, Number(row.cost_usd)], ['gemini-decision-1', 0.2], 'metered like any request');

        // Google away: the router answers the text instead.
        googleDown = true;
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'buy cheap pills', questions: QUESTIONS } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.calibrated, false);
    } finally { await h.stop(); await seam.close(); }
});

t.run();
