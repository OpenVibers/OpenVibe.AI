'use strict';
// The Rundown's desk writes in the background (Live's server/rundown/desk.js, nobody waiting): its three workflows get
// the background routes' 180 s. At 60 s and 30 s a quarter of them were cut off on gpt-5-mini (2026-11-15: 75 a day,
// about a minute each, paid and thrown away).
const assert = require('assert');
const { workflows } = require('../server/workflows/live');

for (const key of ['live.rundown.segment', 'live.rundown.episode', 'live.rundown.topic']) {
    const wf = workflows.find((w) => w.key === key);
    assert.ok(wf, `${key} is defined`);
    assert.strictEqual(wf.steps[0].params.timeout_ms, 180000, `${key}: 180 s`);
}
console.log('rundown-timeouts: segment, episode and topic get 180 s');
