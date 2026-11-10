'use strict';
// What AI can make (ai.creation-list@1): the catalogue is built from the registered workflows and tasks,
// is public, cached and open to every origin, has a Markdown twin, and the check fails when the code and
// the registry disagree — a product workflow without an entry, or an entry naming something absent.
const assert = require('assert');
const { boot, request, suite } = require('./helpers');
const creations = require('../server/creations');

const t = suite('creations');
let h;

t.test('boot', async () => { h = await boot(); });

t.test('the list is live, public, cached and open to every origin', async () => {
    const r = await request(h.base, 'GET', '/api/v1/creations', { headers: { Origin: 'https://openvibe.exchange' } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.ok(Array.isArray(r.body.creations) && r.body.creations.length >= 10, `entries: ${r.body.creations && r.body.creations.length}`);
    assert.strictEqual(r.body.count, r.body.creations.length);
    assert.ok(Date.parse(r.body.generated_at) > 0);
    const ids = new Set(r.body.creations.map((c) => c.id));
    for (const id of ['blog-post', 'devblog', 'wiki', 'wiki-article', 'space-app', 'image', 'icon', 'recipes', 'rental-check', 'meme-caption']) assert.ok(ids.has(id), `lists ${id}`);
    const blog = r.body.creations.find((c) => c.id === 'blog-post');
    assert.deepStrictEqual(blog, {
        id: 'blog-post', product: 'blog', name: 'Write a blog post',
        gives: 'A topic, and optionally a brief, a tone and who it is for.',
        returns: 'A Markdown draft with a title, a standfirst and cited sources, saved as a draft you can edit.',
        workflow: 'blog.draft_post', task: null,
        access: { guest: false, signed_in: true, floor_18: false }, costs_coins: true,
        start_url: 'https://openvibe.blog/write',
    });
    const icon = r.body.creations.find((c) => c.id === 'icon');
    assert.strictEqual(icon.task, 'design.icon');
    assert.strictEqual(icon.workflow, 'ai.chat');
    assert.strictEqual(icon.access.guest, true, 'the icon drawer lets a guest draw');
});

t.test('a preflight answers the same open CORS policy', async () => {
    const r = await request(h.base, 'OPTIONS', '/api/v1/creations', { headers: { Origin: 'https://openvibe.exchange', 'Access-Control-Request-Method': 'GET' } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-methods') || '', /GET/);
});

t.test('the Markdown twin is the same list, grouped by product', async () => {
    const md = await request(h.base, 'GET', '/api/v1/creations.md');
    assert.strictEqual(md.status, 200);
    assert.match(md.headers.get('content-type') || '', /^text\/markdown/);
    assert.strictEqual(md.headers.get('access-control-allow-origin'), '*');
    assert.match(md.text, /^# What AI can make on OpenVibe/m);
    assert.ok(md.text.includes('## Blog') && md.text.includes('### Write a blog post'));
    assert.ok(md.text.includes('- Start here: https://openvibe.blog/write'));
    assert.ok(md.text.includes('task `design.icon`'));
    const byQuery = await request(h.base, 'GET', '/api/v1/creations?format=markdown');
    assert.match(byQuery.headers.get('content-type') || '', /^text\/markdown/);
});

t.test('the registered workflows and tasks agree with the catalogue', async () => {
    const problems = creations.problems({ workflows: await h.registry.listWorkflows(), tasks: await h.choices.tasks() });
    assert.deepStrictEqual(problems, []);
});

t.test('the code definitions agree before seeding too, so a new workflow cannot ship without a decision', async () => {
    const definitions = ['live', 'core', 'products', 'devblog', 'media', 'chat', 'space', 'research', 'meme', 'changelog']
        .flatMap((name) => require(`../server/workflows/${name}`).workflows);
    const problems = creations.problems({ workflows: definitions.map((w) => ({ ...w, status: 'active' })), tasks: await h.choices.tasks() });
    assert.deepStrictEqual(problems, []);
});

t.test('a product workflow without an entry fails the check; an entry naming an absent workflow fails too', async () => {
    const workflows = await h.registry.listWorkflows();
    const tasks = await h.choices.tasks();
    const blog = workflows.find((w) => w.key === 'blog.draft_post');
    const without = { ...blog, metadata: { ...blog.metadata, creation: undefined } };
    assert.ok(creations.problems({ workflows: workflows.map((w) => (w.key === blog.key ? without : w)), tasks }).some((p) => p.includes('blog.draft_post') && p.includes('metadata.creation')));
    const mistyped = { ...blog, metadata: { ...blog.metadata, creation: { ...blog.metadata.creation, workflow: 'blog.not_a_workflow' } } };
    assert.ok(creations.problems({ workflows: workflows.map((w) => (w.key === blog.key ? mistyped : w)), tasks }).some((p) => p.includes('does not exist') || p.includes('must be')));
    const unnamedTask = { ...blog, metadata: { ...blog.metadata, creation: { ...blog.metadata.creation, task: 'design.not_registered' } } };
    assert.ok(creations.problems({ workflows: workflows.map((w) => (w.key === blog.key ? unnamedTask : w)), tasks }).some((p) => p.includes('not registered')));
});

t.test('only what is live is listed: a deprecated workflow leaves the list at once', async () => {
    const workflow = await h.registry.activeWorkflow('blog.draft_post');
    await h.registry.setStatus('workflow', 'blog.draft_post', workflow.version, 'deprecated', { actor: 'test' });
    try {
        const off = await request(h.base, 'GET', '/api/v1/creations');
        assert.ok(!off.body.creations.some((c) => c.id === 'blog-post'), 'the deprecated creation is gone');
        assert.ok(off.body.creations.length >= 10);
    } finally {
        await h.registry.setStatus('workflow', 'blog.draft_post', workflow.version, 'active', { actor: 'test' });
    }
    const on = await request(h.base, 'GET', '/api/v1/creations');
    assert.ok(on.body.creations.some((c) => c.id === 'blog-post'), 'and comes back when active');
});

t.test('stop', async () => { await h.stop(); });

t.run();
