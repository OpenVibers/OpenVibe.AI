'use strict';
// A window's measured stats are read once and shared (server/exchange/observed.js; 11-20, production: four reads of the
// week every catalog rebuild, per kind and window, each a sequential scan of runs at 0.5-0.9 s in the slow-query log):
//   - the window compares runs.created_at as text (ISO), so idx_runs_status serves it: no per-row timestamptz cast;
//   - asks inside ttlMs share one read, asks at once share one read in flight, and a later ask reads again;
//   - a read that failed is not kept.
//   node test/exchange-observed-shared-read.test.js
const assert = require('assert');
const { createObserved } = require('../server/exchange/observed');

let now = Date.parse('2026-11-20T09:00:00.000Z');
const clock = { now: () => now };
const sqls = [];
let calls = 0, fail = false, release = null;
const db = {
    prepare(sql) {
        sqls.push(sql);
        return { all: async () => { calls++; if (release) await release; if (fail) throw new Error('db away'); return []; } };
    },
};

(async () => {
    const seen = createObserved({ db, clock, ttlMs: 60_000 });
    for (const sql of sqls) {
        if (!/created_at/.test(sql)) continue;
        assert.ok(!/created_at::timestamptz\s*>=/.test(sql), 'no per-row cast in the window');
        assert.match(sql, /r\.created_at >= \? AND r\.created_at <= \?/, 'the window compares as text');
    }
    const perRead = 5;   // attempts, cached, latencies, tokens, the last day's attempts

    let open; release = new Promise((ok) => { open = ok; });
    const both = Promise.all([seen.read({ days: 7 }), seen.read({ days: 7 })]);
    open(); release = null;
    const [a, b] = await both;
    assert.strictEqual(a, b, 'asks at once share one read');
    assert.strictEqual(calls, perRead);
    await seen.read({ days: 7 });
    assert.strictEqual(calls, perRead, 'inside the ttl: no read');
    await seen.read({ days: 30 });
    assert.strictEqual(calls, perRead * 2, 'another window is its own read');

    now += 61_000;
    await seen.read({ days: 7 });
    assert.strictEqual(calls, perRead * 3, 'past the ttl: read again');

    now += 61_000; fail = true;
    await assert.rejects(seen.read({ days: 7 }));
    fail = false;
    await seen.read({ days: 7 });
    assert.strictEqual(calls, perRead * 5, 'a failed read is not kept');
    console.log('exchange observed: a window is read as text, once, and shared');
})().catch((e) => { console.error(e); process.exit(1); });
