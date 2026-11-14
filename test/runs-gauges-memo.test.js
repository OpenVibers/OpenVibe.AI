'use strict';
// The gauges that read the whole runs table answer from a five-minute memo (11-14: SUM(saved_usd) over 1.3 GB every
// 30 s scrape held one of five pooled connections while the service stalled). The first scrape waits for the read;
// within five minutes no read runs; past them the last value answers at once and one read runs behind it.
const assert = require('assert');
const { lastValue, RUNS_GAUGE_MS } = require('../server/observability');

(async () => {
    let clock = 0;
    let reads = 0;
    let value = 1;
    let release = null;
    const read = () => { reads++; return new Promise((ok) => { release = () => ok(value); }); };
    const gauge = lastValue(read, { now: () => clock });

    const first = gauge();
    await new Promise((ok) => setImmediate(ok));
    release();
    assert.strictEqual(await first, 1, 'the first scrape waits for the first read');
    assert.strictEqual(reads, 1);

    clock += RUNS_GAUGE_MS - 1;
    assert.strictEqual(await gauge(), 1);
    assert.strictEqual(reads, 1, 'no read inside five minutes');

    clock += 2;
    value = 2;
    assert.strictEqual(await gauge(), 1, 'past five minutes the last value answers at once');
    assert.strictEqual(reads, 1 + 1, 'and one read runs behind it');
    assert.strictEqual(await gauge(), 1, 'a second scrape meanwhile shares that read');
    assert.strictEqual(reads, 2);
    release();
    await new Promise((ok) => setImmediate(ok));
    assert.strictEqual(await gauge(), 2, 'then the new value');

    // A failed refresh keeps the last value; the next scrape past the window tries again.
    clock += RUNS_GAUGE_MS + 1;
    const failing = lastValue(() => { throw new Error('pool timeout'); }, { now: () => clock });
    await assert.rejects(failing(), /pool timeout/, 'with no value yet, the scrape sees the error');
    console.log('runs-gauges-memo.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
