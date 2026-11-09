'use strict';
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const { createKeys } = require('../server/platform/keys');
const { createSearch } = require('../server/search');
const { decide, adapter } = require('../server/platform/supply');
(async () => {
    const h = await boot();
    try {
        const keys = createKeys({ db: h.db });
        const made = await keys.create('alice', {
            name: 'test',
            monthly_cap_usd: 10,
            allowed_models: ['model'],
        });
        assert.ok(made.secret.startsWith('ovx_'));
        assert.equal(
            JSON.stringify(await keys.list('alice')).includes(made.secret),
            false,
        );
        assert.equal((await keys.list('bob')).length, 0);
        const key = await keys.resolve(made.secret);
        assert.ok(key);
        const publicModels = await fetch(h.base + '/v1/models', { headers: { authorization: 'Bearer ' + made.secret } });
        assert.equal(publicModels.status, 200);
        const manage = await fetch(h.base + '/api/v1/exchange/keys', { headers: { authorization: 'Bearer ' + made.secret } });
        assert.equal(manage.status, 403);

        await assert.rejects(
            keys.reserve(key, 'other'),
            (e) => e.status === 403,
        );
        const holds = await Promise.allSettled([
            keys.reserve(key, 'model'),
            keys.reserve(key, 'model'),
        ]);
        assert.equal(holds.filter((x) => x.status === 'fulfilled').length, 1);
        await holds
            .find((x) => x.status === 'fulfilled')
            .value.settle({ cost_usd: 2, tokens_in: 5, tokens_out: 6 });
        const next = await keys.reserve(key, 'model');
        assert.equal(next.amount, 8);
        await next.settle({ cost_usd: 8 });
        await assert.rejects(
            keys.reserve(key, 'model'),
            (e) => e.status === 429,
        );
        await assert.rejects(
            keys.revoke('bob', key.id),
            (e) => e.status === 404,
        );
        await keys.revoke('alice', key.id);
        assert.equal(await keys.resolve(made.secret), undefined);
        const search = createSearch({
            fetchImpl: async (url) =>
                new Response(
                    JSON.stringify({
                        results: [
                            {
                                title: 'Example',
                                url: 'https://example.org/a.jpg',
                                license: 'cc0',
                                creator: 'A',
                                foreign_landing_url: 'https://example.org',
                                attribution: 'A CC0',
                            },
                            { title: 'bad', url: 'javascript:alert(1)' },
                        ],
                    }),
                    { status: 200 },
                ),
        });
        const results = await search.search('images', {
            q: 'cat',
            engine: 'openverse',
            commercial: true,
        });
        assert.equal(results.results.length, 1);
        assert.equal(results.receipt.cost_usd, 0);
        assert.equal(results.results[0].attribution, 'A CC0');
        await assert.rejects(
            search.search('web', { q: 'x', engine: 'searxng' }),
            (e) => e.status === 503,
        );
        await assert.rejects(
            search.read('http://localhost'),
            (e) => e.status === 422,
        );
        const settings = {
            model: 'm',
            required_vram_mb: 24000,
            input_per_million: 1,
            output_per_million: 2,
            hourly_ceiling_usd: 1,
            monthly_ceiling_usd: 1000,
            runtime: 'vllm',
            idle_minutes: 10,
        };
        const d = decide({
            settings,
            demand: { tokens_in: 1e6, tokens_out: 1e6, reseller_cost_usd: 30 },
            quotes: [
                {
                    hourly_usd: 0.5,
                    measured_tokens_per_second: 50,
                    vram_mb: 24000,
                    observed_at: new Date().toISOString(),
                },
            ],
        });
        assert.equal(d.action, 'would_rent');
        assert.equal(d.dry_run, true);
        assert.equal(
            decide({ settings, demand: {}, quotes: [] }).action,
            'would_stop',
        );
        for (const p of ['vast', 'runpod']) {
            await assert.rejects(
                adapter(p).rent(),
                (e) => e.code === 'gpu.owner_gate',
            );
            await assert.rejects(
                adapter(p, {
                    key: 'test',
                    hourlyCeiling: 1,
                    monthlyCeiling: 1,
                }).stop(),
                (e) => e.code === 'gpu.dry_run',
            );
        }
        const { createSupply } = require('../server/platform/supply');
        const { recordGpuQuotes } = require('../server/pricebook/gpus');
        const supply = createSupply({db:h.db,registry:h.registry});
        await supply.save(settings,'owner');
        await recordGpuQuotes(h.db,JSON.stringify([{provider:'vast',gpu:'RTX 4090',region:'US',hourly_usd:.5,vram_mb:24000,source:'https://vast.ai',observed_at:new Date().toISOString()}]));
        const report=await supply.report();
        assert.equal(report.dry_run,true);
        assert.equal(report.price_book.length,1);
        assert.equal(report.reports[0].action,'would_stop');
        await assert.rejects(createSearch().read('https://127.0.0.1'),/IP-literal/);
        console.log(
            'Exchange key isolation, concurrent caps, revocation, search normalization and dry-run gates passed',
        );
    } finally {
        await h.stop();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
