'use strict';
// A page's odd answer never takes AI down (11-20: AI restarted twice at 22:47 and 22:48 when search v2 read a page whose
// server answered a status a Response may not carry). The guarded fetch now rejects that request instead of throwing in
// the socket's callback, keeps the headers the Fetch API accepts, and gives no-body statuses no body; the page reader
// counts such an answer as the page's refusal, never the reader's failure.
const assert = require('node:assert/strict');
const { responseOf } = require('../server/providers/guarded-fetch');
const reader = require('../server/search/adapters/openvibe-egress');

(async () => {
    for (const status of [999, 0, 103, 600, 199, NaN]) {
        assert.throws(() => responseOf(status, Buffer.from('x'), {}), (e) => e.code === 'EBADSTATUS', String(status));
    }
    const ok = responseOf(200, Buffer.from('<p>hi</p>'), { 'content-type': 'text/html', 'x-bad': 'café\u0000', 'set-cookie': ['a=1', 'b=2'] });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '<p>hi</p>');
    assert.equal(ok.headers.get('content-type'), 'text/html');
    assert.equal(ok.headers.get('x-bad'), null, 'a header the Fetch API refuses is left out, not thrown');
    for (const status of [204, 205, 304]) assert.equal(responseOf(status, Buffer.from('ignored'), {}).body, null, `${status} has no body`);
    assert.equal(responseOf(302, Buffer.from(''), { location: '/next' }).headers.get('location'), '/next', 'a redirect is still an answer');
    console.log('  ✓ odd statuses reject, refused headers are left out, no-body statuses have no body');

    const fetchImpl = async () => { throw Object.assign(new Error('the server answered status 999'), { code: 'EBADSTATUS' }); };
    await assert.rejects(reader.read({ url: 'https://www.linkedin.com/in/someone' }, { fetchImpl }), (e) => e.target === true, 'the page refused, not the reader');
    console.log('  ✓ the page reader counts an odd status as the page\'s refusal');
    console.log('guarded-fetch-status: 2 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
