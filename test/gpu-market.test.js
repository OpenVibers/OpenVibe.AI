'use strict';
// The public GPU marketplace price reader: saved provider pages, the cache that survives a failed source, and
// the per-token cost implied by the catalog's throughput next to the cheapest comparable API price. No test
// reaches the internet: every source is a saved page from test/fixtures/gpu-market/.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, token, suite } = require('./helpers');
const { testDb } = require('./db');
const marketLib = require('../server/gpu/market');
const { tokenCosts, cheapestComparable } = require('../server/gpu/token-cost');
const catalog = require('../server/gpu/catalog');

const FIXTURES = path.join(__dirname, 'fixtures', 'gpu-market');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** The saved pages, behind the same fetch seam the service uses. Vast is called twice (on demand, then bid). */
function fixtureFetch({ fail = null } = {}) {
    let vastCalls = 0;
    return async (url) => {
        if (fail && String(url).includes(fail)) throw new Error('saved source is down');
        let name;
        if (String(url).includes('vast.ai')) name = vastCalls++ === 0 ? 'vast-ondemand.json' : 'vast-bid.json';
        else if (String(url).includes('runpod.io')) name = 'runpod-pricing.html';
        else if (String(url).includes('salad.com')) name = 'salad-pricing.html';
        else if (String(url).includes('tensordock.com')) name = 'tensordock-pricing.html';
        else if (String(url).includes('cloudrift.ai')) name = 'cloudrift-pricing.html';
        else if (String(url).includes('verda.ai')) name = 'verda-pricing.html';
        else if (String(url).includes('thundercompute.com')) name = 'thunder-pricing.html';
        else if (String(url).includes('shadeform.ai')) name = 'shadeform-pricing.html';
        else throw new Error(`no saved fixture for ${url}`);
        const text = fixture(name);
        return { ok: true, status: 200, text: async () => text };
    };
}

const t = suite('gpu-market');
let h;
let db;
let now = Date.parse('2026-11-09T20:00:00Z');
let market;
let goodReport;

t.test('the saved provider pages parse into the same reading shape', async () => {
    const onDemand = marketLib.parseVast(fixture('vast-ondemand.json'), 'on_demand');
    const bid = marketLib.parseVast(fixture('vast-bid.json'), 'spot');
    assert.ok(onDemand.length > 0 && bid.length > 0);
    assert.equal(marketLib.targetFor('A100 PCIE', 40960), null, 'a 40 GB A100 is not the 80 GB row');
    assert.equal(marketLib.targetFor('A100 SXM4', 81920).gpu, 'A100 80GB');
    const lowest = (rows, key, kind) => marketLib.lowest(rows).filter((r) => r.gpu_key === key && r.kind === kind)
        .sort((a, b) => a.hourly_usd - b.hourly_usd)[0];
    const vast4090 = lowest(onDemand, 'rtx-4090', 'on_demand');
    assert.equal(vast4090.hourly_usd, 0.13590148148148148);
    assert.equal(vast4090.region, 'Texas, US');
    assert.ok(vast4090.reliability > 0 && vast4090.reliability <= 1);
    assert.match(vast4090.note, /storage/);
    assert.equal(lowest(bid, 'rtx-4090', 'spot').hourly_usd, 0.1466667);
    const offer = { num_gpus: 1, gpu_name: 'RTX 4090', gpu_ram: 24576, dph_total: 1 };
    for (const reliability of [null, undefined, '']) {
        assert.strictEqual(marketLib.parseVast({ offers: [{ ...offer, reliability }] }, 'on_demand')[0].reliability, null);
    }
    assert.strictEqual(marketLib.parseVast({ offers: [{ ...offer, reliability: 0 }] }, 'on_demand')[0].reliability, 0);

    const runpod = marketLib.lowest(marketLib.parseRunpod(fixture('runpod-pricing.html')));
    assert.equal(runpod.find((r) => r.gpu_key === 'h100' && r.kind === 'on_demand').hourly_usd, 1.99);
    assert.ok(runpod.every((r) => r.kind === 'on_demand'), 'Community Cloud is not a spot quote');
    assert.equal(runpod.find((r) => r.gpu_key === 'rtx-4090' && r.kind === 'on_demand').hourly_usd, 0.34);

    const salad = marketLib.lowest(marketLib.parseSalad(fixture('salad-pricing.html')));
    assert.equal(salad.find((r) => r.gpu_key === 'rtx-4090' && r.kind === 'on_demand').hourly_usd, 0.44);
    assert.equal(salad.find((r) => r.gpu_key === 'rtx-4090' && r.kind === 'spot').hourly_usd, 0.16);
    assert.match(salad.find((r) => r.gpu_key === 'rtx-4090' && r.kind === 'spot').note, /interruptible/);

    const tensordock = marketLib.parseTensordock(fixture('tensordock-pricing.html'));
    assert.equal(tensordock.find((r) => r.gpu_key === 'h100').hourly_usd, 2.25);
    assert.equal(tensordock.find((r) => r.gpu_key === 'a100-80gb').hourly_usd, 1.8);
    assert.equal(tensordock.some((r) => r.kind === 'spot'), false, 'TensorDock publishes no spot floor on its public page');

    const cloudrift = marketLib.parseCloudrift(fixture('cloudrift-pricing.html'));
    assert.equal(cloudrift.find((r) => r.gpu_key === 'rtx-4090').hourly_usd, 0.45);
    assert.equal(cloudrift.find((r) => r.gpu_key === 'rtx-5090').hourly_usd, 0.65);
    assert.equal(cloudrift.some((r) => r.gpu_key === 'h100'), false, 'CloudRift quotes H100 on demand on request');

    const verda = marketLib.parseVerda(fixture('verda-pricing.html'));
    assert.equal(verda.find((r) => r.gpu_key === 'h100' && r.kind === 'on_demand').hourly_usd, 3.17);
    assert.equal(verda.find((r) => r.gpu_key === 'h100' && r.kind === 'spot').hourly_usd, 1.29);
    assert.equal(verda.find((r) => r.gpu_key === 'a100-80gb' && r.kind === 'spot').hourly_usd, 0.89);
    const thunder = marketLib.parseThunder(fixture('thunder-pricing.html'));
    assert.equal(thunder.find((r) => r.gpu_key === 'h100').hourly_usd, 3.2);
    assert.equal(thunder.find((r) => r.gpu_key === 'a100-80gb').hourly_usd, 1.09);
    assert.match(thunder[0].note, /per minute/);
    const serverless = marketLib.parseRunpodServerless(fixture('runpod-pricing.html'));
    assert.equal(serverless.find((r) => r.gpu_key === 'rtx-4090').hourly_usd, 1.1);
    assert.equal(serverless.find((r) => r.gpu_key === 'h100').hourly_usd, 4.79);
    assert.match(serverless[0].note, /scale|zero|per second/i);
    const shadeform = marketLib.parseShadeform(fixture('shadeform-pricing.html'));
    assert.equal(shadeform.find((r) => r.gpu_key === 'h100').hourly_usd, 1.99);
    assert.equal(shadeform.find((r) => r.gpu_key === 'a100-80gb').hourly_usd, 1.1);
    assert.match(shadeform[0].note, /no fee/);
});

t.test('the cache keeps the lowest reading per provider, card and kind', async () => {
    db = await testDb();
    market = marketLib.createGpuMarket({ db: db.db, config: { gpuMarket: { enabled: false } }, clock: { now: () => now } });
    const out = await market.refresh({ fetchImpl: fixtureFetch() });
    assert.equal(out.refreshed, 9);
    assert.equal(out.failed, 0);
    goodReport = await market.report();
    assert.equal(goodReport.sources.length, 9);
    assert.ok(goodReport.sources.every((s) => s.status === 'ok' && s.stale === false));
    const g = (key) => goodReport.gpus.find((x) => x.key === key);
    assert.equal(g('rtx-4090').on_demand.provider, 'vast');
    assert.equal(g('rtx-4090').on_demand.hourly_usd, 0.13590148148148148);
    assert.equal(g('rtx-4090').spot.hourly_usd, 0.1466667);
    assert.equal(g('h100').on_demand.provider, 'runpod');
    assert.equal(g('h100').spot.provider, 'vast');
    assert.equal(g('h100').spot.hourly_usd, 0.6666666666666666);
    assert.ok(g('h200').on_demand);
    assert.strictEqual(g('h200').spot, null, 'the source has no H200 spot quote');
    assert.equal(await market.due(), false, 'a fresh read is not due again');
    now += 7 * 60 * 60 * 1000;
    assert.equal(await market.due(), true, 'the six-hour interval makes the next read due');
    now -= 7 * 60 * 60 * 1000;
});

t.test('a source that fails keeps its last reading, marked stale', async () => {
    const before = goodReport.gpus.find((x) => x.key === 'h200').on_demand;
    const okAt = goodReport.sources.find((s) => s.provider === 'runpod').ok_at;
    now += 10 * 60 * 1000;
    const out = await market.refresh({ fetchImpl: fixtureFetch({ fail: 'runpod.io' }) });
    assert.equal(out.failed, 2);
    assert.equal(out.refreshed, 7);
    const report = await market.report();
    const runpod = report.sources.find((s) => s.provider === 'runpod');
    assert.equal(runpod.status, 'failed');
    assert.equal(runpod.stale, true);
    assert.equal(runpod.ok_at, okAt);
    assert.match(runpod.error, /saved source is down/);
    const h200 = report.gpus.find((x) => x.key === 'h200');
    assert.equal(h200.on_demand.provider, before.provider);
    assert.equal(h200.on_demand.hourly_usd, before.hourly_usd);
    assert.equal(h200.on_demand.stale, true);
    assert.ok(h200.readings.length > 0, 'the last rows were not deleted');
    const stale = structuredClone(goodReport);
    for (const gpu of stale.gpus) for (const reading of gpu.readings) reading.stale = true;
    assert.ok(tokenCosts({ market: stale, catalog }).every((row) => !row.is_cheapest), 'stale readings cannot claim the fresh price floor');
});

t.test('the implied per-token cost uses the catalog throughput and the cheapest comparable API', async () => {
    const models = [
        { provider_key: 'deepseek', model_key: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', family: 'deepseek', uncensored: false, cost: { in_per_mtok: 0.037, out_per_mtok: 0.17 } },
        { provider_key: 'refuseless', model_key: 'deepseek-v4.1-flash-abliterated', display_name: 'DeepSeek V4.1 Flash (abliterated)', family: 'deepseek', uncensored: true, cost: { in_per_mtok: null, out_per_mtok: 0.5 } },
        { provider_key: 'openai', model_key: 'gpt-5-nano', display_name: 'GPT-5 nano', family: 'gpt', uncensored: false, cost: { in_per_mtok: 0.05, out_per_mtok: 0.4 } },
    ];
    // RunPod is stale from the previous test; the 3090 and 4090 rows are Vast and fresh.
    const rows = tokenCosts({ market: goodReport, models, catalog });
    assert.equal(rows.length, 24, 'both models, both fitting cards, both kinds and every provider reading');
    const row = (key, gpu, kind, provider) => rows.find((r) => r.model_key === key && r.gpu === gpu && r.kind === kind && r.provider === provider);
    const p = row('deepseek-r1-32b', 'RTX 4090', 'on_demand', 'vast');
    assert.equal(p.is_cheapest, true);
    assert.ok(row('deepseek-r1-32b', 'RTX 4090', 'on_demand', 'salad'), 'the Salad 4090 hour is beside Vast');
    assert.equal(row('deepseek-r1-32b', 'RTX 4090', 'on_demand', 'cloudrift').hourly_usd, 0.45);
    assert.equal(row('deepseek-r1-32b', 'RTX 4090', 'on_demand', 'cloudrift').is_cheapest, false);
    assert.equal(p.hourly_usd, 0.13590148148148148);
    assert.equal(p.throughput_tokens_per_hour, 180000);
    assert.match(p.throughput_source, /catalog planning estimate/);
    assert.equal(p.usd_per_million_tokens, 0.755008);
    assert.equal(p.cheapest_api.model_key, 'deepseek-v4-flash');
    assert.equal(p.cheapest_api.match, 'same_family_weights');
    const a = row('deepseek-r1-32b-abliterated', 'RTX 4090', 'on_demand', 'vast');
    assert.equal(a.cheapest_api.model_key, 'deepseek-v4.1-flash-abliterated', 'the abliterated comparison prefers the same weights');
    assert.equal(a.cheapest_api.match, 'same_family_weights');
    assert.equal(cheapestComparable({ key: 'a', family: 'none', uncensored: false }, models), null);
});

t.test('the admin API exposes both to the GPUs and supply console sections', async () => {
    h = await boot();
    await h.gpuMarket.refresh({ fetchImpl: fixtureFetch() });
    const read = token('console', ['ai.usage.read']);
    const gpus = await request(h.base, 'GET', '/api/v1/admin/console/gpus', { tok: read });
    assert.equal(gpus.status, 200, gpus.text);
    assert.equal(gpus.body.market.sources.length, 9);
    assert.equal(gpus.body.token_costs.length, 24);
    assert.ok(gpus.body.state && Array.isArray(gpus.body.state.models));
    const supply = await request(h.base, 'GET', '/api/v1/admin/console/supply', { tok: read });
    assert.equal(supply.status, 200, supply.text);
    assert.equal(supply.body.dry_run, true);
    assert.equal(supply.body.market.read_at, gpus.body.market.read_at);
    assert.equal(supply.body.token_costs.length, 24);
});

t.test('close', async () => {
    if (h) await h.stop();
    if (db) await db.close();
    process.stdout.write('gpu-market: saved pages, stale cache, implied token costs and both admin sections passed\n');
});

t.run();
