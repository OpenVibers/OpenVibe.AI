'use strict';
/**
 * The owner's one action that opens an offer (server/exchange/offers.js and the console JSON API):
 * an offer is live only when its provider is on, its key is present, its model is on and its price is
 * approved; opening it approves the waiting prices (or writes the owner's fixed per-token price) and
 * switches both on, with one audit row. A missing key is refused before anything is written.
 *
 * No provider is called, no key is printed, and every model/provider here is a local record.
 */
const assert = require('assert');
const { boot, suite, token, request } = require('./helpers');

const t = suite('offer-routes');
const READ = token('console', ['ai.usage.read']);
const WRITE = token('console', ['ai.provider.manage']);

async function seed(h, key, { env = 'TEST_REFUSELESS_KEY', status = 'disabled', price = null } = {}) {
    await h.registry.upsertProvider({
        key, display_name: `${key} test`, kind: 'openai', status,
        base_url: 'https://api.example.test/v1', auth_mode: 'bearer', secret_ref: `env:${env}`,
        capabilities: ['chat'], provider_access: 'UNVERIFIED',
    }, { actor: 'test' });
    const model = await h.registry.upsertModel({
        provider_key: key, model_key: 'abliterated-model', display_name: 'Abliterated test model',
        type: 'chat', status: 'disabled', context_window: 32768,
        cost: { in_per_mtok: 1, out_per_mtok: 3, source: 'https://api.example.test/pricing', verified_at: '2026-11-10' },
        supports: { json: true, tools: false, streaming: true, vision: false },
        metadata: { uncensored: true },
    }, { actor: 'test' });
    return model;
}

t.test('an unkeyed provider is not live, and opening it writes nothing', async () => {
    const h = await boot({ env: { TEST_REFUSELESS_KEY: '' } });
    try {
        await seed(h, 'keyless');
        const before = await h.registry.getModel('keyless', 'abliterated-model');
        const route = await request(h.base, 'GET', '/api/v1/admin/console/models/keyless/abliterated-model/route', { tok: READ });
        assert.strictEqual(route.status, 200, route.text);
        assert.strictEqual(route.body.route.live, false);
        assert.strictEqual(route.body.route.key_present, false);
        assert.ok(route.body.route.reasons.includes('no_key'));
        const opened = await request(h.base, 'POST', '/api/v1/admin/console/models/keyless/abliterated-model/open', { tok: WRITE, body: {} });
        assert.strictEqual(opened.status, 409, opened.text);
        assert.strictEqual(opened.body.code, 'offer.no_key');
        const after = await h.registry.getModel('keyless', 'abliterated-model');
        assert.strictEqual(after.status, 'disabled', 'the model was not switched on');
        const provider = await h.registry.getProvider('keyless');
        assert.strictEqual(provider.status, 'disabled', 'the provider was not switched on');
        assert.strictEqual(before.cost.in_per_mtok, after.cost.in_per_mtok, 'the price was not touched');
    } finally { await h.stop(); }
});

t.test('opening approves the waiting prices, switches the offer on, and the route is live', async () => {
    const h = await boot({ env: { TEST_REFUSELESS_KEY: 'test-only-key' } });
    try {
        await seed(h, 'refuseless');
        const store = h.priceBook.store;
        await store.record({ provider_key: 'refuseless', model_key: 'abliterated-model', field: 'in_per_mtok',
            old_price: 1, new_price: 2, change_pct: 1, source: 'https://api.example.test/pricing', checked_at: '2026-11-10', status: 'pending' });
        await store.record({ provider_key: 'refuseless', model_key: 'abliterated-model', field: 'out_per_mtok',
            old_price: 3, new_price: 5, change_pct: 0.66, source: 'https://api.example.test/pricing', checked_at: '2026-11-10', status: 'pending' });
        const opened = await request(h.base, 'POST', '/api/v1/admin/console/models/refuseless/abliterated-model/open', { tok: WRITE, body: {} });
        assert.strictEqual(opened.status, 200, opened.text);
        assert.strictEqual(opened.body.route.live, true);
        assert.strictEqual(opened.body.route.price.in, 2);
        assert.strictEqual(opened.body.route.price.out, 5);
        const model = await h.registry.getModel('refuseless', 'abliterated-model');
        assert.strictEqual(model.status, 'active');
        assert.strictEqual(model.cost.in_per_mtok, 2);
        assert.strictEqual(model.cost.out_per_mtok, 5);
        assert.strictEqual((await h.registry.getProvider('refuseless')).status, 'active');
        const waiting = await h.priceBook.pending(50);
        assert.strictEqual(waiting.length, 0, 'both waiting prices were decided');
        const audit = await h.db.prepare("SELECT action, metadata FROM audit_log WHERE action = 'offer.opened' ORDER BY id DESC LIMIT 1").get();
        assert.ok(audit, 'the open is audited');
        assert.ok(JSON.parse(audit.metadata).live, 'the audit says the route is live');
    } finally { await h.stop(); }
});

t.test('a fixed per-token price is the owner’s approval, without a waiting change', async () => {
    const h = await boot({ env: { TEST_REFUSELESS_KEY: 'test-only-key' } });
    try {
        await seed(h, 'hosted');
        const opened = await request(h.base, 'POST', '/api/v1/admin/console/models/hosted/abliterated-model/open', { tok: WRITE,
            body: { price: { in_per_mtok: 0.2, out_per_mtok: 0.7, reason: 'owner approved a fixed host price' } } });
        assert.strictEqual(opened.status, 200, opened.text);
        assert.strictEqual(opened.body.route.live, true);
        assert.strictEqual(opened.body.route.price.source, 'owner');
        const model = await h.registry.getModel('hosted', 'abliterated-model');
        assert.strictEqual(model.cost.in_per_mtok, 0.2);
        assert.strictEqual(model.cost.out_per_mtok, 0.7);
        assert.strictEqual(model.metadata.owner_fixed_price, true);
        assert.strictEqual(model.metadata.owner_fixed_price_reason, 'owner approved a fixed host price');
        // The price shown in the models console is the same live route.
        const models = await request(h.base, 'GET', '/api/v1/admin/console/models', { tok: READ });
        assert.strictEqual(models.status, 200, models.text);
        const row = models.body.models.find((m) => m.provider === 'hosted');
        assert.strictEqual(row.route.live, true);
        assert.strictEqual(row.route.price.source, 'owner');
    } finally { await h.stop(); }
});

t.test('an offer with no price and no waiting change stays closed', async () => {
    const h = await boot({ env: { TEST_REFUSELESS_KEY: 'test-only-key' } });
    try {
        await seed(h, 'unpriced');
        await h.registry.upsertModel({
            provider_key: 'unpriced', model_key: 'abliterated-model', type: 'chat', status: 'disabled',
            cost: { in_per_mtok: null, out_per_mtok: null }, metadata: {},
        }, { actor: 'test' });
        const opened = await request(h.base, 'POST', '/api/v1/admin/console/models/unpriced/abliterated-model/open', { tok: WRITE, body: {} });
        assert.strictEqual(opened.status, 409, opened.text);
        assert.strictEqual(opened.body.code, 'offer.no_price');
        assert.strictEqual((await h.registry.getModel('unpriced', 'abliterated-model')).status, 'disabled');
        assert.strictEqual((await h.registry.getProvider('unpriced')).status, 'disabled');
    } finally { await h.stop(); }
});

t.run();
