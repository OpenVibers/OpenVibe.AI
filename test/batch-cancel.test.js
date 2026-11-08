'use strict';
/**
 * BA3: a batch can be cancelled, and the answer never tells a customer that a prompt which is already
 * with the provider was not charged.
 *
 *   - a prompt that never had a run is cancelled, and it is not charged for;
 *   - a prompt that already has a run (BA2 puts one on the provider's own batch API, or the ordinary path
 *     keeps it) goes on and settles on its own path: it keeps its status, and the answer says so;
 *   - the batch is cancelled only when nothing is left in flight;
 *   - the list of batches answers like one batch: the same shape, without the items.
 */
const assert = require('assert');
const { boot, request, suite, silent, token, ALL } = require('./helpers');

const t = suite('batch-cancel');

const PERSON = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2';

t.test('a batch can be cancelled, and the prompts that had not run are not charged for', async () => {
    const h = await boot({ env: {} });
    try {
        const all = token('dana', ALL, { sub: PERSON, actorType: 'user' });
        const made = await request(h.base, 'POST', '/api/v1/batches', { tok: all, body: { items: ['one prompt', 'another prompt'], deadline_hours: 6 } });
        assert.strictEqual(made.status, 201, made.text);
        const id = made.body.batch.id;
        assert.strictEqual(made.body.batch.item_count, 2, 'the batch says how many prompts it carries');
        assert.strictEqual(made.body.batch.items.length, 2, 'and carries them');

        const cancelled = await request(h.base, 'POST', `/api/v1/batches/${id}/cancel`, { tok: all });
        assert.strictEqual(cancelled.status, 200, cancelled.text);
        assert.strictEqual(cancelled.body.batch.status, 'cancelled', 'nothing was in flight: the batch is cancelled');
        for (const item of cancelled.body.batch.items) {
            assert.strictEqual(item.status, 'cancelled', 'a prompt that had not run is cancelled');
            assert.ok(item.charged_nano_usd === '0' || item.charged_nano_usd === 0 || item.charged_nano_usd === null,
                'and nothing was charged for it');
            assert.match(String(item.reason || ''), /not charged/i, 'and the answer says it was not charged');
        }

        // The list answers like one batch: the same shape, without the items.
        const list = await request(h.base, 'GET', '/api/v1/batches', { tok: all });
        assert.strictEqual(list.status, 200, list.text);
        const row = list.body.batches.find((b) => b.id === id);
        assert.ok(row, 'the batch is in the list');
        assert.strictEqual(row.item_count, 2, 'the list says how many prompts it carries');
        assert.deepStrictEqual(row.items, [], 'and carries no items');

        // A batch that is not there is not found.
        const missing = await request(h.base, 'POST', '/api/v1/batches/bat_nope/cancel', { tok: all });
        assert.strictEqual(missing.status, 404, 'a batch that does not exist is 404');
    } finally { await h.stop(); }
});

t.test('a prompt that is already with the provider is not cancelled, and nobody is told it was not charged', async () => {
    const h = await boot({ env: {} });
    try {
        const all = token('dana', ALL, { sub: PERSON, actorType: 'user' });
        const made = await request(h.base, 'POST', '/api/v1/batches', { tok: all, body: { items: ['one prompt', 'another prompt'], deadline_hours: 6 } });
        assert.strictEqual(made.status, 201, made.text);
        const id = made.body.batch.id;
        // BA2: an item whose run exists waits with that run: the run goes on and settles on the ordinary path.
        await h.testdb.db.prepare("UPDATE batch_items SET status = 'waiting', run_id = ? WHERE batch_id = ? AND idx = 0")
            .run('run_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2', id);

        const cancelled = await request(h.base, 'POST', `/api/v1/batches/${id}/cancel`, { tok: all });
        assert.strictEqual(cancelled.status, 200, cancelled.text);
        const items = cancelled.body.batch.items;
        const sent = items.find((i) => i.idx === 0);
        const other = items.find((i) => i.idx === 1);
        assert.strictEqual(sent.status, 'waiting', 'the prompt that has a run keeps its status');
        assert.strictEqual(sent.run_id, 'run_01J8Z3Q4R5S6T7V8W9X0Y1Z2B2', 'and keeps its run');
        assert.doesNotMatch(String(sent.reason || ''), /not charged/i, 'nobody is told it was not charged');
        assert.match(String(sent.reason || ''), /already sent to the provider/i, 'the answer says it was sent to the provider');
        assert.strictEqual(other.status, 'cancelled', 'the prompt that had not run is cancelled');
        assert.match(String(other.reason || ''), /not charged/i, 'and that one was not charged');
        assert.strictEqual(cancelled.body.batch.status, 'running', 'the batch is still running: a prompt is in flight');
    } finally { await h.stop(); }
});

t.run();
