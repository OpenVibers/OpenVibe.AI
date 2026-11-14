'use strict';
const assert = require('node:assert/strict');
const { createSearch, CHARGE } = require('../server/search');
const searchContract = require('../server/search/contract');
require('../server/search/adapters/meta');
require('../server/search/adapters/serper-images');
const sample = id => require('./fixtures/search/' + id + '.json').response;
const json = body => new Response(JSON.stringify(body), { status: 200 });
const host = url => new URL(url).hostname;
const order = out => out.receipt.attempts.map(a => [a.provider, a.engine, a.status, a.reason || null]);

(async () => {
    // A circuit-open engine, a provider that refuses, then the answer: every attempt stays in order.
    const search = createSearch({
        env: { SEARCH_DEEPSEEK_KEY: 'deepseek-key', SEARCH_SERPER_KEY: 'serper-key', SEARCH_BRAVE_KEY: 'brave-key' },
        fetchImpl: async (url) => {
            const h = host(url);
            if (h === 'api.deepseek.com') throw Object.assign(new Error('upstream took too long'), { name: 'TimeoutError' });
            if (h === 'google.serper.dev') throw new Error('Search engine refused the request');
            if (h === 'api.search.brave.com') return json(sample('brave'));
            throw new Error('unexpected host ' + h);
        },
    });
    await assert.rejects(search.search('web', { q: 'lantern', freshness: 'day', engine: 'deepseek' }));
    const fallback = await search.search('web', { q: 'lantern', freshness: 'day' });
    assert.equal(fallback.receipt.engine, 'brave');
    assert.deepEqual(order(fallback), [
        ['deepseek', 'deepseek', 'skipped', 'circuit_open'],
        ['serper', 'serper', 'error', 'upstream_error'],
        ['brave', 'brave', 'ok', null],
    ]);
    assert.deepEqual(fallback.receipt.attempts.map(a => a.cost_usd), [0, 0.001, 0.005]);
    assert.equal(fallback.receipt.cost_usd, 0.006);
    assert.equal(fallback[CHARGE], 0.006);
    assert.equal(searchContract.check('web', fallback).valid, true);
    assert.equal(JSON.stringify(fallback).includes('refused the request'), false, 'no upstream error body is kept');

    // A provider that refuses the request is an error attempt; the next provider still answers.
    const refused = createSearch({
        env: { SEARCH_SERPER_KEY: 'serper-key', SEARCH_BRAVE_KEY: 'brave-key' },
        fetchImpl: async (url) => {
            const h = host(url);
            if (h === 'google.serper.dev') throw new Error('Search engine refused the request');
            if (h === 'api.search.brave.com') return json(sample('brave'));
            throw new Error('unexpected host ' + h);
        },
    });
    const afterRefusal = await refused.search('web', { q: 'x', freshness: 'day' });
    assert.deepEqual(order(afterRefusal), [
        ['serper', 'serper', 'error', 'upstream_error'],
        ['brave', 'brave', 'ok', null],
    ]);
    assert.equal(afterRefusal.receipt.cost_usd, 0.006);

    // An owner-disabled provider is a skipped attempt with its reason, both before the plan and between plan and call.
    const serper = { key: 'serper', status: 'active', origin: 'admin', base_url: 'https://google.serper.dev', secret_ref: 'env:SEARCH_SERPER_KEY', metadata: { search_adapters: ['serper', 'serper-images'] } };
    const brave = { key: 'brave', status: 'active', origin: 'catalog', base_url: 'https://api.search.brave.com/res/v1', secret_ref: 'env:SEARCH_BRAVE_KEY', metadata: { search_adapters: ['brave', 'brave-images'] } };
    const registry = { listProviders: async () => [serper, brave], getProvider: async key => key === 'serper' ? serper : key === 'brave' ? brave : null };
    const denied = createSearch({
        env: { SEARCH_SERPER_KEY: 'serper-key', SEARCH_BRAVE_KEY: 'brave-key' }, registry,
        fetchImpl: async (url) => {
            const h = host(url);
            if (h === 'api.search.brave.com') return json(sample('brave'));
            throw new Error('disabled provider was called');
        },
    });
    const plan = await denied.prepare('web', { q: 'x', freshness: 'day' });
    assert.equal(plan.candidates[0].provider, 'serper');
    serper.status = 'disabled';
    const between = await denied.search('web', { q: 'x', freshness: 'day' }, { plan });
    assert.deepEqual(order(between), [
        ['serper', 'serper', 'skipped', 'disabled'],
        ['brave', 'brave', 'ok', null],
    ]);
    const after = await denied.search('web', { q: 'x', freshness: 'day' });
    assert.deepEqual(order(after), [
        ['serper', 'serper', 'skipped', 'disabled'],
        ['brave', 'brave', 'ok', null],
    ]);
    assert.equal((await denied.engines()).find(e => e.id === 'serper').available, false);
    assert.equal((await denied.engines()).find(e => e.id === 'brave').available, true);

    // A provider over the call's spend cap is skipped as budget rather than called.
    const capped = createSearch({ env: { SEARCH_SERPER_KEY: 'serper-key', SEARCH_BRAVE_KEY: 'brave-key' }, fetchImpl: async (url) => {
        const h = host(url);
        if (h === 'google.serper.dev') return json(sample('serper'));
        throw new Error('provider over the cap was called');
    } });
    const cappedPlan = await capped.prepare('web', { q: 'x', freshness: 'day', max_cost_usd: 0.002 });
    const braveCandidate = cappedPlan.candidates.find(c => c.a.id === 'brave');
    const serperCandidate = cappedPlan.candidates.find(c => c.a.id === 'serper');
    assert.equal(braveCandidate.skipReason, 'budget');
    cappedPlan.candidates = [braveCandidate, serperCandidate];
    const capAnswer = await capped.search('web', { q: 'x', freshness: 'day', max_cost_usd: 0.002 }, { plan: cappedPlan });
    assert.deepEqual(order(capAnswer), [
        ['brave', 'brave', 'skipped', 'budget'],
        ['serper', 'serper', 'ok', null],
    ]);

    // Image search writes the same ordered attempts and validates against the image contract.
    const images = createSearch({
        env: { SEARCH_SERPER_KEY: 'serper-key' },
        fetchImpl: async (url) => {
            assert.equal(host(url), 'google.serper.dev');
            return json(sample('serper-images'));
        },
    });
    const imageAnswer = await images.search('images', { q: 'cat', engine: 'serper-images' });
    assert.deepEqual(order(imageAnswer), [['serper', 'serper-images', 'ok', null]]);
    assert.equal(searchContract.check('images', imageAnswer).valid, true);

    // A managed reader may use either of its registered hosts (Jina reads from r.jina.ai).
    const jina = { key: 'jina', status: 'active', origin: 'admin', base_url: 'https://s.jina.ai', secret_ref: 'env:SEARCH_JINA_KEY', metadata: { search_adapters: ['jina'] } };
    const reader = createSearch({
        env: { SEARCH_JINA_KEY: 'jina-key' },
        registry: { listProviders: async () => [jina], getProvider: async () => jina },
        targetGuard: async () => {},
        fetchImpl: async (url) => {
            assert.equal(host(url), 'r.jina.ai');
            return json(require('./fixtures/search/jina-fetch.json'));
        },
    });
    const read = await reader.read({ url: 'https://example.org/article', engine: 'jina' });
    assert.deepEqual(order(read), [['jina', 'jina', 'ok', null]]);

    console.log('search attempts: ordered fallback, refusal, owner denial, spend cap, image and managed reader receipts passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
