'use strict';
const assert = require('node:assert/strict');
const { attachFiles } = require('../server/file-inputs');
const { suite } = require('./helpers');

const id = 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const fetcher = {
    mediaRefUrl: ({ media_id }) => `https://openvibe.media/o/${media_id}`,
    fetchUrl: async () => ({ buffer: Buffer.from('a,b\n1,2\n'), contentType: 'text/csv' }),
};

const t = suite('file-inputs');
t.test('text attachments are resolved from Media references into the user turn', async () => {
    const out = await attachFiles({ messages: [{ role: 'user', content: 'Review' }], files: [{ media_id: id, name: 'data.csv', media_type: 'text/csv' }] }, fetcher);
    assert.match(out.messages[0].content[1].text, /Attached file: data\.csv/);
    assert.match(out.messages[0].content[1].text, /a,b/);
    assert.equal(out.files.length, 1);
    const ignored = await attachFiles({ messages: [{ role: 'user', content: 'Hi' }] }, fetcher);
    assert.equal(ignored.messages[0].content, 'Hi');
    await assert.rejects(() => attachFiles({ messages: [{ role: 'user', content: 'Hi' }], files: [{ media_id: 'bad' }] }, fetcher), /stored Media object/);
});
