'use strict';
// network.guest_answer (server/workflows/network-guest.js; plan §V.1 guests): low effort (a reasoning model on medium
// spent its 450 tokens thinking, and the first guest answer took 10 s), the facts a visitor asks about most (the first
// answer in production did not know the browser go-live), on the cheapest interactive route, cached an hour.
//   node test/network-guest-workflow.test.js
const assert = require('assert');
const { workflows, templates, ROUTE, SYSTEM } = require('../server/workflows/network-guest');
const w = workflows[0];
assert.strictEqual(w.key, 'network.guest_answer');
assert.deepStrictEqual(w.metadata, { effort: 'low' });
assert.strictEqual(w.steps[0].params.max_tokens, 450);
assert.deepStrictEqual([w.cache_mode, w.cache_ttl_sec], ['service', 3600]);
assert.deepStrictEqual(ROUTE.settings.constraints, { objective: 'cheapest', latency_class: 'interactive' });
assert.strictEqual(templates[0].system_prompt, SYSTEM);
assert.match(SYSTEM, /go live from the browser on openvibe\.live/);
assert.match(SYSTEM, /no OBS, no download and no follower minimum/);
assert.match(SYSTEM, /https:\/\/openvibe\.live\/docs\/go-live-in-your-browser/);
assert.match(SYSTEM, /three questions a day; a free account asks up to 100 a day/);
console.log('network.guest_answer: low effort, the facts, the cheapest interactive route, an hour of cache');
