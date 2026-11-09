'use strict';
const assert = require('node:assert/strict');
const {
    normalize,
    policyFor,
    select,
} = require('../server/exchange/compat-routing');
(async () => {
    assert.throws(() => normalize({ unrecognized: true }), /Unsupported/);
    assert.throws(() => normalize({ allow_fallbacks: 'false' }), /boolean/);
    assert.throws(
        () => normalize({ max_price: { prompt: -1 } }),
        /nonnegative/,
    );
    assert.deepEqual(
        policyFor({ model: 'maker/model:free' }).policy.max_price,
        { prompt: 0, completion: 0 },
    );
    const list = [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
        { provider: 'c', model: 'm' },
    ];
    const facts = async (c) =>
        ({
            a: { priceIn: null, priceOut: null },
            b: {
                priceIn: 1,
                priceOut: 2,
                training: false,
                retention: 'none',
                quality: 80,
            },
            c: {
                priceIn: 2,
                priceOut: 4,
                training: true,
                retention: 'standard',
                quality: 90,
            },
        })[c.provider];
    assert.deepEqual(
        (
            await select(
                list,
                normalize({
                    max_price: { prompt: 1 },
                    data_collection: 'deny',
                    zdr: true,
                }),
                facts,
            )
        ).allowed,
        [list[1]],
    );
    assert.deepEqual(
        (
            await select(
                list,
                normalize({
                    only: ['b', 'c'],
                    order: ['c'],
                    allow_fallbacks: false,
                }),
                facts,
            )
        ).allowed,
        [list[2]],
    );
    assert.deepEqual(
        (await select(list, normalize({ sort: 'value' }), facts)).allowed,
        [list[1], list[2]],
    );
    assert.equal(
        (await select(list, normalize({ sort: 'quality' }), async () => ({})))
            .allowed.length,
        0,
    );
    console.log(
        'Strict routing fields, missing prices, privacy, provider order and evidence requirements passed',
    );
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
const { importPreset } = require('../server/exchange/import-preset');
assert.equal(
    importPreset({
        name: 'writer',
        model: 'maker/model',
        provider: { only: ['a'] },
    }).valid,
    true,
);
assert.throws(
    () =>
        importPreset({ name: 'writer', model: 'm', api_key: 'not-a-real-key' }),
    /unsupported/,
);
assert.throws(
    () => importPreset({ name: 'writer', model: '@preset/recursive' }),
    /Nested/,
);
const sensitive = 'private-content-do-not-reflect';
const summary = importPreset({ name: sensitive, model: sensitive, system: sensitive, provider: { only: [sensitive] }, response_format: { [sensitive]: sensitive } });
assert.equal(JSON.stringify(summary).includes(sensitive), false, 'validated values are never returned');
assert.throws(() => normalize({ [sensitive]: sensitive }), (e) => !e.message.includes(sensitive));
