'use strict';
// The capability manifests proposed for openvibe-contracts (docs/capabilities-proposal/) are valid
// contracts documents, use 3+ segment ids owned by 'ai', and are exactly the ids this service enforces.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { CAPS } = require('../server/auth');
const { suite } = require('./helpers');

const t = suite('proposals');
const dir = path.join(__dirname, '..', 'docs', 'capabilities-proposal');

t.test('every proposal validates against the contracts schemas', () => {
    for (const f of fs.readdirSync(dir)) {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const v = contracts.validate(f.startsWith('service-manifest') ? 'registry.service-manifest' : 'capabilities.capability', doc);
        assert.ok(v.valid, `${f}: ${JSON.stringify(v.errors)}`);
    }
});

t.test('capability ids: owner ai, 3+ segments, the same set the service enforces and the manifest lists', () => {
    const caps = fs.readdirSync(dir).filter(f => !f.startsWith('service-manifest')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    for (const c of caps) {
        assert.strictEqual(c.owner, 'ai');
        assert.ok(c.id.split('.').length >= 3, c.id);
        assert.ok(!contracts.capabilities.get(c.id) || contracts.capabilities.get(c.id).owner === 'ai', `${c.id} is owned elsewhere in contracts`);
    }
    const ids = caps.map(c => c.id).sort();
    assert.deepStrictEqual(ids, Object.values(CAPS).sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'service-manifest.ai.json'), 'utf8'));
    assert.deepStrictEqual([...manifest.capabilities].sort(), ids);
});

t.run();
