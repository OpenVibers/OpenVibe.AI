'use strict';
// Run lifecycle: async creation and polling, idempotency (replay and conflict), cancel of a running
// and of a queued run, retry of failed/cancelled runs (and refusal for succeeded ones), audit rows
// for every create/cancel/retry and every template/workflow/provider change, and restart recovery.

const assert = require('assert');
const { boot, request, token, suite, tmpDir, ALL } = require('./helpers');

const t = suite('runs');
const live = token('live', ALL);
const tools = token('tools', ['ai.run.create', 'ai.run.read']);
let h;
const dir = tmpDir();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting');
        await sleep(25);
    }
}
const getRun = async (id, tok = live) => (await request(h.base, 'GET', `/api/v1/runs/${id}`, { tok })).body;

t.test('boot with a slow stub on default.chat and one run at a time', async () => {
    h = await boot({ dir, env: { AI_MAX_CONCURRENT_RUNS: '1', AI_STUB_FALLBACK: 'false' } });
    const p = await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'slowstub', kind: 'stub', auth_mode: 'none', capabilities: ['chat', 'generate', 'summarize', 'json'], metadata: { delay_ms: 400 } } });
    assert.strictEqual(p.status, 201, p.text);
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'slowstub' }, fallbacks: [] } });
});

t.test('async create answers 202 with a Location, then the run completes', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'async please' } } });
    assert.strictEqual(r.status, 202);
    assert.ok(['queued', 'running'].includes(r.body.run.status));
    assert.strictEqual(r.headers.get('location'), `/api/v1/runs/${r.body.run.id}`);
    const done = await until(async () => { const d = await getRun(r.body.run.id); return d.run.status === 'succeeded' && d; });
    assert.ok(done.run.output.text);
    assert.ok(done.run.trace_id, 'trace id recorded');
});

t.test('idempotency: same key + input replays the run; a different input conflicts', async () => {
    const body = { workflow: 'ai.generate', input: { prompt: 'once' }, idempotency_key: 'idem-key-0001' };
    const a = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body });
    assert.strictEqual(a.status, 201);
    const b = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body });
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.run.id, a.body.run.id);
    assert.strictEqual(b.body.replayed, true);
    const hdr = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'once' } }, headers: { 'Idempotency-Key': 'idem-key-0001' } });
    assert.strictEqual(hdr.body.run.id, a.body.run.id, 'the Idempotency-Key header works too');
    const c = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { ...body, input: { prompt: 'twice' } } });
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.body.code, 'idempotency.conflict');
    const other = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: tools, body });
    assert.notStrictEqual(other.body.run.id, a.body.run.id, 'keys are per requester');
});

t.test('cancel a running run and a queued one', async () => {
    const first = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'long 1' }, options: { cache: false } } });
    const second = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'long 2' }, options: { cache: false } } });
    await until(async () => (await getRun(first.body.run.id)).run.status === 'running');
    assert.strictEqual((await getRun(second.body.run.id)).run.status, 'queued', 'concurrency 1 keeps the second queued');
    const c2 = await request(h.base, 'POST', `/api/v1/runs/${second.body.run.id}/cancel`, { tok: live });
    assert.strictEqual(c2.body.run.status, 'cancelled');
    const c1 = await request(h.base, 'POST', `/api/v1/runs/${first.body.run.id}/cancel`, { tok: live });
    assert.strictEqual(c1.body.run.status, 'cancelled');
    await sleep(500);
    const d = await getRun(first.body.run.id);
    assert.strictEqual(d.run.status, 'cancelled', 'a late provider answer does not resurrect it');
    assert.strictEqual(d.run.output, null);
    assert.ok(d.requests.some(x => x.status === 'cancelled'), 'the in-flight call was aborted');
    const again = await request(h.base, 'POST', `/api/v1/runs/${first.body.run.id}/cancel`, { tok: live });
    assert.strictEqual(again.status, 409);
    assert.strictEqual((await request(h.base, 'POST', `/api/v1/runs/${first.body.run.id}/cancel`, { tok: tools })).status, 404, 'other callers cannot see it');
});

t.test('retry: a failed run is retried as a new run; succeeded runs cannot be retried', async () => {
    await request(h.base, 'POST', '/api/v1/providers/slowstub/disable', { tok: live });
    const failed = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'will fail first' } } });
    assert.strictEqual(failed.body.run.status, 'failed');
    assert.strictEqual(failed.body.run.error.code, 'provider.unavailable');
    await request(h.base, 'POST', '/api/v1/providers/slowstub/enable', { tok: live });
    const retried = await request(h.base, 'POST', `/api/v1/runs/${failed.body.run.id}/retry?wait=5000`, { tok: live });
    assert.strictEqual(retried.status, 201);
    assert.strictEqual(retried.body.run.status, 'succeeded');
    assert.strictEqual(retried.body.run.retry_of, failed.body.run.id);
    assert.notStrictEqual(retried.body.run.id, failed.body.run.id);
    const no = await request(h.base, 'POST', `/api/v1/runs/${retried.body.run.id}/retry`, { tok: live });
    assert.strictEqual(no.status, 409);
    assert.strictEqual(no.body.code, 'run.not_retryable');
});

t.test('passthrough prompts and inline images are not kept on the run record', async () => {
    await request(h.base, 'POST', '/api/v1/routes/live.chat/versions', { tok: live, body: { primary: { provider: 'slowstub' }, fallbacks: [] } });
    await request(h.base, 'POST', '/api/v1/routes/live.vision/versions', { tok: live, body: { primary: { provider: 'slowstub' }, fallbacks: [] } });
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'slowstub', kind: 'stub', capabilities: ['chat', 'generate', 'summarize', 'json', 'vision'], metadata: { delay_ms: 10 } } });
    const p = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'live.chat.insight', input: { role: 'chat', kind: 'chat_user', user: 'PRIVATE CHAT LOG: alice said hi' } } });
    assert.strictEqual(p.body.run.status, 'succeeded');
    const row = h.db.prepare('SELECT input, input_hash FROM runs WHERE id = ?').get(p.body.run.id);
    assert.ok(!row.input.includes('PRIVATE CHAT LOG'), 'raw prompt not stored');
    assert.ok(row.input_hash);
    const png = `data:image/png;base64,${Buffer.alloc(600, 7).toString('base64')}`;
    const img = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'live.stream.describe_frame', input: { image: { data_url: png } } } });
    const irow = h.db.prepare('SELECT input FROM runs WHERE id = ?').get(img.body.run.id);
    assert.ok(!irow.input.includes(png.slice(40, 120)) && irow.input.includes('data_url_sha256'));
    await request(h.base, 'POST', '/api/v1/providers/slowstub/disable', { tok: live });
    const failed = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'live.chat.insight', input: { role: 'chat', user: 'again' } } });
    assert.strictEqual(failed.body.run.status, 'failed');
    const nr = await request(h.base, 'POST', `/api/v1/runs/${failed.body.run.id}/retry`, { tok: live });
    assert.strictEqual(nr.status, 409);
    assert.strictEqual(nr.body.code, 'run.input_not_retained');
    await request(h.base, 'POST', '/api/v1/providers/slowstub/enable', { tok: live });
});

t.test('audit rows exist for runs and for registry changes', async () => {
    const a = (await request(h.base, 'GET', '/api/v1/audit?limit=500', { tok: live })).body.audit;
    const actions = new Set(a.map(x => x.action));
    for (const x of ['run.create', 'run.cancel', 'run.retry', 'provider.create', 'provider.update', 'route.version', 'template.version', 'workflow.version']) assert.ok(actions.has(x), `no ${x} audit row`);
    const create = a.find(x => x.action === 'run.create' && x.actor === 'svc:live');
    assert.ok(create.trace_id, 'audit rows carry the trace id');
    assert.ok(create.metadata.workflow);
    const v = await request(h.base, 'POST', '/api/v1/workflows/ai.generate/versions', { tok: live, body: { description: 'edited' } });
    assert.strictEqual(v.body.workflow.version, 2);
    const wa = (await request(h.base, 'GET', '/api/v1/audit?action=workflow.version&target_id=ai.generate', { tok: live })).body.audit;
    assert.strictEqual(wa[0].actor, 'svc:live');
    assert.strictEqual(wa[0].metadata.version, 2);
});

t.test('runs still in flight at shutdown end as run.interrupted, retryable after restart', async () => {
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'slowstub', kind: 'stub', metadata: { delay_ms: 3000 } } });
    const r = await request(h.base, 'POST', '/api/v1/runs', { tok: live, body: { workflow: 'ai.generate', input: { prompt: 'cut short' }, options: { cache: false } } });
    await until(async () => (await getRun(r.body.run.id)).run.status === 'running');
    await h.stop();
    h = await boot({ dir, env: { AI_MAX_CONCURRENT_RUNS: '1', AI_STUB_FALLBACK: 'false' } });
    const d = await getRun(r.body.run.id);
    assert.strictEqual(d.run.status, 'failed');
    assert.strictEqual(d.run.error.code, 'run.interrupted');
    h.db.prepare("UPDATE runs SET status = 'running', error_code = NULL, finished_at = NULL WHERE id = ?").run(r.body.run.id);
    await h.stop();
    h = await boot({ dir, env: { AI_MAX_CONCURRENT_RUNS: '1', AI_STUB_FALLBACK: 'false' } });
    assert.strictEqual((await getRun(r.body.run.id)).run.error.code, 'run.interrupted', 'boot recovery marks orphans too');
    assert.strictEqual(h.registry.getWorkflow('ai.generate').version, 2, 'a reboot does not clobber admin versions with the seed');
});

t.test('shutdown', async () => { await h.stop(); });

t.run();
