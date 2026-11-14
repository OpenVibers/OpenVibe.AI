'use strict';
// A refusal by our own content floor is the request's failure, never the key's (11-14: one refused request opened
// DeepSeek Flash's circuit as "auth" for over ten hours, and the console said "the key was refused").
const assert = require('assert');
const { classifyFailure } = require('../server/providers/failure');
const { AiError } = require('../server/util');

// The two shapes the floor throws: the streamed guard's Error and the finished answer's AiError, both 403.
const streamed = Object.assign(new Error('this request breaks the hard floor (weapons of mass harm or attacks on others)'),
    { code: 'policy.floor_refused', status: 403, rule: 'mass_harm' });
const finished = new AiError(403, 'policy.floor_refused', 'this request breaks the hard floor (non-consensual sexual content)', { rule: 'ncsc' });
for (const err of [streamed, finished]) {
    const c = classifyFailure(err);
    assert.strictEqual(c.class, 'request', `a floor refusal is the request's own failure (${err.message})`);
    assert.strictEqual(c.code, 'policy.floor_refused');
}

// A provider's own 401 and 403 still read as auth, and a balance 403 as balance.
assert.strictEqual(classifyFailure(Object.assign(new Error('Incorrect API key provided'), { status: 401 })).class, 'auth');
assert.strictEqual(classifyFailure(Object.assign(new Error('forbidden'), { status: 403 })).class, 'auth');
assert.strictEqual(classifyFailure(Object.assign(new Error('Insufficient Balance'), { status: 402 })).class, 'balance');
console.log('floor-refusal-class.test.js: all assertions passed');
