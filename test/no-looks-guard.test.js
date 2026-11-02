'use strict';
// Owner, 2026-10-31: AI may describe people; only sex acts and porn stay gated. No server file may call the old
// looks filter again.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && /\b(noLooks|noLooksTags|hasLooks)\s*\(|openvibe-sdk\/no-looks/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
    }
})(path.join(root, 'server'));
assert.deepStrictEqual(offenders, [], 'no looks filter in server/');
console.log('No looks filter: AI text describes people as written.');
