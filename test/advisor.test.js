'use strict';
const assert = require('assert');
const { suite, boot, request, token, ALL } = require('./helpers');
const advisor = require('../server/advisor');

const ULID = '01JQ8Z3K4M5N6P7Q8R9S0T1V2W';
const appToken = (project, app, cap = ['ai.app.run']) => token('app', cap, { sub: `app:app_${app}`, actorType: 'app', ns: [project, `app.${project}.*`], extra: { project_id: project, env: 'production' } });

const t = suite('advisor');
const messages = [{ role: 'user', content: 'Change the failing test and run it.' }];

async function startRun(h, tok, body) {
    const res = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'ai.complete', input: { messages }, ...body } });
    assert.ok([200, 201].includes(res.status), `${res.status} ${res.text}`);
    return res.body.run;
}

t.test('the advisor is off unless the run asks; caps and workflow are refused before a run exists', async () => {
    const h = await boot();
    const tok = token('live', ALL);
    try {
        const plain = await startRun(h, tok);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${plain.id}/advice`, { tok, body: { transcript: messages } })).status, 403);
        for (const advisor of [false, null, undefined]) {
            const run = await startRun(h, tok, { advisor });
            assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages } })).status, 403);
        }
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'ai.complete', input: { messages }, advisor: { max_uses: 4 } } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'ai.complete', input: { messages }, advisor: { max_words: 101 } } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'ai.complete', input: { messages }, advisor: { effort: 'auto' } } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'ai.generate', input: { prompt: 'x' }, advisor: true } })).status, 422);
        const top = await startRun(h, tok, { advisor: true, options: { advisor: false } });
        assert.match(top.id, /^run_/, 'top-level advisor wins over options');
    } finally { await h.stop(); }
});

t.test('one advice call makes a run, cuts the advice to the cap, and lands on the run explain and receipt', async () => {
    const h = await boot();
    const tok = token('live', ALL);
    try {
        const run = await startRun(h, tok, { advisor: { max_uses: 3, max_words: 40, effort: 'low' }, effort: 'low' });
        const row = await h.db.prepare('SELECT options FROM runs WHERE id = ?').get(run.id);
        const policy = JSON.parse(row.options).advisor_policy;
        assert.deepStrictEqual({ enabled: policy.enabled, max_uses: policy.max_uses, max_words: policy.max_words }, { enabled: true, max_uses: 3, max_words: 40 });
        const res = await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: [{ role: 'system', content: 'You are a coding agent.' }, ...messages, { role: 'tool', content: 'exit 1: expected 2' }], question: 'What now?' } });
        assert.strictEqual(res.status, 201, res.text);
        assert.ok(res.body.advice.length > 0);
        assert.ok(res.body.advice.trim().split(/\s+/).length <= 40, `advice is cut to max_words: ${res.body.advice}`);
        assert.strictEqual(res.body.use, 1);
        assert.strictEqual(res.body.max_uses, 3);
        assert.strictEqual(res.body.model, 'stub/stub-1');
        assert.strictEqual(res.body.effort, 'low');
        assert.match(res.body.advice_run_id, /^run_/);
        const adviceRun = await h.db.prepare('SELECT workflow_key, status, options FROM runs WHERE id = ?').get(res.body.advice_run_id);
        assert.strictEqual(adviceRun.workflow_key, 'ai.chat');
        assert.strictEqual(adviceRun.status, 'succeeded');
        assert.strictEqual(JSON.parse(adviceRun.options).effort_policy.effort_requested, 'low');
        const read = await request(h.base, 'GET', `/api/v1/runs/${run.id}`, { tok });
        assert.strictEqual(read.status, 200, read.text);
        assert.strictEqual(read.body.run.explain.advisor.count, 1);
        assert.strictEqual(read.body.run.explain.advisor.max_words, 40);
        assert.strictEqual(read.body.run.explain.advisor.cost_usd, res.body.usage.cost_usd);
        assert.strictEqual(read.body.run.explain.advisor.uses[0].advice_run_id, res.body.advice_run_id);
        const receipt = await request(h.base, 'GET', `/api/v1/receipts/${res.body.receipt_id}`, { tok });
        assert.strictEqual(receipt.status, 200, receipt.text);
        assert.strictEqual(receipt.body.receipt.advisor.count, 1);
        assert.strictEqual(receipt.body.receipt.advisor.uses[0].model, 'stub/stub-1');
        assert.strictEqual(receipt.body.receipt.advisor.cost_usd, res.body.usage.cost_usd);
    } finally { await h.stop(); }
});

t.test('at most max_uses per run; a fourth call is refused and the owner check holds', async () => {
    const h = await boot();
    const tok = token('live', ALL);
    const other = token('other', ALL);
    try {
        const run = await startRun(h, tok, { advisor: { max_uses: 3 } });
        const plain = token('other', ['ai.run.create', 'ai.run.read']);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok: plain, body: { transcript: messages } })).status, 404);
        for (let i = 1; i <= 3; i++) {
            const res = await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages } });
            assert.strictEqual(res.status, 201, res.text);
            assert.strictEqual(res.body.use, i);
        }
        const fourth = await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages } });
        assert.strictEqual(fourth.status, 409, fourth.text);
        assert.strictEqual(fourth.body.code, 'advisor.exhausted');
        const uses = await h.db.prepare('SELECT COUNT(*)::int n, SUM(cost_usd) c FROM run_advisor_uses WHERE run_id = ?').get(run.id);
        assert.strictEqual(uses.n, 3);
        const read = await request(h.base, 'GET', `/api/v1/runs/${run.id}`, { tok });
        assert.strictEqual(read.body.run.explain.advisor.count, 3);
        assert.strictEqual(read.body.run.explain.advisor.cost_usd, Math.round(Number(uses.c) * 1e8) / 1e8);
    } finally { await h.stop(); }
});

t.test('a named model the route does not serve and a transcript that is not messages are 422', async () => {
    const h = await boot();
    const tok = token('live', ALL);
    try {
        const run = await startRun(h, tok, { advisor: true });
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages, model: 'nobody/nothing' } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: [] } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: [{ role: 'wizard', content: 'x' }] } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages, max_words: 101 } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages, max_words: 5 } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages, effort: 'auto' } })).status, 422);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${run.id}/advice`, { tok, body: { transcript: messages } })).status, 201);
    } finally { await h.stop(); }
});

t.test('a developer app may ask advice on its own run, never on another project\'s', async () => {
    const h = await boot();
    const prj = `prj_${ULID}`;
    const app = appToken(prj, ULID);
    const other = appToken(`prj_${'01JQ8Z3K4M5N6P7Q8R9S0T1V2X'}`, '01JQ8Z3K4M5N6P7Q8R9S0T1V2X');
    try {
        const res = await request(h.base, 'POST', '/v1/chat/completions?wait=5000', { tok: app, body: { model: 'openvibe', messages, advisor: true, effort: 'low' } });
        assert.strictEqual(res.status, 200, res.text);
        const runId = res.headers.get('x-openvibe-run-id');
        assert.match(runId, /^run_/);
        assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${runId}/advice`, { tok: other, body: { transcript: messages } })).status, 404);
        const advice = await request(h.base, 'POST', `/api/v1/runs/${runId}/advice`, { tok: app, body: { transcript: messages } });
        assert.strictEqual(advice.status, 201, advice.text);
        assert.strictEqual(advice.body.use, 1);
        const read = await request(h.base, 'GET', `/api/v1/runs/${runId}`, { tok: app });
        assert.strictEqual(read.status, 200, read.text);
        assert.strictEqual(read.body.run.explain.advisor.count, 1);
    } finally { await h.stop(); }
});

t.test('policy parsing: defaults, compat option, and the 3/100 ceilings', async () => {
    const wf = { key: 'ai.complete' };
    assert.deepStrictEqual(advisor.policy({}, wf), { enabled: false });
    assert.deepStrictEqual(advisor.policy({ advisor: true }, wf), { enabled: true, max_uses: 3, max_words: 100, effort: 'high' });
    assert.deepStrictEqual(advisor.policy({ options: { advisor: { model: 'deepseek/deepseek-v4-pro', effort: 'max', max_uses: 1, max_words: 20 } } }, wf), { enabled: true, max_uses: 1, max_words: 20, effort: 'max', model: 'deepseek/deepseek-v4-pro' });
    assert.throws(() => advisor.policy({ advisor: { max_uses: 0 } }, wf), /1 to 3/);
    assert.throws(() => advisor.policy({ advisor: { max_words: 9 } }, wf), /10 to 100/);
    assert.throws(() => advisor.policy({ advisor: { effort: 'auto' } }, wf), /low\|medium\|high\|max/);
    assert.throws(() => advisor.policy({ advisor: { extra: true } }, wf), /no field extra/);
    assert.throws(() => advisor.policy({ advisor: true }, { key: 'live.chat_reply' }), /available on/);
    assert.deepStrictEqual(advisor.words('one two three four', 3), { text: 'one two three', count: 3 });
    assert.deepStrictEqual(advisor.words('one two', 3), { text: 'one two', count: 2 });
});

t.run();
