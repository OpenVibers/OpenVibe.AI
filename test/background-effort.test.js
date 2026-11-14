'use strict';
// A background product run thinks at low effort unless it names its own (11-14: at the default medium, gpt-5-nano on
// background.json spent its whole allowance reasoning, answered nothing and timed out on the Flex tier).
const assert = require('assert');
const { workflows } = require('../server/workflows/products');
const { resolve } = require('../server/effort/defaults');

(async () => {
    const background = workflows.filter((w) => /^background\b/.test(String(w.default_route || '')));
    assert.ok(background.length >= 8, `the background product workflows are found (${background.length})`);
    for (const w of background) {
        const r = await resolve({}, w, { get: async () => ({}) });
        assert.strictEqual(r.effort_resolved, 'low', `${w.key} runs at low effort by default`);
        const asked = await resolve({ effort: 'high' }, w, { get: async () => ({}) });
        assert.strictEqual(asked.effort_resolved, 'high', `${w.key}: a caller that asks for more still gets it`);
    }
    const foreground = workflows.filter((w) => !/^background\b/.test(String(w.default_route || '')) && !(w.metadata && w.metadata.effort));
    for (const w of foreground) {
        const r = await resolve({}, w, { get: async () => ({}) });
        assert.strictEqual(r.effort_resolved, 'medium', `${w.key} keeps the default`);
    }
    console.log(`background-effort.test.js: ${background.length} background workflows at low, ${foreground.length} others unchanged`);
})().catch((e) => { console.error(e); process.exit(1); });
