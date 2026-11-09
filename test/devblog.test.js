'use strict';
const assert = require('assert');
const agent = require('../server/workflows/devblog');
const { input, draft } = require('./fixtures/devblog');
const { boot, request, token, suite, ALL, seamServer } = require('./helpers');
const t = suite('devblog agent');
t.test('plan, gather, write, check, revise stay bounded and use evidence figures', async () => {
    const phases = [];
    const output = await agent.execute({ input, call: async phase => { phases.push(phase); if (phase === 'plan') return { stories: [] }; if (phase === 'check') return { issues: phases.filter(p => p === 'check').length === 1 ? ['Remove an unsupported claim'] : [] }; return structuredClone(draft); } });
    assert.deepEqual(phases, ['plan', 'write', 'check', 'revise', 'check']);
    assert.equal(output.blocks.children[1].children[1].attrs.src, input.screenshots[0].media_id);
    assert.equal(output.blocks.children[2].type, 'patchnotes');
    let calls = 0;
    await assert.rejects(() => agent.execute({ input, call: async p => { calls++; return p === 'check' ? { issues: ['Unsupported claim'] } : structuredClone(draft); } }), e => e.code === 'devblog.check_failed');
    assert.equal(calls, 5);
});
t.test('bad citations and marketing names fail closed', () => {
    const d = structuredClone(draft); d.summary.citations = [100]; d.names[0] = 'Supercharged Channels';
    assert(agent.issuesOf(d, input).some(x => x.includes('evidence')));
    assert(agent.issuesOf(d, input).some(x => x.includes('marketing')));
});
t.test('registered task uses Blog grant, keeps model provenance and accounts for every step', async () => {
    const seam = await seamServer(body => {
        const prompt = body.user || body.messages?.[0]?.content || '';
        const json = prompt.startsWith('Plan') ? { stories: [{ heading: 'Channel search', sources: [0] }] } : prompt.startsWith('Check') ? { issues: [] } : draft;
        return { text: JSON.stringify(json), json, model: 'writer-local', usage: { input: 10, output: 20, cached: 0 } };
    });
    let h;
    try {
        h = await boot({ env: { AI_HTTP_SEAM_URL: seam.url } });
        await h.registry.upsertModel({ provider_key: 'http-seam', model_key: 'writer-local', type: 'chat', supports: { json: true } });
        const tok = token('blog', ALL, { ns: ['blog.*'] });
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: { task: 'blog.devblog.write', choice: { model: 'http-seam/writer-local', source: 'openvibe' }, input } });
        assert.equal(r.status, 201, r.text); assert.equal(r.body.run.status, 'succeeded', r.text);
        assert.equal(r.body.run.workflow.key, 'content.devblog'); assert.equal(r.body.run.output.title, draft.title);
        assert.deepEqual(r.body.run.output.citations, [0]);
        assert.equal(seam.calls, 3); assert.equal(r.body.run.provenance.model, 'writer-local');
        const denied = await request(h.base, 'POST', '/api/v1/runs', { tok: token('wiki', ALL, { ns: ['wiki.*'] }), body: { workflow: 'content.devblog', input } });
        assert.equal(denied.status, 403);
    } finally { if (h) await h.stop(); await seam.close(); }
});
t.run();
