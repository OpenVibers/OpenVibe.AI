'use strict';
// Templates, workflows and routes are versioned: an edit is a new version, old versions stay
// readable, a run records the exact versions it used, lifecycle changes (deprecate/archive/disable)
// only change status, the newest ACTIVE version is what new runs use, and seeding never overwrites
// an admin's version.

const assert = require('assert');
const { boot, request, token, suite, ALL } = require('./helpers');

const t = suite('versioning');
const tok = token('live', ALL);
let h;
const run = (body) => request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body });

t.test('boot', async () => { h = await boot(); });

t.test('a template edit is a new version; v1 stays readable; runs record the version they used', async () => {
    const r1 = await run({ workflow: 'ai.summarize', input: { text: 'abc def' } });
    assert.strictEqual(r1.body.run.template.version, 1);
    const v2 = await request(h.base, 'POST', '/api/v1/templates/ai.summarize/versions', { tok, body: { user_prompt: 'Summarize in {{max_words}} words:\n{{text}}' } });
    assert.strictEqual(v2.status, 201);
    assert.strictEqual(v2.body.template.version, 2);
    const r2 = await run({ workflow: 'ai.summarize', input: { text: 'abc def' } });
    assert.strictEqual(r2.body.run.template.version, 2);
    const old = await request(h.base, 'GET', '/api/v1/templates/ai.summarize?version=1', { tok });
    assert.strictEqual(old.body.template.version, 1);
    assert.ok(old.body.template.user_prompt.includes('{{#style}}'), 'v1 content unchanged');
    assert.deepStrictEqual(old.body.versions.map(v => v.version), [1, 2]);
    assert.strictEqual((await request(h.base, 'GET', `/api/v1/runs/${r1.body.run.id}`, { tok })).body.run.template.version, 1, 'old run still says v1');
});

t.test('an invalid edit is refused and creates no version', async () => {
    const bad = await request(h.base, 'POST', '/api/v1/workflows/ai.summarize/versions', { tok, body: { input_schema: { type: 'nonsense-type' } } });
    assert.strictEqual(bad.status, 422);
    const bad2 = await request(h.base, 'POST', '/api/v1/workflows/ai.summarize/versions', { tok, body: { steps: [{ kind: 'llm', template: 'no.such.template' }] } });
    assert.strictEqual(bad2.status, 422);
    assert.strictEqual(h.registry.getWorkflow('ai.summarize').version, 1);
});

t.test('deprecating the newest workflow version sends new runs to the newest active one', async () => {
    const v2 = await request(h.base, 'POST', '/api/v1/workflows/ai.summarize/versions', { tok, body: { description: 'v2 description' } });
    assert.strictEqual(v2.body.workflow.version, 2);
    assert.strictEqual((await run({ workflow: 'ai.summarize', input: { text: 'x y' } })).body.run.workflow.version, 2);
    const dep = await request(h.base, 'POST', '/api/v1/workflows/ai.summarize/versions/2/status', { tok, body: { status: 'deprecated' } });
    assert.strictEqual(dep.body.workflow.status, 'deprecated');
    assert.strictEqual((await run({ workflow: 'ai.summarize', input: { text: 'x y z' } })).body.run.workflow.version, 1);
    assert.strictEqual((await run({ workflow: 'ai.summarize', version: 2, input: { text: 'pinned' } })).body.run.workflow.version, 2, 'a deprecated version can still be pinned');
    await request(h.base, 'POST', '/api/v1/workflows/ai.summarize/versions/2/status', { tok, body: { status: 'archived' } });
    const arch = await run({ workflow: 'ai.summarize', version: 2, input: { text: 'pinned' } });
    assert.strictEqual(arch.status, 409);
    assert.strictEqual(arch.body.code, 'workflow.inactive');
});

t.test('route versions and disabling a route', async () => {
    const r = await request(h.base, 'POST', '/api/v1/routes/default.embedding/versions', { tok, body: { primary: { provider: 'stub', model: 'stub-1' } } });
    assert.strictEqual(r.body.route.version, 2);
    const e = await request(h.base, 'POST', '/api/v1/embed', { tok, body: { input: 'x' } });
    assert.deepStrictEqual(e.body.run.route, { key: 'default.embedding', version: 2 });
    await request(h.base, 'POST', '/api/v1/routes/default.embedding/versions', { tok, body: { status: 'disabled' } });
    const off = await request(h.base, 'POST', '/api/v1/embed', { tok, body: { input: 'y' } });
    assert.strictEqual(off.body.run.status, 'failed');
    assert.strictEqual(off.body.run.error.code, 'route.unavailable');
    const hist = await request(h.base, 'GET', '/api/v1/routes?history=1', { tok });
    assert.strictEqual(hist.body.routes.filter(x => x.key === 'default.embedding').length, 3);
});

t.test('historical route keys are explicit aliases of default.json', async () => {
    const r = await request(h.base, 'GET', '/api/v1/routes/news.summarize', { tok });
    assert.strictEqual(r.body.route.alias_of, 'default.json');
    const run1 = await run({ workflow: 'news.summarize_story', input: { sources: [{ source_type: 'news.article', content: 'x' }] } });
    assert.strictEqual(run1.body.run.route.key, 'default.json');
});

t.test('seed: a code change becomes a new version, unless an admin versioned the key', async () => {
    const before = h.registry.getTemplate('ai.generate').version;
    h.registry.seedVersioned('template', 'ai.generate', { name: 'Generate text', system_prompt: '{{system}}', user_prompt: 'CHANGED {{prompt}}', default_route: 'default.chat', input_schema: { type: 'object' }, output_schema: { type: 'object' } });
    assert.strictEqual(h.registry.getTemplate('ai.generate').version, before + 1);
    assert.strictEqual(h.registry.getTemplate('ai.generate').created_by, 'seed');
    const again = h.registry.seedVersioned('template', 'ai.summarize', { name: 'x', user_prompt: 'seed wants this' });
    assert.strictEqual(again.created_by, 'svc:live', 'admin version kept');
});

t.test('shutdown', async () => { await h.stop(); });

t.run();
