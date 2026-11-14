'use strict';
// The AI's fetch guard (server/fetcher.js) reads only the hosts the configuration allows. The network's own domains
// are on that list, the three doors of 2026-11-13 (openvibe.expert, openvibe.markets, openvibe.finance) among them:
// their own services come later, but the domains answer and their pages may be read by an AI run.
const assert = require('assert');
const { load } = require('../server/config');
const { createFetcher } = require('../server/fetcher');

const config = load({ NODE_ENV: 'test' });
const f = createFetcher(config);
for (const host of ['openvibe.expert', 'openvibe.markets', 'openvibe.finance']) {
    assert.ok(config.media.allowHosts.includes(host), `${host} is on the default allow-list`);
    assert.strictEqual(f.hostAllowed(host), true, `${host} may be fetched`);
}
// The network's own places stay readable, and nothing else is.
for (const host of ['openvibe.media', 'openvibe.live', 'openvibe.network', 'openvibe.tools', 'openvibe.games']) {
    assert.strictEqual(f.hostAllowed(host), true, `${host} may be fetched`);
}
assert.strictEqual(f.hostAllowed('evil.example'), false, 'a host outside the list is refused');
assert.strictEqual(f.hostAllowed('openvibe.expert.evil.example'), false, 'a look-alike host is refused');

console.log('fetch allow-hosts: the network\'s own domains, the three doors among them, are the only ones read');
