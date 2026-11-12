'use strict';
/** The batch lane's route receipt: deadline, cheapest route, off-peak waiting. Pure functions. */
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../server/batch/providers');
const { meetsDeadline, totalCost, routeReason } = require('../server/batch/capacity');
const { nextWindowAt } = require('../server/pricebook/offpeak');

const now = Date.parse('2026-11-11T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Together's own batch API is a half-price, 24-hour route, off until a provider key is configured.
assert.equal(PROVIDERS.together.discount, 0.5);
assert.equal(PROVIDERS.together.window, '24h');
assert.equal(PROVIDERS.together.enabled, false);
assert.equal(PROVIDERS.together.when_configured, true);

// A 24-hour provider window cannot meet a one-hour deadline; it can meet tomorrow's.
assert.equal(meetsDeadline({ window_hours: 24 }, iso(now + 3600_000), now), false);
assert.equal(meetsDeadline({ window_hours: 24 }, iso(now + 25 * 3600_000), now), true);
assert.equal(meetsDeadline({ source: 'own' }, iso(now + 1000), now), true);

// Cheapest is the whole route: input plus output, not input alone.
assert.equal(totalCost({ cost: { input: '3', output: '5' } }), 8n);
assert.ok(totalCost({ cost: { input: '1', output: '20' } }) > totalCost({ cost: { input: '5', output: '5' } }));
assert.match(routeReason({ source: 'native-batch', provider: 'together', batch_discount: 0.5, window: '24h' }), /together.*50%.*24h/i);
assert.match(routeReason({ source: 'discount-window', provider: 'deepseek', window: { start_hour: 16, end_hour: 0 } }), /off-peak.*16:00-0:00 UTC/);

// The next off-peak moment is read from the window, never from a hardcoded DeepSeek hour.
const at = Date.parse('2026-11-11T20:00:00Z'); // a Wednesday, 20:00 UTC
const next = nextWindowAt({ start_hour: 16, end_hour: 0, weekdays: [1, 2, 3, 4, 5] }, at);
assert.equal(next, '2026-11-11T20:00:00.000Z', 'inside the 16:00-00:00 weekday window now');
const weekend = nextWindowAt({ start_hour: 16, end_hour: 0, weekdays: [1, 2, 3, 4, 5] }, Date.parse('2026-11-14T12:00:00Z'));
assert.equal(weekend, '2026-11-16T16:00:00.000Z', 'a Saturday waits for Monday 16:00 UTC');
assert.equal(nextWindowAt({ start_hour: 4, end_hour: 4 }), null, 'an empty window has no next moment');

console.log('Batch route receipt: Together half-price, deadline windows, cheapest total, next off-peak window: passed');
