'use strict';
const assert = require('assert');
const { load } = require('../server/config');
const { suite } = require('./helpers');

const t = suite('billing-config');

t.test('production relays usage to colocated Billing unless overridden or disabled', () => {
    assert.strictEqual(load({ NODE_ENV: 'production' }).billing.billingUrl, 'http://127.0.0.1:4600');
    assert.strictEqual(load({ NODE_ENV: 'development' }).billing.billingUrl, '');
    assert.strictEqual(load({ NODE_ENV: 'production', OV_BILLING_INTERNAL_URL: 'https://billing.example/' }).billing.billingUrl, 'https://billing.example');
    assert.strictEqual(load({ NODE_ENV: 'production', OV_BILLING_INTERNAL_URL: '' }).billing.billingUrl, '');
    assert.strictEqual(load({ NODE_ENV: 'production', USAGE_SAMPLES: 'off' }).billing.enabled, false);
});

t.run();
