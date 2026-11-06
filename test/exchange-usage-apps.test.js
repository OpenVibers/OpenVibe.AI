'use strict';
// Exchange's public usage read (server/exchange/usage.js) names first-party services, never a developer's app: every
// app's runs fold into one "apps" row with how many apps it covers, and the models used are summed across them.
const assert = require('assert');
const { createUsage } = require('../server/exchange/usage');

const product = [
    { requester_id: 'live', requester_type: 'service', requests: 5, tokens_in: 500, tokens_out: 50, cost_usd: 0.001 },
    { requester_id: 'app_ABC', requester_type: 'app', requests: 3, tokens_in: 300, tokens_out: 30, cost_usd: 0.0006 },
    { requester_id: 'app_XYZ', requester_type: 'app', requests: 4, tokens_in: 400, tokens_out: 40, cost_usd: 0.0008 },
];
const productModels = [
    { requester_id: 'live', requester_type: 'service', provider_key: 'shared', model_key: 'gpt-5-nano', requests: 5, tokens_in: 500, tokens_out: 50, cost_usd: 0.001 },
    { requester_id: 'app_ABC', requester_type: 'app', provider_key: 'deepseek', model_key: 'deepseek-chat', requests: 3, tokens_in: 300, tokens_out: 30, cost_usd: 0.0006 },
    { requester_id: 'app_XYZ', requester_type: 'app', provider_key: 'deepseek', model_key: 'deepseek-chat', requests: 4, tokens_in: 400, tokens_out: 40, cost_usd: 0.0008 },
];
const db = {
    prepare(sql) {
        const rows = /GROUP BY requester_id, requester_type, provider_key/.test(sql) ? productModels
            : /GROUP BY requester_id, requester_type/.test(sql) ? product : [];
        return { all: async () => rows };
    },
};

(async () => {
    const out = await createUsage({ db, clock: { now: () => Date.parse('2026-11-06T12:00:00Z') } }).read({ days: 7 });
    const text = JSON.stringify(out);
    assert.ok(!/app_ABC|app_XYZ/.test(text), 'no developer app is named on the public read');
    const apps = out.by_product.find((p) => p.type === 'apps');
    assert.ok(apps, 'the apps are one row');
    assert.strictEqual(apps.apps, 2, 'covering two apps');
    assert.strictEqual(apps.requests, 7);
    assert.strictEqual(apps.models.length, 1, 'one model, summed across the apps');
    assert.strictEqual(apps.models[0].requests, 7);
    const live = out.by_product.find((p) => p.product === 'live');
    assert.strictEqual(live.type, 'service');
    assert.strictEqual(out.by_product[0].type, 'apps', 'ordered by requests');
    console.log('exchange usage: apps fold into one row and are never named');
})().catch((e) => { console.error(e); process.exit(1); });
