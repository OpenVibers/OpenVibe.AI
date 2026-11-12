'use strict';
const assert = require('assert');
const { boot, request, token, suite, seamServer, tmpDir, ALL } = require('./helpers');
const { settingOf } = require('../server/api/orientation');

const t = suite('picture orientation');
let h;
const subject = 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const person = (role) => token('person', [], { actorType: 'user', sub: subject, extra: { subject_id: subject, role } });
const svc = token('media', ALL);
const c = (model) => ({ model, source: 'openvibe' });
const value = (over = {}) => ({
    signed_out: c('seam/see'), signed_in: c('seam/see'), fallbacks: [], image_model: null, search_engines: [],
    max_cost_usd: 0.05, daily_cap: 50, budget_usd_per_day: 0.25, method: 'vision', confidence: 0.8, ...over,
});

t.test('the setting is read back as the detector obeys it', () => {
    assert.deepStrictEqual(settingOf({ method: 'vision', confidence: 0.7, daily_cap: 12, budget_usd_per_day: 0.5, signed_in: c('a/b'), max_cost_usd: 0.05 }), {
        method: 'vision', confidence: 0.7, daily_cap: 12, budget_usd_per_day: 0.5, model: c('a/b'), max_cost_usd: 0.05,
    });
    assert.strictEqual(settingOf(null).method, 'off');
    assert.strictEqual(settingOf(null).confidence, 0.8);
});

t.test('off costs nothing, vision answers a turn and carries a receipt; caps refuse before spending', async () => {
    const seer = await seamServer(() => ({ text: '{"rotation":90,"confidence":0.93}', model: 'see', usage: { input: 40, output: 8 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    let r = await request(h.base, 'POST', '/api/v1/providers', { tok: token('live', ALL), body: { key: 'seam', kind: 'http', auth_mode: 'none', base_url: seer.url, capabilities: ['chat', 'generate', 'json', 'vision'], default_model: 'see', timeout_ms: 3000 } });
    assert.strictEqual(r.status, 201, r.text);
    r = await request(h.base, 'POST', '/api/v1/models', { tok: token('live', ALL), body: { provider_key: 'seam', model_key: 'see', type: 'chat', supports: { json: true, vision: true }, status: 'active' } });
    assert.strictEqual(r.status, 201, r.text);
    r = await request(h.base, 'POST', '/api/v1/routes/pics.orientation/versions', { tok: token('live', ALL), body: { primary: { provider: 'seam', model: 'see' }, fallbacks: [], timeout_ms: 3000, max_output_tokens: 80, response_format: 'json' } });
    assert.strictEqual(r.status, 201, r.text);

    // Off by default: an answer that says so and runs nothing.
    r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: svc, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.method, r.body.answered], ['off', false]);
    assert.strictEqual(seer.calls, 0);

    // The owner turns it on; a 256 px copy is looked at and the answer keeps its receipt.
    const admin = person('owner');
    r = await request(h.base, 'PUT', '/api/v1/admin/task-defaults', { tok: admin, body: { defaults: [{ task: 'pics.orientation', value: value() }] } });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: svc, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.method, r.body.answered, r.body.rotation, r.body.confidence], ['vision', true, 90, 0.93]);
    assert.match(r.body.receipt_id, /^rcpt_/);
    assert.strictEqual(r.body.model, 'see');
    assert.ok(r.body.run_id);
    assert.strictEqual(seer.calls, 1);

    // The Exchange owner's Try it forwards the person's Network session: that token is accepted here, a non-owner's
    // is not (the detector's budget is the network's).
    const ownerNet = token('person', [], { aud: 'openvibe.network', actorType: 'user', sub: subject, extra: { subject_id: subject, role: 'owner' } });
    r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: ownerNet, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.answered, true);
    const plainNet = token('person', [], { aud: 'openvibe.network', actorType: 'user', sub: subject, extra: { subject_id: subject, role: 'user' } });
    r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: plainNet, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'role.admin_required']);

    // The console reads the same setting, today's spend and the try's receipt.
    r = await request(h.base, 'GET', '/api/v1/admin/orientation', { tok: token('ops', ALL) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.setting.method, 'vision');
    assert.strictEqual(r.body.today.runs, 2);
    assert.strictEqual(r.body.recent[0].rotation, 90);
    assert.match(r.body.recent[0].receipt_id, /^rcpt_/);

    // A cap of zero refuses before a model is called.
    r = await request(h.base, 'PUT', '/api/v1/admin/task-defaults', { tok: admin, body: { defaults: [{ task: 'pics.orientation', value: value({ daily_cap: 0 }) }] } });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: svc, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.deepStrictEqual([r.status, r.body.code], [429, 'orientation.daily_cap']);
    assert.strictEqual(seer.calls, 2);

    // A budget already spent refuses too.
    await request(h.base, 'PUT', '/api/v1/admin/task-defaults', { tok: admin, body: { defaults: [{ task: 'pics.orientation', value: value({ budget_usd_per_day: 0 }) }] } });
    r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: svc, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.deepStrictEqual([r.status, r.body.code], [429, 'orientation.daily_budget']);
    await seer.close();
});

t.test('a service without the pics.orientation namespace cannot run it', async () => {
    const stranger = token('stranger', ALL, { ns: ['other.*'] });
    const r = await request(h.base, 'POST', '/api/v1/vision/orientation', { tok: stranger, body: { image: { data_url: 'data:image/jpeg;base64,aGk=' } } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied']);
});

t.test('finish', async () => h.stop());
t.run();
