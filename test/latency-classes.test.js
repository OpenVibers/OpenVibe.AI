'use strict';
/**
 * BA1: the latency classes and the tiers a background run waits for.
 *
 *   interactive  the default: the answer as soon as the provider can give it.
 *   background   the answer may take minutes: the router asks for the cheapest tier that can wait (a Flex
 *                tier, a provider's off-peak hours, the host's own idle model) and the run is priced on the
 *                tier it really ran on.
 *   batch        the answer may take hours (BA2 answers it through a provider's own batch API).
 *
 * What these tests hold:
 *
 *   - a Flex tier is sent, and the run is priced at the Flex price, when the provider says it served one;
 *   - a Flex tier the provider refuses (429 with no capacity, 400 for a model that does not serve it) sends
 *     the SAME run again on the standard tier, once, and the run is billed once, at the standard price;
 *   - a caller may ask for a slower class and never for a faster one;
 *   - DeepSeek's off-peak rule is read by weekday and by hour (peak 01:00-04:00 and 06:00-10:00 UTC, Monday
 *     to Friday; every other hour off-peak, weekends in full), and the old single-window rows are still read;
 *   - the workflows that wait in the background are the ones the plan names.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, suite, seamServer, silent, token, ALL } = require('./helpers');
const { testDb } = require('./db');
const latency = require('../server/latency');
const tiers = require('../server/providers/tiers');
const rates = require('../server/providers/rate-cards');
const parsers = require('../server/pricebook/parsers');
const { createOffPeak } = require('../server/pricebook/offpeak');
const { createPriceBook } = require('../server/pricebook/job');
const { SOURCES } = require('../server/pricebook/sources');
const { providerRecords } = require('../server/workflows/seed');
const { load } = require('../server/config');
const { PROVIDERS } = require('../server/providers/pool-providers');

const t = suite('latency-classes');
const FIXTURES = path.join(__dirname, 'fixtures', 'pricebook');

// ── The classes ────────────────────────────────────────────────────────────────

t.test('the class order: a caller may ask for a slower class and never for a faster one', () => {
    assert.deepStrictEqual(latency.CLASSES, ['interactive', 'background', 'batch']);
    assert.strictEqual(latency.ofRoute({ constraints: { latency_class: 'background' } }), 'background');
    assert.strictEqual(latency.ofRoute({ constraints: {} }), 'interactive', 'a route that says nothing is interactive');
    assert.strictEqual(latency.ofRoute(null), 'interactive');

    assert.deepStrictEqual(latency.resolve('interactive', null), { class: 'interactive' }, 'no question, the workflow\'s own class');
    assert.deepStrictEqual(latency.resolve('background', 'batch'), { class: 'batch' }, 'a caller may ask for a slower class');
    assert.deepStrictEqual(latency.resolve('interactive', 'background'), { class: 'background' });
    assert.ok(latency.resolve('background', 'interactive').error, 'a background workflow cannot be made interactive');
    assert.ok(latency.resolve('background', 'interactive').error.includes('background'), 'the refusal names the class it is');
    assert.ok(latency.resolve('interactive', 'nonsense').error, 'a class nobody knows is refused');
    assert.strictEqual(latency.timeoutMs('background') > latency.timeoutMs('interactive'), true, 'a background run gets more room');
});

t.test('a Flex tier is refused only when the provider says so', () => {
    const refusal = (status, body) => ({ status, body, message: (body && body.error && body.error.message) || '' });
    assert.ok(tiers.isTierRefusal(refusal(429, { error: { code: 'resource_unavailable', message: 'The flex tier has no capacity right now' } }), 'flex'),
        'a 429 with no capacity is a refusal of the tier');
    assert.ok(tiers.isTierRefusal(refusal(400, { error: { message: 'The model gpt-4o-mini does not support service_tier flex' } }), 'flex'),
        'a 400 that names the tier is a refusal of the tier');
    assert.ok(!tiers.isTierRefusal(refusal(500, { error: { message: 'the server is on fire' } }), 'flex'), 'a plain failure is not a refusal of the tier');
    assert.ok(!tiers.isTierRefusal(refusal(400, { error: { message: 'the prompt is too long' } }), 'flex'), 'a bad request is the caller\'s, not the tier\'s');
    // The tier a run is priced on is the one the answer names. A provider that says nothing is priced at the list price.
    assert.strictEqual(tiers.tierOfAnswer({ serviceTier: 'flex' }, 'flex'), 'flex');
    assert.strictEqual(tiers.tierOfAnswer({ serviceTier: 'default' }, 'flex'), 'standard');
    assert.strictEqual(tiers.tierOfAnswer({}, 'flex'), 'standard', 'a provider that does not say is priced at the list price');
    assert.strictEqual(tiers.tierOfAnswer({}, 'standard'), 'standard');
});

t.test('a tier is the list price times the multiplier the provider publishes', () => {
    const cards = rates.buildCards({ providerKey: 'p', model: 'm', row: { cost: { in_per_mtok: 2, out_per_mtok: 4 } }, pricing: {} });
    assert.strictEqual(rates.costOfUsage(cards, { input: 1000, output: 1000 }), 0.006);
    const flex = rates.cardsForTier(cards, { multiplier: 0.5, tier: 'flex' });
    assert.strictEqual(rates.costOfUsage(flex, { input: 1000, output: 1000 }), 0.003, 'half the list price');
    assert.strictEqual(flex.in.version, 'list:flex', 'the card says which tier priced it');
    assert.strictEqual(rates.costOfUsage(rates.cardsForTier(cards, { multiplier: null, tier: 'flex' }), { input: 1000, output: 1000 }), 0.006,
        'a tier nobody published a multiplier for keeps the list price');
});

t.test('the providers publish the tier prices they were read from', () => {
    // OpenAI's own prices: a Flex tier and a batch at half the standard price (read 2026-11-07).
    const config = load({ AI_PROVIDER: 'openai', AI_BASE_URL: 'https://api.openai.com/v1', AI_MODEL: 'gpt-4o-mini' });
    const openai = providerRecords(config, {}).find((r) => r.key === 'shared');
    assert.deepStrictEqual(openai.metadata.tier_rates, { flex: 0.5, batch: 0.5 });
    // DeepInfra: a Flex tier and a batch at 0.8x. DashScope: a batch at half. Moonshot: a batch at 0.6x.
    const by = (key) => PROVIDERS.find((p) => p.key === key);
    assert.deepStrictEqual(by('deepinfra').tier_rates, { flex: 0.8, batch: 0.8 });
    assert.deepStrictEqual(by('qwen').tier_rates, { batch: 0.5 });
    assert.deepStrictEqual(by('kimi').tier_rates, { batch: 0.6 });
    // A provider that publishes no tier price has none: the network never claims a saving it cannot price.
    assert.strictEqual(by('openrouter').tier_rates, undefined);
    assert.strictEqual(tiers.multiplierOf({ metadata: {} }, 'flex'), null);
});

// ── The Flex tier, end to end ─────────────────────────────────────────────────

const ENV = { AI_STUB_FALLBACK: 'false', AI_PROVIDER: 'openai', AI_MODEL: 'gpt-4o-mini', AI_PROVIDER_RETRIES: '0' };
const answer = (text = 'an answer') => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } });
/** A provider that says which tier it served, and only when it served one. */
const echoes = (body) => (body.service_tier ? { ...answer(), service_tier: body.service_tier } : answer());

/** The shared provider with OpenAI's own tier prices on it (the seeded record carries them on api.openai.com). */
async function withFlex(h) {
    const shared = await h.registry.getProvider('shared');
    await h.registry.upsertProvider({ key: 'shared', metadata: { ...(shared.metadata || {}), tier_rates: { flex: 0.5, batch: 0.5 } } });
}

t.test('a background run asks for the Flex tier and is priced at the Flex price', async () => {
    const up = await seamServer((body) => { up.last = body; return echoes(body); });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1` } });
    try {
        await withFlex(h);
        const route = await h.registry.resolveRoute('background.text');
        assert.strictEqual(route.constraints.latency_class, 'background');
        const req = { messages: [{ role: 'user', content: 'take your time' }], maxTokens: 50 };
        const out = await h.pool.execute(route, 'chat', req, { routeKey: route.key, latencyClass: 'background' });
        assert.strictEqual(up.last.service_tier, 'flex', 'the tier travels with the request');
        assert.strictEqual(out.serviceTier, 'flex', 'the run is priced on the tier the answer names');
        // The same call on the standard tier, for the price to compare with.
        const plain = await h.pool.execute(await h.registry.resolveRoute('default.chat'), 'chat', req, { routeKey: 'default.chat' });
        assert.strictEqual(plain.serviceTier, 'standard');
        assert.ok(Math.abs(out.cost - plain.cost / 2) < 1e-12, `the flex run costs half the standard one (${out.cost} vs ${plain.cost})`);
        assert.ok(Math.abs(out.savedUsd - plain.cost / 2) < 1e-12, 'the wait earned the difference');
        assert.strictEqual(out.explain.service_tier, 'flex');
    } finally { await h.stop(); await up.close(); }
});

t.test('a Flex tier with no capacity: the same run goes again on the standard tier, billed once', async () => {
    const seen = [];
    const up = await seamServer((body) => {
        seen.push(body.service_tier || null);
        if (body.service_tier === 'flex') return { status: 429, body: { error: { code: 'resource_unavailable', message: 'resource_unavailable: the flex tier has no capacity' } } };
        return echoes(body);
    });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1` } });
    try {
        await withFlex(h);
        const route = await h.registry.resolveRoute('background.text');
        const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'take your time' }], maxTokens: 50 }, { routeKey: route.key, latencyClass: 'background' });
        assert.deepStrictEqual(seen, ['flex', null], 'the tier was asked for once, then the standard tier');
        assert.strictEqual(out.serviceTier, 'standard', 'the run ran on the standard tier');
        const plain = await h.pool.execute(await h.registry.resolveRoute('default.chat'), 'chat', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }, { routeKey: 'default.chat' });
        assert.strictEqual(out.cost, plain.cost, 'the run is billed once, at the standard price');
        assert.strictEqual(out.savedUsd, 0, 'a refused tier earns nothing');
        assert.ok(out.explain.attempts.some((a) => a.status === 'failed' && /flex/.test(String(a.error))), 'the refusal is counted');
    } finally { await h.stop(); await up.close(); }
});

t.test('a model that does not serve the tier falls back to the standard tier', async () => {
    const seen = [];
    const up = await seamServer((body) => {
        seen.push(body.service_tier || null);
        if (body.service_tier === 'flex') return { status: 400, body: { error: { message: 'The model gpt-4o-mini does not support service_tier flex' } } };
        return echoes(body);
    });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1` } });
    try {
        await withFlex(h);
        const route = await h.registry.resolveRoute('background.text');
        const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'take your time' }], maxTokens: 50 }, { routeKey: route.key, latencyClass: 'background' });
        assert.deepStrictEqual(seen, ['flex', null]);
        assert.strictEqual(out.serviceTier, 'standard');
        assert.ok(out.result.text, 'the run answered');
    } finally { await h.stop(); await up.close(); }
});

t.test('the host\'s own idle model answers a background run first, and a route that names a model keeps it', async () => {
    const local = await seamServer(() => answer('from the host'));
    const network = await seamServer(() => answer('from the network'));
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${network.url}/v1`, AI_LOCAL_LLM_URL: `${local.url}/v1`, AI_LOCAL_LLM_MODEL: 'local-model', AI_CREATIVE_MODEL: 'gpt-5-mini' } });
    try {
        const route = await h.registry.resolveRoute('background.text');
        const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'when you have time' }], maxTokens: 50 }, { routeKey: route.key, latencyClass: 'background' });
        assert.strictEqual(out.provider, 'local', 'the host\'s own idle model answers first');
        assert.strictEqual(out.serviceTier, 'local', 'the tier is local: capacity the network already pays for');
        assert.strictEqual(out.cost, 0, 'capacity the network already pays for costs nothing');
        // An interactive run keeps the network's choice: the authority serves it.
        const inter = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'now' }], maxTokens: 50 }, { routeKey: route.key });
        assert.strictEqual(inter.provider, 'shared', 'an interactive run is not moved to the local model');
        // A route that names its model keeps it: a small local model never writes The Rundown.
        const creative = await h.registry.resolveRoute('background.creative');
        assert.strictEqual(creative.constraints.model, 'gpt-5-mini');
        const wrote = await h.pool.execute(creative, 'chat', { messages: [{ role: 'user', content: 'write it' }], maxTokens: 50 }, { routeKey: creative.key, latencyClass: 'background' });
        assert.strictEqual(wrote.provider, 'shared', 'the route names its model, so the network serves it');
    } finally { await h.stop(); await local.close(); await network.close(); }
});

t.test('an interactive run asks for no tier at all', async () => {
    const up = await seamServer((body) => { up.last = body; return echoes(body); });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1` } });
    try {
        await withFlex(h);
        const route = await h.registry.resolveRoute('default.chat');
        const out = await h.pool.execute(route, 'chat', { messages: [{ role: 'user', content: 'now please' }], maxTokens: 50 }, { routeKey: route.key });
        assert.strictEqual(up.last.service_tier, undefined, 'an interactive run never asks for a tier');
        assert.strictEqual(out.serviceTier, 'standard');
        assert.strictEqual(out.savedUsd, 0);
    } finally { await h.stop(); await up.close(); }
});

// ── The class of a run, from the caller's side ─────────────────────────────────

t.test('a caller cannot make a background workflow interactive, and the run records its class and tier', async () => {
    const up = await seamServer((body) => {
        up.last = body;
        return { choices: [{ message: { role: 'assistant', content: '{"title":"Konami","code":["up","down","left","right","a"],"clues":["where the sun rises","where the sky is","where the water falls","the other way","the letter that starts goose"],"effect":"confetti","reward":"well done"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000 }, service_tier: 'flex' };
    });
    const h = await boot({ env: { ...ENV, AI_BASE_URL: `${up.url}/v1` } });
    try {
        await withFlex(h);
        const all = token('all', ALL);
        // A caller may not make the work faster than the workflow's own class.
        const fast = await request(h.base, 'POST', '/api/v1/runs', { tok: all, body: { workflow: 'live.easter_egg', input: {}, options: { latency: 'interactive' } } });
        assert.strictEqual(fast.status, 422, 'a background workflow stays in the background');
        assert.strictEqual(fast.body.code, 'input.invalid');
        // A slower class is allowed.
        const slower = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: all, body: { workflow: 'live.easter_egg', input: {}, options: { latency: 'batch', cache: false } } });
        assert.strictEqual(slower.status, 201, `a slower class is allowed (${slower.text})`);
        assert.strictEqual(slower.body.run.latency_class, 'batch');
        // The plain run is background, on the Flex tier, and says so.
        const run = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: all, body: { workflow: 'live.easter_egg', input: {}, options: { cache: false } } });
        assert.strictEqual(run.status, 201, run.text);
        assert.strictEqual(run.body.run.latency_class, 'background');
        assert.strictEqual(run.body.run.service_tier, 'flex', 'the tier the run really ran on is on the run');
        const read = await request(h.base, 'GET', `/api/v1/runs/${run.body.run.id}`, { tok: all });
        assert.strictEqual(read.body.run.service_tier, 'flex', 'the wire shape carries the tier');
        assert.strictEqual(read.body.run.latency_class, 'background');
        // The gauges say the same: the tier the run ran on, and what waiting earned.
        const metrics = await (await fetch(`${h.base}/metrics`)).text();
        assert.ok(/ai_runs_by_tier\{tier="flex",provider="shared"\} \d+\n/.test(metrics), `the tier is on the metrics:\n${metrics}`);
        const saved = Number((/ai_saved_usd ([0-9.e-]+)/.exec(metrics) || [])[1]);
        assert.ok(saved > 0, `the waiting earned something (${saved})`);
    } finally { await h.stop(); await up.close(); }
});

// ── The off-peak windows ───────────────────────────────────────────────────────

t.test('DeepSeek: peak hours on weekdays, off-peak everywhere else', async () => {
    const page = fs.readFileSync(path.join(FIXTURES, 'deepseek.md'), 'utf8');
    const parsed = parsers.deepseekOffPeakBlocks(page);
    assert.deepStrictEqual(parsed.blocks, [
        { weekdays: [1, 2, 3, 4, 5], start_hour: 0, end_hour: 1 },
        { weekdays: [1, 2, 3, 4, 5], start_hour: 4, end_hour: 6 },
        { weekdays: [1, 2, 3, 4, 5], start_hour: 10, end_hour: 24 },
        { weekdays: [6, 7], start_hour: 0, end_hour: 24 },
    ], 'the off-peak blocks are the hours the page names, and the weekend in full');
    assert.deepStrictEqual(parsed.prices['deepseek-flash'], { in: 0.15, cached: 0.003, out: 0.6 }, 'the off-peak prices of the page');

    const db = await testDb();
    try {
        const off = createOffPeak({ db: db.db });
        for (const [field, price] of [['in_per_mtok', 0.15], ['out_per_mtok', 0.6], ['cached_per_mtok', 0.003]]) {
            for (const block of parsed.blocks) await off.recordBlock({ provider_key: 'deepseek', model_key: 'deepseek-flash', field, price, weekdays: block.weekdays, start_hour: block.start_hour, end_hour: block.end_hour, source: 'https://api-docs.deepseek.com/quick_start/pricing.md', checked_at: '2026-11-07' });
        }
        const MONDAY = '2026-11-09';   // a Monday
        const SATURDAY = '2026-11-14'; // a Saturday
        const at = (day, hour) => `${day}T${String(hour).padStart(2, '0')}:30:00Z`;
        // Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
        assert.strictEqual(await off.priceAt('deepseek', 'deepseek-flash', at(MONDAY, 2)), null, 'Monday 02:00 is peak');
        assert.strictEqual(await off.priceAt('deepseek', 'deepseek-flash', at(MONDAY, 7)), null, 'Monday 07:00 is peak');
        // Off-peak: every other hour of a weekday.
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', at(MONDAY, 0)), 'Monday 00:30 is off-peak');
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', at(MONDAY, 5)), 'Monday 05:30 is off-peak');
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', at(MONDAY, 12)), 'Monday 12:30 is off-peak');
        // The weekend is off-peak in full, peak hours included.
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', at(SATURDAY, 2)), 'Saturday 02:30 is off-peak');
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', at(SATURDAY, 7)), 'Saturday 07:30 is off-peak');
        // The price inside the window is the provider's own off-peak price.
        const price = await off.priceAt('deepseek', 'deepseek-flash', at(MONDAY, 12));
        assert.strictEqual(price.input, 0.15);
        assert.strictEqual(price.output, 0.6);
    } finally { await db.close(); }
});

t.test('the old single-window rows are still read', async () => {
    const db = await testDb();
    try {
        const off = createOffPeak({ db: db.db });
        await off.record({ provider_key: 'deepseek', model_key: 'deepseek-flash', field: 'in_per_mtok', price: 0.15, start_hour: 23, end_hour: 7, source: 'old-window', checked_at: '2026-08-16' });
        await off.record({ provider_key: 'deepseek', model_key: 'deepseek-flash', field: 'out_per_mtok', price: 0.6, start_hour: 23, end_hour: 7, source: 'old-window', checked_at: '2026-08-16' });
        const windows = await off.windows();
        const legacy = windows.find((w) => w.provider_key === 'deepseek' && w.model_key === 'deepseek-flash');
        assert.ok(legacy, 'the old window is among the windows');
        assert.deepStrictEqual(legacy.weekdays, [], 'the old window applies on every day');
        // A window that wraps the midnight still works, and it still ends where it ends.
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', '2026-11-09T23:30:00Z'), '23:30 is inside the old window');
        assert.ok(await off.priceAt('deepseek', 'deepseek-flash', '2026-11-09T03:30:00Z'), '03:30 is inside the old window');
        assert.strictEqual(await off.priceAt('deepseek', 'deepseek-flash', '2026-11-09T12:00:00Z'), null, '12:00 is outside the old window');
    } finally { await db.close(); }
});

t.test('the price book job writes the blocks it read from the listing', async () => {
    const h = await boot({ env: { DEEPSEEK_API_KEY: 'test-deepseek-key' } });
    try {
        const off = createOffPeak({ db: h.db });
        const source = SOURCES.find((s) => s.key === 'deepseek');
        const book = createPriceBook({
            db: h.db, registry: h.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' },
            clock: { now: () => Date.parse('2026-11-13T09:00:00Z') }, log: silent, sources: [source], offPeak: off,
            transport: async () => ({ status: 200, headers: {}, body: fs.readFileSync(path.join(FIXTURES, 'deepseek.md'), 'utf8') }),
        });
        const report = await book.runOnce();
        assert.ok((report.off_peak_blocks || []).length, 'the job wrote the blocks it read');
        const blocks = await off.offPeakBlocks();
        const flash = blocks.find((b) => b.model_key === 'deepseek-flash');
        assert.ok(flash, 'the flash model has its blocks');
        assert.deepStrictEqual(flash.weekdays, [1, 2, 3, 4, 5]);
        assert.strictEqual(flash.input, 0.15, 'the off-peak price of the listing');
        assert.ok(blocks.some((b) => b.model_key === 'deepseek-v4-pro'), 'every model of the listing has its blocks');
    } finally { await h.stop(); }
});

// ── The workflows that wait ────────────────────────────────────────────────────

const BACKGROUND = ['trade.summarize_market_context', 'live.rundown.topic', 'live.rundown.segment', 'live.rundown.episode',
    'live.stream.summarize', 'live.stream.describe_frame', 'live.moments.pick', 'live.moments.rank', 'live.moments.verify',
    'live.streamer.overview', 'live.person.overview', 'live.media.overview', 'live.viewers.plan', 'live.viewers.fold',
    'live.hero.slogans', 'live.home.star', 'live.easter_egg', 'live.paste.describe_image', 'live.paste.summarize_text',
    'blog.draft_post', 'blog.write_digest', 'blog.write_satire', 'news.summarize_story', 'food.suggest_recipes',
    'media.analyze', 'pics.describe_image'];
const INTERACTIVE = ['chat.global', 'chat.member.reply', 'chat.member.turn', 'chat.profile', 'ai.chat', 'ai.complete',
    'ai.generate', 'live.translate', 'live.viewers.reply', 'live.stream.titles', 'live.stream.recap', 'live.clips.confirm',
    'games.generate_lore', 'space.app.ask', 'space.app.build', 'wiki.generate_page', 'news.compare_perspectives'];

t.test('the workflows that wait in the background are the ones the plan names', async () => {
    const h = await boot({ env: { AI_STUB_FALLBACK: 'false' } });
    try {
        const templates = new Map((await h.registry.listTemplates()).map((x) => [x.key, x]));
        const classOf = async (wf) => {
            const llm = (wf.steps || []).find((s) => s.kind === 'llm');
            const tpl = llm ? templates.get(llm.template) : null;
            const key = (wf.steps[0] && wf.steps[0].route) || (tpl && tpl.default_route) || wf.default_route || null;
            if (!key) return { key: null, cls: 'interactive' };
            const route = await h.registry.resolveRoute(key);
            return { key, cls: route ? ((route.constraints || {}).latency_class || 'interactive') : 'interactive' };
        };
        for (const key of BACKGROUND) {
            const wf = await h.registry.activeWorkflow(key);
            assert.ok(wf, `${key} is a workflow`);
            const { key: routeKey, cls } = await classOf(wf);
            assert.strictEqual(cls, 'background', `${key} runs on ${routeKey}, which must be a background route`);
        }
        for (const key of INTERACTIVE) {
            const wf = await h.registry.activeWorkflow(key);
            assert.ok(wf, `${key} is a workflow`);
            const { key: routeKey, cls } = await classOf(wf);
            assert.strictEqual(cls, 'interactive', `${key} runs on ${routeKey}, which must stay interactive`);
        }
        // The modules say the same thing: a template on a background route belongs to a background workflow, and
        // no other template moved.
        const BACKGROUND_ROUTES = ['background.text', 'background.vision', 'background.json', 'background.creative', 'media.local', 'media.paid'];
        for (const mod of [require('../server/workflows/live'), require('../server/workflows/products'), require('../server/workflows/media')]) {
            for (const tpl of mod.templates) {
                const onBackground = BACKGROUND_ROUTES.includes(String(tpl.default_route || ''));
                const users = mod.workflows.filter((w) => (w.steps || []).some((s) => s.template === tpl.key)).map((w) => w.key);
                for (const wfKey of users) {
                    assert.strictEqual(BACKGROUND.includes(wfKey), onBackground,
                        `${wfKey} uses the template ${tpl.key} on ${tpl.default_route}`);
                }
            }
        }
    } finally { await h.stop(); }
});

t.run();
