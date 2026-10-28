'use strict';
/**
 * AI's Action Center read (plan 2026-10-28 §3.10, common.action-list-result@1): a first-party service with
 * ai.actions.read names one person and gets the runs made on their behalf (on_behalf_of), never anyone else's —
 * running first-class, done and failed from the last 30 days only, newest updated first, at most 50, plain text,
 * https links and the right actions. A person's token, a token without the capability, an app token and a bad subject
 * are refused.
 */
const assert = require('assert');
const { ids, validate } = require('openvibe-contracts');
const { boot, request, token, suite } = require('./helpers');
const items = require('../server/actions/items');

const DAY = 86_400_000;
const t = suite('actions');
let h;
let wf;
let ada;
let bo;

const iso = (ms) => new Date(ms).toISOString();

async function addRun({ id = `run_${ids.ulid()}`, subject = null, status = 'queued', created = Date.now(), started = null, finished = null,
    output = null, errorCode = null, errorDetail = null, cost = 0, model = null, requester = 'network', onBehalf = undefined }) {
    const obo = onBehalf === undefined ? (subject ? JSON.stringify({ type: 'user', id: subject }) : null) : onBehalf;
    await h.db.prepare(`INSERT INTO runs (id, workflow_key, workflow_version, status, requester_type, requester_id, on_behalf_of,
            input, input_hash, output, error_code, error_detail, cost_usd, provider_key, model_key, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, 'service', ?, ?, '{}', 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, wf.key, wf.version, status, requester, obo, output == null ? null : JSON.stringify(output), errorCode, errorDetail, cost, model ? 'deepseek' : null, model, iso(created), started ? iso(started) : null, finished ? iso(finished) : null);
    return id;
}

t.test('boot with the seeded ai.generate workflow', async () => {
    h = await boot();
    wf = await h.registry.getWorkflow('ai.generate');
    ada = ids.newId('user');
    bo = ids.newId('user');
});

t.test('the state → bucket table and the actions each bucket allows', async () => {
    const table = [['queued', 'running'], ['running', 'running'], ['waiting', 'waiting'], ['succeeded', 'done'], ['cached', 'done'], ['failed', 'failed'], ['cancelled', 'failed']];
    for (const [status, bucket] of table) assert.strictEqual(items.bucketFor(status), bucket, status);
    assert.deepStrictEqual(items.actionsFor('running'), ['open']);
    assert.deepStrictEqual(items.actionsFor('failed'), ['open']);
    assert.deepStrictEqual(items.actionsFor('done'), ['open']);
    assert.deepStrictEqual(items.actionsFor('waiting'), ['open']);
    assert.strictEqual(items.plain('<b>All</b> **done** &amp; shipped', 160), 'All done & shipped');
    assert.ok(items.plain('x'.repeat(500), 400).length <= 400);
});

t.test('only that person\'s runs, newest first, with the buckets, actions, text and links common.action-item@1 allows', async () => {
    const now = Date.now();
    const queuedOld = await addRun({ subject: ada, status: 'queued', created: now - 40 * DAY });
    const running = await addRun({ subject: ada, status: 'running', created: now - 3 * 3600_000, started: now - 2 * 3600_000, model: 'deepseek-flash' });
    const done = await addRun({ subject: ada, status: 'succeeded', created: now - 3 * DAY, started: now - 2 * DAY, finished: now - DAY, cost: 0.0012, model: 'deepseek-flash', output: { text: '<b>All **done**</b> &amp; shipped.' } });
    const cached = await addRun({ subject: ada, status: 'cached', created: now - 4 * DAY, finished: now - 2 * DAY, cost: 0, output: { text: 'cached answer' } });
    const failed = await addRun({ subject: ada, status: 'failed', created: now - 5 * DAY, finished: now - 3 * DAY, errorCode: 'run.provider_error', errorDetail: '<script>it broke</script>' });
    const cancelled = await addRun({ subject: ada, status: 'cancelled', created: now - 6 * DAY, finished: now - 4 * DAY, errorCode: 'run.cancelled', errorDetail: 'cancelled by caller' });
    const old = await addRun({ subject: ada, status: 'succeeded', created: now - 45 * DAY, finished: now - 40 * DAY, output: { text: 'ancient' } });
    const theirs = await addRun({ subject: bo, status: 'succeeded', created: now - 60_000, finished: now - 30_000, output: { text: 'bo' } });
    const notPersonal = await addRun({ status: 'running', created: now - 30_000, onBehalf: JSON.stringify({ type: 'app', id: 'app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1' }) });
    const otherRequester = await addRun({ subject: ada, requester: 'actor', status: 'running', created: now - 15_000, model: 'deepseek-flash' });

    const r = await request(h.base, 'GET', `/api/v1/actions?subject=${ada}`, { tok: token('network', ['ai.actions.read']) });
    assert.strictEqual(r.status, 200, r.text);
    const v = validate('common.action-list-result@1', r.body);
    assert.ok(v.valid, JSON.stringify(v.errors));
    const byId = new Map(r.body.items.map((i) => [i.id, i]));
    assert.deepStrictEqual([byId.get(queuedOld).bucket, byId.get(queuedOld).actions], ['running', ['open']], 'an old queued run still runs');
    assert.deepStrictEqual([byId.get(running).bucket, byId.get(running).actions], ['running', ['open']]);
    assert.deepStrictEqual([byId.get(done).bucket, byId.get(done).cost_usd, byId.get(done).steps, byId.get(done).actions], ['done', 0.0012, null, ['open']]);
    assert.strictEqual(byId.get(done).title, 'Generate text');
    assert.strictEqual(byId.get(done).summary, 'All done & shipped.');
    assert.strictEqual(byId.get(done).agent, 'deepseek-flash');
    assert.strictEqual(byId.get(cached).bucket, 'done');
    assert.deepStrictEqual([byId.get(failed).bucket, byId.get(failed).error, byId.get(failed).actions], ['failed', 'it broke', ['open']]);
    assert.deepStrictEqual([byId.get(cancelled).bucket, byId.get(cancelled).actions], ['failed', ['open']]);
    assert.ok(byId.has(otherRequester), 'the run is the person\'s though another service asked for it');
    assert.ok(!byId.has(old), 'done and failed older than 30 days are gone');
    assert.ok(!byId.has(theirs) && !byId.has(notPersonal), 'never another person\'s or a project\'s run');
    for (const it of r.body.items) {
        assert.strictEqual(it.href, `https://ai.openvibe.services/runs/${it.id}`);
        assert.ok(it.title.length <= 160 && (!it.summary || it.summary.length <= 400) && (!it.error || it.error.length <= 400));
        assert.ok(!/[<>*_`]/.test(it.title) && !/[<>*_`]/.test(it.summary || '') && !/[<>*_`]/.test(it.error || ''));
    }
    const times = r.body.items.map((i) => i.updated_at);
    assert.deepStrictEqual(times, [...times].sort().reverse(), 'newest updated first');
});

t.test('at most 50 items, newest first', async () => {
    const now = Date.now();
    const mara = ids.newId('user');
    const newest = `run_${ids.ulid()}`;
    for (let i = 0; i < 55; i++) {
        await addRun({ id: i === 0 ? newest : `run_${ids.ulid()}`, subject: mara, status: 'running', created: now - i * 60_000 });
    }
    const r = await request(h.base, 'GET', `/api/v1/actions?subject=${mara}`, { tok: token('network', ['ai.actions.read']) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.items.length, 50);
    assert.strictEqual(r.body.items[0].id, newest);
});

t.test('a person\'s token, a service without the capability, an app token and a bad subject are refused', async () => {
    const person = await request(h.base, 'GET', `/api/v1/actions?subject=${ada}`, { tok: token('x', ['ai.actions.read'], { sub: `user:${ada}` }) });
    assert.strictEqual(person.status, 401);
    const noCap = await request(h.base, 'GET', `/api/v1/actions?subject=${ada}`, { tok: token('network', ['ai.run.read']) });
    assert.strictEqual(noCap.status, 403);
    assert.strictEqual(noCap.body.code, 'capability.denied');
    const app = await request(h.base, 'GET', `/api/v1/actions?subject=${ada}`, { tok: token('x', ['ai.actions.read'], { sub: 'app:app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', actorType: 'app', extra: { project_id: 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1', env: 'production' } }) });
    assert.strictEqual(app.status, 403);
    const none = await request(h.base, 'GET', `/api/v1/actions?subject=${ada}`);
    assert.strictEqual(none.status, 401);
    const bad = await request(h.base, 'GET', '/api/v1/actions?subject=usr_nope', { tok: token('network', ['ai.actions.read']) });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.code, 'input.invalid');
    const missing = await request(h.base, 'GET', '/api/v1/actions', { tok: token('network', ['ai.actions.read']) });
    assert.strictEqual(missing.status, 400);
});

t.test('stop the service', async () => { await h.stop(); });
t.run();
