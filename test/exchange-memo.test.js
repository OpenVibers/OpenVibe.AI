'use strict';
// The Exchange catalog's memo (server/api/exchange.js), stale while revalidating (11-13): the catalog's measured stats
// take 0.5-0.75 s to read under load, and a visitor past the 30 s lifetime waited for them every time.
//   - inside its lifetime the answer is served as it is, with no rebuild;
//   - past it, the last answer returns at once and ONE rebuild runs behind it; the next caller sees the new one;
//   - a first build is shared by callers who arrive together;
//   - an answer older than ten lifetimes is not served stale: the caller waits for the rebuild and sees its error.
const assert = require('assert');
const { suite } = require('./helpers');
const { memo } = require('../server/api/exchange');

const t = suite('exchange-memo');
const tick = () => new Promise((r) => setImmediate(r));

t.test('inside its lifetime the answer is served with no rebuild', async () => {
    let now = 0, calls = 0;
    const get = memo(async () => ({ n: ++calls }), 30_000, { now: () => now });
    assert.deepStrictEqual(await get(), { n: 1 });
    now = 29_999;
    assert.deepStrictEqual(await get(), { n: 1 });
    assert.strictEqual(calls, 1);
});

t.test('past its lifetime the last answer returns at once and one rebuild runs behind it', async () => {
    let now = 0, calls = 0, release = null;
    const get = memo(async () => {
        calls += 1;
        if (calls === 1) return { n: 1 };
        await new Promise((r) => { release = r; });
        return { n: calls };
    }, 30_000, { now: () => now });
    await get();
    now = 31_000;
    assert.deepStrictEqual(await get(), { n: 1 }, 'the visitor gets the last answer without waiting');
    assert.deepStrictEqual(await get(), { n: 1 });
    await tick();
    assert.strictEqual(calls, 2, 'one rebuild, however many callers');
    release();
    await tick(); await tick();
    assert.deepStrictEqual(await get(), { n: 2 }, 'the next caller sees the rebuilt answer');
});

t.test('callers who arrive together share the first build', async () => {
    let calls = 0;
    const get = memo(async () => { calls += 1; await tick(); return { n: calls }; }, 30_000, { now: () => 0 });
    const [a, b, c] = await Promise.all([get(), get(), get()]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
});

t.test('an answer older than ten lifetimes is not served stale', async () => {
    let now = 0, calls = 0;
    const get = memo(async () => { calls += 1; if (calls > 1) throw new Error('catalog down'); return { n: 1 }; }, 30_000, { now: () => now });
    await get();
    now = 301_000;
    await assert.rejects(get(), /catalog down/, 'the caller waits for the rebuild and sees its error');
});

t.test('a rebuild that fails behind a fresh-enough answer keeps the last answer', async () => {
    let now = 0, calls = 0;
    const get = memo(async () => { calls += 1; if (calls > 1) throw new Error('blip'); return { n: 1 }; }, 30_000, { now: () => now });
    await get();
    now = 40_000;
    assert.deepStrictEqual(await get(), { n: 1 });
    await tick(); await tick();
    assert.deepStrictEqual(await get(), { n: 1 }, 'still the last answer; the failed rebuild changed nothing');
});

t.run();
