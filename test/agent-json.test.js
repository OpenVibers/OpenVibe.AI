'use strict';
// SEO-2: /.well-known/agent.json answered 404 here (11-03 check of all 55 sites). The shared agent layer serves this
// site's descriptor; every field is something it really serves.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const descriptor = require('../server/agent-descriptor');
const { agentManifest } = require('openvibe-shared/agent-layer');

const m = agentManifest(descriptor);
assert.strictEqual(m.network, 'OpenVibe');
assert.strictEqual(m.home, 'https://ai.openvibe.services');
assert.ok(m.purpose && m.purpose.length > 40, 'a purpose');
assert.ok(/^https:\/\//.test(m.api), 'its API, absolute');
assert.strictEqual(m.llms, 'https://ai.openvibe.services/llms.txt');
assert.ok(Array.isArray(m.policy.auth) && m.policy.auth.length, 'how it is called');
const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
assert.match(app, /require\('openvibe-shared\/agent-layer'\)\.mount\(app, \{ descriptor: require\('\.\/agent-descriptor'\) \}\);/);
console.log('agent.json: ok');
