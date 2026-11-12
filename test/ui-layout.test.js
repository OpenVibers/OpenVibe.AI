'use strict';
// ui.layout.suggest (make your own controls design, 2026-11-11, piece 6): a fake model through the
// HTTP seam answers twice — once with a layout that hides Stop, once with a valid one — and the task
// retries exactly once with the validator's reasons. The second test makes the model fail both times
// and checks the honest "couldn't".
const assert = require('assert');
const { boot, request, seamServer, suite, token } = require('./helpers');
const { validate: validateLayout } = require('openvibe-sdk/ui-layout');
const { validate } = require('openvibe-contracts');

const t = suite('ui-layout');
const CAP = token('network', ['ai.layout.suggest'], { sub: 'svc:network' });
const NOCAP = token('network', ['ai.run.create'], { sub: 'svc:network' });
const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

const catalog = () => ({
    id: 'bot.controls', version: 1, name: 'Robot controls', devices: ['phone', 'tablet', 'computer'],
    grid: { columns: { phone: 4, tablet: 8, computer: 12 }, cell_px: { phone: 44, tablet: 44, computer: 44 } },
    theme_tokens: ['danger', 'surface', 'text'],
    parts: [
        { id: 'stop', name: 'Stop', kind: 'button', required: true, pressed: true, min: { w: 2, h: 2, px: 64 },
            styles: { tints: ['danger'], shapes: ['round'], opacity: { min: 0.7, max: 1 }, label: true },
            bindings: { keys: ['Space'], gamepad: ['south'] }, never_covers: [] },
        { id: 'stick', name: 'Drive stick', kind: 'stick', required: false, pressed: true, min: { w: 2, h: 2 },
            styles: { tints: ['surface'], shapes: ['round'], opacity: { min: 0.4, max: 1 }, label: false },
            bindings: { keys: ['W', 'A', 'S', 'D'], gamepad: ['left-stick'] }, never_covers: ['stop'] },
    ],
});
const part = (id, place, visible = true) => ({
    id, visible, place,
    style: { tint: id === 'stop' ? 'danger' : 'surface', shape: 'round', opacity: 1, label: id === 'stop' },
    bindings: id === 'stop' ? { keys: ['Space'], gamepad: ['south'] } : { keys: ['W', 'A', 'S', 'D'], gamepad: ['left-stick'] },
});
const validLayout = () => ({
    surface: 'bot.controls', surface_version: 1, device: 'phone', name: 'One thumb',
    author: { name: 'Ana' }, sharing: 'private',
    parts: [part('stop', { x: 0, y: 0, w: 2, h: 2 }), part('stick', { x: 0, y: 2, w: 2, h: 2 })],
});
const hiddenStop = () => {
    const l = validLayout(); l.parts[0].visible = false; return l;
};
const answer = (layout, ok = true, summary = 'Moved Stop to the top.', reasons = ['Stop stayed visible.']) => ({ json: { ok, layout, summary, reasons } });
const requestBody = () => ({ catalog: catalog(), layout: validLayout(), words: 'put Stop on the left and make it huge', device: 'phone' });

let seam = null;
let answers = [];
let h = null;

t.test('a layout that hides Stop is refused, retried once with the reasons, and the valid second answer comes back', async () => {
    seam = await seamServer(async () => {
        const index = Math.min(seam.calls - 1, answers.length - 1);
        return answers[index];
    });
    answers = [answer(hiddenStop()), answer(validLayout())];
    h = await boot({ env: { AI_HTTP_SEAM_URL: seam.url, AI_USER_MODULES: 'off', AI_FREE_PROVIDERS: 'http-seam', AI_FREE_DAILY_TOKENS: '100000' } });
    // The seam becomes the only chat/json offer: a fake model with a model record the router can choose.
    await h.registry.upsertProvider({ key: 'http-seam', capabilities: ['chat', 'generate', 'json'], default_model: 'layout-fake', billing_profile: 'free', provider_access: 'OWN_DEPLOYMENT' }, { actor: 'test' });
    await h.registry.upsertModel({ provider_key: 'http-seam', model_key: 'layout-fake', type: 'chat', status: 'active', supports: { json: true }, cost: { in_per_mtok: 0, out_per_mtok: 0, cached_per_mtok: 0 } }, { actor: 'test' });
    await h.registry.upsertProvider({ key: 'stub', status: 'disabled' }, { actor: 'test' });

    const r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: CAP, headers: { 'X-OV-Subject': SUBJECT }, body: requestBody() });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.ok, true, r.text);
    assert.strictEqual(seam.calls, 2, 'one retry, no more');
    assert.strictEqual(r.body.receipt.model, 'layout-fake');
    assert.ok(r.body.receipt.run_id, 'the receipt names the run');
    assert.ok(r.body.receipt.cost_usd >= 0);
    assert.ok(validate('ui.layout-suggestion@1', r.body).valid, JSON.stringify(validate('ui.layout-suggestion@1', r.body).errors));
    assert.deepStrictEqual(validateLayout(catalog(), r.body.layout), { ok: true, reasons: [] });
    assert.strictEqual(r.body.layout.author.subject, undefined, 'the run does not invent an account author');
    const row = await h.db.prepare("SELECT on_behalf_of, requester_type FROM runs WHERE workflow_key = 'ui.layout.suggest' ORDER BY id DESC LIMIT 1").get();
    assert.deepStrictEqual(JSON.parse(row.on_behalf_of), { type: 'user', id: SUBJECT }, 'the run is the person’s, for their own limits');
    assert.strictEqual(row.requester_type, 'service', 'the service is still the recorded requester');
    // The second prompt carries the validator's reason, and the same words and catalog.
    const second = JSON.parse(seam.last.messages[seam.last.messages.length - 1].content);
    assert.deepStrictEqual(second.previous_refusal.reasons, ['Stop has to stay visible.']);
    assert.strictEqual(second.words, 'put Stop on the left and make it huge');
    assert.strictEqual(second.device, 'phone');
});

t.test('two invalid answers end in an honest could-not, not a third call', async () => {
    answers = [answer(hiddenStop()), answer(hiddenStop())];
    const r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: CAP, headers: { 'X-OV-Subject': SUBJECT }, body: requestBody() });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.layout, null);
    assert.match(r.body.summary, /^Couldn't do that: Stop has to stay visible\./);
    assert.ok(r.body.reasons.includes('Stop has to stay visible.'));
    assert.ok(validate('ui.layout-suggestion@1', r.body).valid);
    assert.strictEqual(seam.calls, 4, 'one retry for each of the two requests');
});

t.test('the model may say it cannot, and the answer stays a refusal', async () => {
    answers = [answer(null, false, "Couldn't do that: the catalog has no vertical head slider.", ['the catalog has no vertical head slider'])];
    const r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: CAP, headers: { 'X-OV-Subject': SUBJECT }, body: requestBody() });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.layout, null);
    assert.ok(r.body.reasons.includes('the catalog has no vertical head slider'));
    assert.ok(r.body.receipt.model, 'a refusal carries its receipt too');
});

t.test('refusals before any model call: capability, subject, body and words', async () => {
    const before = seam.calls;
    let r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: NOCAP, body: requestBody() });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'capability.denied');
    r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: CAP, headers: { 'X-OV-Subject': 'not-a-subject' }, body: requestBody() });
    assert.strictEqual(r.status, 422);
    r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: CAP, headers: { 'X-OV-Subject': SUBJECT }, body: { ...requestBody(), words: '' } });
    assert.strictEqual(r.status, 422);
    assert.match(r.text, /words/);
    r = await request(h.base, 'POST', '/api/v1/ui/layout/suggest', { tok: CAP, headers: { 'X-OV-Subject': SUBJECT }, body: { ...requestBody(), device: 'watch' } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(seam.calls, before, 'no model was called');
});

t.test('the generic run API can run the task, and the task is registered under its own name', async () => {
    answers = [answer(validLayout())];
    const route = await h.registry.resolveRoute('ui.layout.suggest');
    assert.strictEqual(route.response_format, 'json', 'the task asks for structured output');
    assert.strictEqual(route.constraints.objective, 'cheapest', 'the task runs on the cheap tier');
    const task = await h.choices.task('ui.layout.suggest');
    assert.ok(task, 'the task is seeded');
    assert.strictEqual(task.workflow, 'ui.layout.suggest');
    const run = await h.runs.create({ task: 'ui.layout.suggest', input: requestBody() }, { kind: 'service', sub: 'svc:network', subject: { type: 'service', id: 'network' }, ns: ['*'], cap: ['ai.layout.suggest'] }, { callerWaitMs: 20000 });
    const done = await h.runs.explained(await h.runs.wait(run, 20000));
    assert.strictEqual(done.status, 'succeeded', JSON.stringify(done.error));
    assert.strictEqual(done.output.ok, true);
});

t.test('cleanup', async () => {
    await seam.close();
    await h.stop();
});

t.run();
