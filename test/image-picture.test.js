'use strict';
// The shared image task (image.picture, rich-content plan §4/§5): find licensed Commons/Openverse pictures
// and make one with the owner's model. Pictures go to Media by reference, never inline; a paid offer must
// carry a per-image price; make is off until the owner picks a model; the owner's daily cap holds.
const assert = require('assert');
const http = require('http');
const { suite, boot, request, token, ALL, seamServer } = require('./helpers');
const { createPictures, mimeOf, freeProvider } = require('../server/workflows/pictures');

const t = suite('image picture');
const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const MEDIA = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function store() {
    const puts = [];
    return {
        puts,
        configured: () => true,
        publicUrl: (id) => `https://media.test/o/${id}`,
        put: async (o) => { puts.push(o); return { media_id: MEDIA, url: `https://media.test/o/${MEDIA}`, width: 800, height: 600 }; },
    };
}
const plan = (over = {}) => ({
    task: { name: 'image.picture', kind: 'image' }, choice: { model: 'openvibe/auto', source: 'openvibe' }, why: 'owner',
    fallbacks: [], max_cost_usd: null, search_engines: [{ engine: 'commons', enabled: true }, { engine: 'openverse', enabled: true }],
    image_model: null, daily_cap: null, guest_find: false, ...over,
});
const ctxOf = (over = {}) => ({ taskChoice: plan(), onBehalfOf: { type: 'user', id: SUBJECT }, signal: new AbortController().signal, ...over });

const image = (over = {}) => ({ url: 'https://upload.wikimedia.org/a.jpg', thumbnail: 'https://upload.wikimedia.org/thumb/a.jpg', original: 'https://upload.wikimedia.org/a.jpg', source_url: 'https://commons.wikimedia.org/wiki/File:A', title: 'A machine', description: 'A machine in a workshop', author: 'Ada Example', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', free: true, provider: 'commons', width: 800, height: 600, ...over });

function pictures(over = {}) {
    const calls = { fetches: [], executes: [] };
    const p = createPictures({
        registry: {
            listModels: async () => [imageModel(over.price)],
            listProviders: async () => [{ key: 'fixture', kind: 'openai', status: 'active', billing_profile: 'metered', metadata: {} }],
        },
        pool: { execute: async (route, op, req, ctx) => { calls.executes.push({ route, op, req, ctx }); return {
            result: { images: [{ b64: PNG.toString('base64'), url: null }] }, provider: 'fixture', model: 'image',
            usage: { input: 0, output: 1, cached: 0 }, cost: 0, synthetic: false, fallbackUsed: false, explain: {},
        }; } },
        fetcher: { fetchPicture: async (url) => { calls.fetches.push(url); return { bytes: PNG, mime: 'image/png', url }; } },
        config: { image: { size: '1024x1024' }, pictures: { defaultDailyCap: 24 } },
        db: { prepare: () => ({ get: async () => ({ n: over.made || 0 }) }) },
        mediaStore: store(),
        routeFor: async () => ({ key: 'default.image', version: 1, timeout_ms: 120000 }),
        research: () => ({ gather: async () => ({ providers: {}, images: over.images || [image()] }) }),
        ...over.deps,
    });
    return { p, calls };
}
const imageModel = (price = 0.04) => ({ provider_key: 'fixture', model_key: 'image', type: 'image', status: 'active', metadata: price == null ? {} : { price_per_image_usd: price } });

t.test('find keeps licence, author and source, and uploads only free pictures to Media', async () => {
    const { p, calls } = pictures({ images: [
        image(),
        image({ url: 'https://upload.wikimedia.org/b.jpg', thumbnail: null, source_url: 'https://commons.wikimedia.org/wiki/File:B', license: null }),
        image({ provider: 'commons', free: false, source_url: 'https://commons.wikimedia.org/wiki/File:C' }),
        image({ provider: 'openverse', url: 'https://api.openverse.org/v1/images/one/thumb/', thumbnail: 'https://api.openverse.org/v1/images/one/thumb/', source_url: 'https://flickr.com/p/1', author: 'Bo', license: 'CC BY 4.0' }),
    ] });
    const out = await p.step({}, { mode: 'find', query: 'a machine', count: 8 }, {}, {}, ctxOf());
    assert.strictEqual(out.output.mode, 'find');
    assert.strictEqual(out.output.task, 'image.picture');
    assert.strictEqual(out.output.media.length, 2);
    assert.deepStrictEqual(out.output.media.map((m) => m.provider), ['commons', 'openverse']);
    assert.deepStrictEqual({ license: out.output.media[0].license, author: out.output.media[0].author, credit: out.output.media[0].credit, ai: out.output.media[0].ai },
        { license: 'CC BY-SA 4.0', author: 'Ada Example', credit: 'Ada Example, CC BY-SA 4.0', ai: false });
    assert.strictEqual(out.output.media[0].source_url, 'https://commons.wikimedia.org/wiki/File:A');
    assert.strictEqual(out.output.media[0].url, `https://media.test/o/${MEDIA}`);
    assert.deepStrictEqual(calls.fetches, ['https://upload.wikimedia.org/thumb/a.jpg', 'https://api.openverse.org/v1/images/one/thumb/']);
    assert.ok(!JSON.stringify(out.output).includes(PNG.toString('base64')), 'never inline bytes');
});

t.test('find without a person is refused unless the owner allows guests', async () => {
    const { p } = pictures();
    await assert.rejects(() => p.step({}, { mode: 'find', query: 'x' }, {}, {}, ctxOf({ onBehalfOf: null })), (e) => e.status === 401 && e.code === 'image.guest_forbidden');
    const allowed = await p.step({}, { mode: 'find', query: 'x' }, {}, {}, ctxOf({ onBehalfOf: null, taskChoice: plan({ guest_find: true }) }));
    assert.strictEqual(allowed.output.count, 1);
});

t.test('make is off until the owner picks an image model, then a dry run quotes without calling a provider', async () => {
    const off = pictures();
    await assert.rejects(() => off.p.step({}, { mode: 'make', prompt: 'a goose' }, {}, {}, ctxOf()), (e) => e.status === 503 && e.code === 'image.make_unconfigured');
    assert.strictEqual(off.calls.executes.length, 0);

    const on = pictures();
    const out = await on.p.step({}, { mode: 'make', prompt: 'a goose', n: 2, dry_run: true }, {}, {}, ctxOf({ taskChoice: plan({ image_model: { model: 'fixture/image', source: 'openvibe' }, daily_cap: 10 }) }));
    assert.strictEqual(out.output.dry_run, true);
    assert.deepStrictEqual(out.output.estimate, { model: 'fixture/image', source: 'openvibe', images: 2, per_image_usd: 0.04, price_usd: 0.08 });
    assert.deepStrictEqual(out.output.media, []);
    assert.strictEqual(on.calls.executes.length, 0, 'a dry run never calls the provider');
});

t.test('make uploads each picture to Media and labels it made with AI', async () => {
    const { p, calls } = pictures();
    const out = await p.step({}, { mode: 'make', prompt: 'a goose', alt: 'A goose', n: 1 }, {}, {}, ctxOf({ taskChoice: plan({ image_model: { model: 'fixture/image', source: 'openvibe' }, daily_cap: 10 }) }));
    assert.strictEqual(out.output.media.length, 1);
    assert.strictEqual(out.output.media[0].ai, true);
    assert.strictEqual(out.output.media[0].model, 'image');
    assert.strictEqual(out.output.media[0].credit, 'Made with AI (image)');
    assert.match(out.output.media[0].caption, /Made with AI \(image\)/);
    assert.strictEqual(out.output.media[0].media_id, MEDIA);
    assert.strictEqual(calls.executes.length, 1);
    assert.strictEqual(calls.executes[0].ctx.imagePriceUsd, 0.04, 'the per-image price is reserved for this call');
    assert.strictEqual(calls.executes[0].ctx.taskChoice, null, 'the owner model is pinned, not re-resolved');
    assert.strictEqual(out.exec.explain.task_choice.answered.model, 'image');
});

t.test('a paid offer without a per-image price is refused, and the daily cap holds', async () => {
    const unpriced = pictures({ price: null });
    await assert.rejects(() => unpriced.p.step({}, { mode: 'make', prompt: 'x' }, {}, {}, ctxOf({ taskChoice: plan({ image_model: { model: 'fixture/image', source: 'openvibe' } }) })), (e) => e.status === 402 && e.code === 'image.price_required');
    assert.strictEqual(unpriced.calls.executes.length, 0);

    const capped = pictures({ made: 4 });
    await assert.rejects(() => capped.p.step({}, { mode: 'make', prompt: 'x', n: 2 }, {}, {}, ctxOf({ taskChoice: plan({ image_model: { model: 'fixture/image', source: 'openvibe' }, daily_cap: 5 }) })), (e) => e.status === 429 && e.code === 'image.daily_cap');
    assert.strictEqual(capped.calls.executes.length, 0);
});

t.test('the task is in the catalogue, and the owner defaults take its model, cap and guest rule', async () => {
    const h = await boot({ env: { AI_IMAGE_MODEL: 'gpt-image-1' } });
    try {
        const admin = token('person', [], { actorType: 'user', sub: SUBJECT, extra: { subject_id: SUBJECT, role: 'admin' } });
        const list = await request(h.base, 'GET', '/api/v1/tasks');
        assert.strictEqual(list.status, 200, list.text);
        const task = list.body.tasks.find((x) => x.name === 'image.picture');
        assert.ok(task, 'image.picture is seeded');
        assert.strictEqual(task.workflow, 'image.picture');
        const defaults = await request(h.base, 'GET', '/api/v1/admin/task-defaults', { tok: admin });
        assert.strictEqual(defaults.status, 200, defaults.text);
        assert.strictEqual(defaults.body.defaults['image.picture'].image_model, null, 'make starts off');
        assert.strictEqual(defaults.body.defaults['image.picture'].guest_find, false);
        assert.deepStrictEqual(defaults.body.defaults['image.picture'].search_engines.map((e) => e.engine), ['commons', 'openverse']);
        const value = { signed_out: { model: 'openvibe/auto', source: 'openvibe' }, signed_in: { model: 'openvibe/auto', source: 'openvibe' }, fallbacks: [], image_model: { model: 'gpt-image-1', source: 'openvibe' }, search_engines: [{ engine: 'openverse', enabled: true }, { engine: 'commons', enabled: false }], max_cost_usd: null, daily_cap: 6, guest_find: true };
        const put = await request(h.base, 'PUT', '/api/v1/admin/task-defaults', { tok: admin, body: { defaults: [{ task: 'image.picture', value }] } });
        assert.strictEqual(put.status, 200, put.text);
        assert.deepStrictEqual(put.body.defaults['image.picture'], value);
    } finally { await h.stop(); }
});

t.test('a make dry run is a run of the task: the owner model, the daily cap query and the estimate', async () => {
    const h = await boot({ env: { AI_IMAGE_MODEL: 'gpt-image-1' } });
    try {
        await h.registry.upsertModel({ provider_key: 'shared', model_key: 'gpt-image-1', type: 'image', metadata: { price_per_image_usd: 0.04 } });
        const value = { signed_out: { model: 'openvibe/auto', source: 'openvibe' }, signed_in: { model: 'openvibe/auto', source: 'openvibe' }, fallbacks: [], image_model: { model: 'gpt-image-1', source: 'openvibe' }, search_engines: [], max_cost_usd: null, daily_cap: 4, guest_find: false };
        await h.db.prepare("UPDATE ai_task_defaults SET value = ? WHERE task = 'image.picture'").run(JSON.stringify(value));
        const tok = token('blog', ALL);
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: { workflow: 'image.picture', on_behalf_of: { type: 'user', id: SUBJECT }, input: { mode: 'make', prompt: 'A goose', n: 2, dry_run: true, media_app: 'blog' } } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.run.status, 'succeeded', JSON.stringify(r.body.run.error));
        assert.deepStrictEqual(r.body.run.output.estimate, { model: 'openai/gpt-image-1', source: 'openvibe', images: 2, per_image_usd: 0.04, price_usd: 0.08 });
        assert.deepStrictEqual(r.body.run.output.media, []);
    } finally { await h.stop(); }
});

t.test('a priced image run settles at the per-image price', async () => {
    const up = await seamServer(() => ({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }] }));
    const h = await boot({ env: { AI_IMAGE_MODEL: 'gpt-image-1', AI_BASE_URL: `${up.url}/v1`, AI_STUB_FALLBACK: 'false', AI_PROVIDER_RETRIES: '0' } });
    try {
        await h.registry.upsertModel({ provider_key: 'shared', model_key: 'gpt-image-1', type: 'image', metadata: { price_per_image_usd: 0.04 } });
        const route = await h.registry.resolveRoute('default.image');
        const exec = await h.pool.execute(route, 'image', { prompt: 'x', n: 2, timeoutMs: 5000 }, { workflowKey: 'image.picture', imagePriceUsd: 0.04, routeKey: route.key, routeVersion: route.version });
        assert.strictEqual(exec.usage.output, 2);
        assert.ok(Math.abs(exec.cost - 0.08) < 1e-9, `cost 0.08, got ${exec.cost}`);
        const plain = await h.pool.execute(route, 'image', { prompt: 'x', n: 1, timeoutMs: 5000 }, { workflowKey: 'ai.image', routeKey: route.key, routeVersion: route.version });
        assert.strictEqual(plain.cost, 0, 'an unpriced image run keeps the old zero-cost behaviour');
    } finally { await h.stop(); await up.close(); }
});

t.test('the Media client uploads into the calling product\'s tenant for the person', async () => {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, subject: req.headers['x-ov-subject'], body: raw });
            const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.method === 'POST' && req.url === '/api/v2/wiki/objects') return json(201, { id: MEDIA, upload: { url: 'https://openvibe.media/o/x', token: 't', complete_url: 'https://openvibe.media/o/x/complete' } });
            if (req.method === 'PUT' && req.url === '/o/x') return json(200, { ok: true });
            if (req.method === 'POST' && req.url === '/o/x/complete') return json(200, { object: { id: MEDIA, lifecycle_status: 'ready', width: 40, height: 30 } });
            json(404, {});
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
        const { createMediaStore } = require('../server/media-store');
        const media = { publicUrl: 'https://openvibe.media', internalUrl: `http://127.0.0.1:${srv.address().port}`, app: 'ai' };
        const store = createMediaStore({ config: { media, networkInternalUrl: 'http://network.test' }, env: { OV_OAUTH_CLIENT_SECRET: 'not-a-secret' }, fetchImpl: fetch, tokens: { authHeaders: async () => ({ Authorization: 'Bearer test' }) } });
        const r = await store.put({ bytes: PNG, mime: 'image/png', owner: SUBJECT, app: 'wiki', metadata: { license: 'CC BY-SA 4.0' } });
        assert.strictEqual(r.media_id, MEDIA);
        assert.strictEqual(r.width, 40);
        assert.ok(seen.every((x) => x.subject === SUBJECT), 'the picture belongs to the person');
        assert.strictEqual(seen[0].url, '/api/v2/wiki/objects', 'the calling product\'s tenant');
        assert.match(seen[0].body, /"license":"CC BY-SA 4.0"/);
    } finally { await new Promise((r) => srv.close(r)); }
});

t.test('bytes and providers are judged, not trusted', () => {
    assert.strictEqual(mimeOf(PNG), 'image/png');
    assert.strictEqual(mimeOf(Buffer.from([0xff, 0xd8, 0xff, 0])), 'image/jpeg');
    assert.strictEqual(freeProvider({ kind: 'stub' }), true);
    assert.strictEqual(freeProvider({ kind: 'openai', billing_profile: 'metered' }), false);
    assert.strictEqual(freeProvider({ kind: 'openai', billing_profile: 'subscription' }), true);
});

t.run();
