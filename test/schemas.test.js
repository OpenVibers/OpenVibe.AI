'use strict';
// The compiled-schema cache is shared by every caller and holds caller-supplied schemas
// (ai.extract / ai.enrich), so it must stay bounded: an LRU capped by entry count and by total schema
// size, with evicted schemas released by Ajv too. Validation stays correct across evictions.

const assert = require('assert');
const { suite, boot, request, token, ALL } = require('./helpers');
const schemas = require('../server/schemas');

const t = suite('schemas');
const distinct = (i) => ({ type: 'object', required: [`k${i}`], properties: { [`k${i}`]: { type: 'string' } } });

t.test('the cache never grows past its entry cap, and Ajv lets go of evicted schemas', () => {
    schemas.configure({ maxEntries: 50, maxBytes: 1024 * 1024 });
    const base = schemas.stats().ajv_held - schemas.stats().entries;      // Ajv's own meta-schemas
    for (let i = 0; i < 2000; i++) schemas.compile(distinct(i));
    const s = schemas.stats();
    assert.ok(s.entries <= 50, `entries ${s.entries}`);
    assert.ok(s.ajv_held <= base + 50, `Ajv still holds ${s.ajv_held - base} compiled schemas`);
});

t.test('least recently used goes first; a hit refreshes an entry', () => {
    schemas.configure({ maxEntries: 3, maxBytes: 1024 * 1024 });
    const a = schemas.compile(distinct('a'));
    schemas.compile(distinct('b'));
    schemas.compile(distinct('c'));
    assert.strictEqual(schemas.compile(distinct('a')), a, 'a is cached (and now most recent)');
    schemas.compile(distinct('d'));                               // evicts b, not a
    assert.strictEqual(schemas.compile(distinct('a')), a, 'a survived');
    assert.strictEqual(schemas.stats().entries, 3);
});

t.test('the byte cap bounds total schema size; an oversized schema is compiled but not kept', () => {
    schemas.configure({ maxEntries: 1000, maxBytes: 4096 });
    const big = (i) => ({ type: 'object', description: `${i}`.padEnd(1500, 'x') });
    for (let i = 0; i < 40; i++) schemas.compile(big(i));
    const s = schemas.stats();
    assert.ok(s.bytes <= 4096, `bytes ${s.bytes}`);
    assert.ok(s.entries <= 3, `entries ${s.entries}`);
    const huge = { type: 'object', required: ['x'], description: 'y'.repeat(10000) };
    const before = schemas.stats();
    assert.strictEqual(schemas.validate(huge, {}).valid, false);
    assert.strictEqual(schemas.validate(huge, { x: 1 }).valid, true);
    assert.strictEqual(schemas.stats().entries, before.entries, 'not cached');
    assert.ok(schemas.stats().ajv_held <= before.ajv_held, 'not held by Ajv either');
});

t.test('invalid schemas leave nothing behind; evicted schemas still validate correctly', () => {
    schemas.configure({ maxEntries: 5, maxBytes: 1024 * 1024 });
    const held = schemas.stats().ajv_held;
    for (let i = 0; i < 200; i++) assert.throws(() => schemas.assertSchema({ type: 'object', properties: { [`p${i}`]: { type: 'no-such-type' } } }), /does not compile/);
    assert.ok(schemas.stats().ajv_held <= held, `failed compiles leaked ${schemas.stats().ajv_held - held} schemas into Ajv`);
    const s0 = distinct(0);
    assert.strictEqual(schemas.validate(s0, {}).valid, false);
    for (let i = 1; i < 20; i++) schemas.compile(distinct(i));   // s0 evicted
    assert.strictEqual(schemas.validate(s0, {}).valid, false);
    assert.strictEqual(schemas.validate(s0, { k0: 'v' }).valid, true);
});

t.test('config: AI_SCHEMA_CACHE_MAX / AI_SCHEMA_CACHE_MAX_BYTES reach the cache at boot', async () => {
    const h = await boot({ env: { AI_SCHEMA_CACHE_MAX: '7', AI_SCHEMA_CACHE_MAX_BYTES: '65536' } });
    try {
        const tok = token('live', ALL);
        for (let i = 0; i < 20; i++) {
            const r = await request(h.base, 'POST', '/api/v1/extract?wait=3000', { tok, body: { text: `item ${i}`, schema: distinct(`x${i}`), options: { cache: false } } });
            assert.ok(r.status < 500, `extract ${i}: ${r.status}`);
        }
        const s = schemas.stats();
        assert.strictEqual(s.max_entries, 7);
        assert.strictEqual(s.max_bytes, 65536);
        assert.ok(s.entries <= 7, `entries ${s.entries}`);
    } finally { await h.stop(); }
});

t.run();
