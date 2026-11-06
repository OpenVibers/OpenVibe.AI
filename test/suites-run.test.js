'use strict';
// A suite() in this repo only collects tests: nothing runs until `t.run()`. A file that builds one and
// forgets the call exits 0 having checked nothing, and the runner counts it as a pass. Four did
// (exchange-catalog-kinds, free-ceiling, free-providers, exchange-read), so a new one fails here instead of passing quietly.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('suites-run');

t.test('every test file that builds a suite runs it', () => {
    const suites = fs.readdirSync(__dirname)
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => ({ name, source: fs.readFileSync(path.join(__dirname, name), 'utf8') }))
        .filter((f) => /\bsuite\s*\(/.test(f.source) && !/function suite/.test(f.source));
    assert.ok(suites.length > 0, 'no suite() file was found: the scan is broken');
    // The suite's own variable must be run: `const t = suite(...)` needs `t.run(`. A bare `.run(` is not enough,
    // because a database statement's `.run(...)` would hide a vacuous file (exchange-read did).
    const neverRun = suites.filter((f) => {
        const names = [...f.source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*suite\s*\(/g)].map((m) => m[1]);
        if (!names.length) return !/\bsuite\s*\([^)]*\)\s*\.run\s*\(/.test(f.source);
        return names.some((n) => !new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\.run\\s*\\(').test(f.source));
    }).map((f) => f.name);
    assert.deepStrictEqual(neverRun, [], `these files build a suite and never run it: ${neverRun.join(', ')}`);
});

t.run();
