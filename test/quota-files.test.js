'use strict';
// The per-person file limits live in the existing quota system: a quota row's max_files / max_file_bytes
// caps what that scope may attach in its window, and the usage counters keep the running totals.
const assert = require('node:assert/strict');
const { testDb } = require('./db');
const { createQuotas } = require('../server/quota');
const { suite, fixedClock } = require('./helpers');

const t = suite('quota-files');
// The counters live in the quota's own window; a fixed clock keeps every charge in one window.
const clock = fixedClock();
let h;
const person = { requesterType: 'service', requesterId: 'chat', actorKey: 'user:usr_01ARZ3NDEKTSV4RRFFQ69G5FAV', workflowKey: 'ai.complete' };

t.test('a migrated database', async () => { h = await testDb(); });
t.test('an actor quota caps one person\'s files and file bytes in its window', async () => {
    const quotas = createQuotas(h.db, { clock });
    await quotas.upsert({ scope_type: 'actor', scope_id: person.actorKey, window: 'day', max_files: 3, max_file_bytes: 100 });
    await quotas.chargeFiles(person, [{ size: 10 }, { size: 20 }]);
    await quotas.chargeFiles(person, [{ size: 70 }]);
    const used = (await quotas.counters(person))[0].used;
    assert.equal(used.files, 3);
    assert.equal(used.file_bytes, 100);
    await assert.rejects(() => quotas.chargeFiles(person, [{ size: 1 }]), (err) => err.status === 429 && /3 files per day/.test(err.detail));
    await assert.rejects(() => quotas.chargeFiles(person, [{ size: 1 }]), (err) => err.status === 429 && err.extra && err.extra.retry_after_seconds >= 1);
});

t.test('another person is not limited by the first person\'s quota', async () => {
    const quotas = createQuotas(h.db, { clock });
    const other = { ...person, actorKey: 'user:usr_01ARZ3NDEKTSV4RRFFQ69G5FBV' };
    const out = await quotas.chargeFiles(other, [{ size: 5 }, { size: 5 }, { size: 5 }, { size: 5 }]);
    assert.deepEqual(out, { files: 4, file_bytes: 20 });
});

t.test('a quota with no file limits still counts files for the window', async () => {
    const quotas = createQuotas(h.db, { clock });
    const ctx = { ...person, actorKey: 'user:usr_01ARZ3NDEKTSV4RRFFQ69G5FCV' };
    await quotas.chargeFiles(ctx, [{ size: 7 }]);
    const row = await h.db.prepare("SELECT files, file_bytes FROM usage_counters WHERE scope_type = 'actor' AND scope_id = ? AND \"window\" = 'day'").get(ctx.actorKey);
    assert.equal(Number(row.files), 1);
    assert.equal(Number(row.file_bytes), 7);
});

t.test('the admin quota accepts the new fields and validates them', async () => {
    const quotas = createQuotas(h.db, { clock });
    const row = await quotas.upsert({ scope_type: 'global', scope_id: '*', window: 'hour', max_files: 2, max_file_bytes: 500 });
    assert.equal(Number(row.max_files), 2);
    assert.equal(Number(row.max_file_bytes), 500);
    await assert.rejects(() => quotas.upsert({ scope_type: 'global', scope_id: '*', window: 'hour', max_files: -1 }), /max_files must be >= 0/);
});

t.test('close', async () => { await h.close(); });

t.run();
