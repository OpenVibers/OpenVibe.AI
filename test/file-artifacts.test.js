'use strict';
const assert = require('node:assert/strict');
const { collectArtifacts, storeOf } = require('../server/artifacts');
const { suite } = require('./helpers');

const t = suite('file-artifacts');
const ID = 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV';

t.test('a Media reference the model returned becomes a stored artifact', async () => {
    const out = await collectArtifacts({ content: 'Here it is.', artifacts: [{ id: ID, name: 'answer.csv', media_type: 'text/csv', size: 8, storage: { provider: 'media', key: ID }, access: { readers: ['usr_01ARZ3NDEKTSV4RRFFQ69G5FAV'] } }] });
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'artifact');
    assert.equal(out[0].storage.provider, 'media');
    assert.equal(out[0].read.method, 'not_readable');
    assert.equal('content' in out[0].read, false, 'the run output does not inline the bytes');
});

t.test('inline bytes need a Media store; without one they are refused, not dropped', async () => {
    await assert.rejects(() => collectArtifacts({ artifacts: [{ name: 'a.txt', media_type: 'text/plain', data: Buffer.from('hi').toString('base64') }] }),
        (err) => err.status === 503 && err.code === 'files.store_unavailable');
});

t.test('inline bytes are stored through the configured store and returned by reference', async () => {
    const puts = [];
    const store = { put: async (what) => { puts.push(what); return { id: ID, name: what.name, media_type: what.media_type, size: what.bytes.length, storage: { provider: 'media', key: ID }, access: { readers: [what.subject] }, read: { method: 'not_readable', reason: 'Stored by Media; read it by reference.' }, role: 'artifact' }; } };
    const out = await collectArtifacts({ artifacts: [{ name: 'a.txt', media_type: 'text/plain', data: Buffer.from('hi').toString('base64') }] }, { store, subject: 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].bytes.toString(), 'hi');
    assert.equal(puts[0].subject, 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    assert.equal(out[0].id, ID);
});

t.test('storeOf finds a configured store and nothing else', () => {
    assert.equal(storeOf({}), null);
    assert.equal(storeOf({ media: {} }), null);
    const store = { put() {} };
    assert.equal(storeOf({ media: { artifactStore: store } }), store);
});

t.test('more than ten produced files is a refusal', async () => {
    const artifacts = Array.from({ length: 11 }, () => ({ id: ID, name: 'a.txt', media_type: 'text/plain', size: 1 }));
    await assert.rejects(() => collectArtifacts({ artifacts }), (err) => err.status === 413 && err.code === 'files.too_many');
});

t.run();
