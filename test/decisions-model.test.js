'use strict';
// The decisions model (2026-11-14): the model that answers is the one the caller names, else the kind's own
// default, else today's order; an unknown id is a 400 in plain words; an answer that is not sure enough is asked
// again of the next model in the kind's ladder, once; and GET /api/v1/decisions/models lists every model that
// can answer, with its price, its measured speed and whether its answers are calibrated.
const assert = require('assert');
const { boot, request, seamServer, suite, token } = require('./helpers');

const t = suite('decisions-model');
const CAP = token('network', ['ai.run.create'], { sub: 'svc:network' });
const OWNER = token('network', ['ai.run.create', 'ai.provider.manage'], { sub: 'svc:network' });
const QUESTIONS = { is_spam: { type: 'noul', instructions: 'Is this message spam?' } };

// Two stub providers on one local seam: one answers unsure, the other answers sure.
const unsureAnswer = { json: { answers: { is_spam: { noul: 0.5 } } } };
const sureAnswer = { json: { answers: { is_spam: { noul: 0.9 } } } };

t.test('the models list: Google\'s decision model and every catalogue model with structured output', async () => {
    const google = [];
    const fetchImpl = async (url, opts) => {
        if (String(url) === 'https://generativelanguage.googleapis.com/v1beta/decisions') {
            google.push(JSON.parse(opts.body));
            return { ok: true, status: 200, json: async () => ({ answers: { is_spam: { type: 'noul', noul: 0.99, confidence: 0.99 } }, usage: { total_input_tokens: 1000 } }) };
        }
        return globalThis.fetch(url, opts);
    };
    const seam = await seamServer(async () => sureAnswer);
    const h = await boot({ fetchImpl, env: { AI_HTTP_SEAM_URL: seam.url, AI_USER_MODULES: 'off', AI_FREE_PROVIDERS: 'http-seam,http-seam2', AI_FREE_DAILY_TOKENS: '100000', GEMINI_DECIDE_TEST_KEY: 'g-key' } });
    try {
        await h.registry.upsertProvider({ key: 'http-seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['chat', 'generate', 'json', 'classify'], default_model: 'decide-fake', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'http-seam', model_key: 'decide-fake', type: 'chat', status: 'active', supports: { json: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });
        await h.registry.upsertProvider({ key: 'http-seam2', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['chat', 'generate', 'json', 'classify'], default_model: 'decide-cheap', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'http-seam2', model_key: 'decide-cheap', type: 'chat', status: 'active', supports: { json: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });

        // The list is public: no token is needed.
        const list = await request(h.base, 'GET', '/api/v1/decisions/models');
        assert.strictEqual(list.status, 200, list.text);
        assert.ok(list.body.count >= 3, 'the two stub models and Google\'s');
        assert.strictEqual(list.headers.get('cache-control'), 'public, max-age=600');
        for (const m of list.body.models) {
            for (const key of ['id', 'provider', 'price_in_per_mtok', 'price_out_per_mtok', 'speed_p50_ms', 'calibrated', 'max_questions', 'inputs', 'available']) {
                assert.ok(key in m, 'a model says ' + key);
            }
            assert.ok(Array.isArray(m.inputs) && m.inputs.includes('text'));
        }
        const g = list.body.models.find((m) => m.id === 'gemini/gemini-decision-1');
        assert.ok(g, 'Google\'s decision model is listed');
        assert.deepStrictEqual([g.provider, g.calibrated, g.max_questions, g.price_in_per_mtok], ['gemini', true, 1000, 0.1]);
        assert.deepStrictEqual(g.inputs, ['text', 'image', 'audio', 'video', 'document']);
        const fake = list.body.models.find((m) => m.id === 'http-seam/decide-fake');
        assert.ok(fake, 'the stub model is listed');
        assert.deepStrictEqual([fake.provider, fake.calibrated, fake.max_questions, fake.available], ['http-seam', false, 100, true]);
        assert.strictEqual(fake.speed_p50_ms, null, 'nobody measured it yet: null, never zero');

        // A named model answers: the one the caller asked for, and nothing else.
        let r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'buy cheap pills', questions: QUESTIONS, model: 'http-seam/decide-fake' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.receipt.model, 'decide-fake');
        assert.strictEqual(r.body.receipt.provider, 'http-seam');
        assert.strictEqual(r.body.calibrated, false, 'a catalogue model estimates its probabilities');
        assert.strictEqual(r.body.receipt.steps.length, 1);

        // An unknown model is a 400 in plain words.
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'x', questions: QUESTIONS, model: 'nobody/nothing' } });
        assert.strictEqual(r.status, 400, r.text);
        assert.match(r.body.error || r.body.detail, /no decision model called nobody\/nothing/);

        // The kind's own default model answers when the caller names none.
        const saved = await request(h.base, 'PUT', '/api/v1/setup/decisions/routing', { tok: OWNER, body: { default_model: 'http-seam/decide-fake' } });
        assert.strictEqual(saved.status, 200, saved.text);
        assert.strictEqual(saved.body.decisions.default_model, 'http-seam/decide-fake');
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'x', questions: QUESTIONS, kind: 'routing' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.receipt.model, 'decide-fake', 'the kind\'s own model answers');

        // Another kind has no default: today\'s order answers (Google first when the key is there).
        await h.registry.upsertProvider({ key: 'gemini', secret_ref: 'env:GEMINI_DECIDE_TEST_KEY' }, { actor: 'test' });
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'x', questions: QUESTIONS, kind: 'moderation' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.receipt.model, 'gemini-decision-1', 'today\'s order: Google first');
        assert.strictEqual(r.body.calibrated, true);

        // An unknown kind is refused in plain words too.
        r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'x', questions: QUESTIONS, kind: 'nonsense' } });
        assert.strictEqual(r.status, 400, r.text);
        assert.match(r.body.error || r.body.detail, /routing, moderation, grading, tool_choice, other/);

        // The owner's settings are read back through the setup API.
        const state = await request(h.base, 'GET', '/api/v1/setup/decisions', { tok: OWNER });
        assert.strictEqual(state.status, 200, state.text);
        assert.strictEqual(state.body.values.routing.default_model, 'http-seam/decide-fake');
        assert.strictEqual(state.body.values.routing.threshold, 0.75, 'the seeded threshold');
    } finally { await h.stop(); await seam.close(); }
});

t.test('an answer that is not sure enough is asked again of the next model in the ladder, once', async () => {
    const seam = await seamServer(async (body) => (body.model === 'decide-cheap' ? sureAnswer : unsureAnswer));
    const h = await boot({ env: { AI_HTTP_SEAM_URL: seam.url, AI_USER_MODULES: 'off', AI_FREE_PROVIDERS: 'http-seam,http-seam2', AI_FREE_DAILY_TOKENS: '100000' } });
    try {
        await h.registry.upsertProvider({ key: 'http-seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['chat', 'generate', 'json', 'classify'], default_model: 'decide-fake', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'http-seam', model_key: 'decide-fake', type: 'chat', status: 'active', supports: { json: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });
        await h.registry.upsertProvider({ key: 'http-seam2', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['chat', 'generate', 'json', 'classify'], default_model: 'decide-cheap', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
        await h.registry.upsertModel({ provider_key: 'http-seam2', model_key: 'decide-cheap', type: 'chat', status: 'active', supports: { json: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });

        // The owner sets the ladder: this model first, that one when the answer is unsure.
        const saved = await request(h.base, 'PUT', '/api/v1/setup/decisions/moderation', { tok: OWNER, body: { default_model: 'http-seam/decide-fake', ladder: ['http-seam/decide-fake', 'http-seam2/decide-cheap'], threshold: 0.75 } });
        assert.strictEqual(saved.status, 200, saved.text);
        assert.deepStrictEqual(saved.body.decisions.ladder, ['http-seam/decide-fake', 'http-seam2/decide-cheap']);

        const r = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'buy cheap pills', questions: QUESTIONS, kind: 'moderation' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.answers.is_spam.noul, 0.9, 'the escalated answer wins: the sure one');
        assert.strictEqual(r.body.answers.is_spam.confidence, 0.9);
        assert.strictEqual(r.body.receipt.steps.length, 2, 'two steps: the answer and the escalation');
        assert.deepStrictEqual(r.body.receipt.steps.map((s) => s.model), ['decide-fake', 'decide-cheap']);
        assert.deepStrictEqual(r.body.receipt.steps.map((s) => s.questions), [['is_spam'], ['is_spam']]);
        assert.ok(r.body.receipt.steps.every((s) => 'cost_usd' in s), 'the receipt lists what every step cost');
        assert.strictEqual(r.body.receipt.escalated, true);

        // A threshold the first answer reaches stops the escalation.
        await request(h.base, 'PUT', '/api/v1/setup/decisions/moderation', { tok: OWNER, body: { threshold: 0.4 } });
        const r2 = await request(h.base, 'POST', '/api/v1/decisions', { tok: CAP, body: { input: 'buy cheap pills', questions: QUESTIONS, kind: 'moderation' } });
        assert.strictEqual(r2.status, 200, r2.text);
        assert.strictEqual(r2.body.receipt.steps.length, 1, 'one step: the answer was sure enough');
        assert.strictEqual(r2.body.answers.is_spam.noul, 0.5, 'the unsure answer stands when the threshold is low');
    } finally { await h.stop(); await seam.close(); }
});

t.run();
