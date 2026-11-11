'use strict';
const assert = require('node:assert/strict');
const { rankImages } = require('../server/search/image-rank');

const rows = [
    { title: 'A small cat', url: 'https://example.org/images/cat_400x300.jpg', width: 400, height: 300 },
    { title: 'A small cat', url: 'https://example.org/images/cat_3000x2000.jpg', width: 3000, height: 2000, source_page: 'https://example.org/cat', license: 'cc0', license_url: 'https://example.org/license' },
    { title: 'Other picture', url: 'https://example.org/other.jpg', width: 1000, height: 1000 },
];
const out = rankImages(rows, 10);
assert.equal(out.length, 2);
assert.equal(out[0].width, 3000);
assert.equal(rankImages(rows, 1).length, 1);
process.stdout.write('image ranking passed\n');
