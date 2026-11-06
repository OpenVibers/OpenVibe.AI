'use strict';
/**
 * The living price book: the parsers, the egress guard, the weekly job and the owner's approval.
 *
 * No test reaches the internet: the providers' own listings are recorded (test/fixtures/pricebook/, written by
 * scripts/record-price-book.js) and replayed through the transport seam. Two of them are played back with one
 * price moved, so the two paths a price change can take are both seen: a small change the job applies at once and
 * a big one that waits for the owner.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, suite, silent } = require('./helpers');
const parsers = require('../server/pricebook/parsers');
const { readListing } = require('../server/pricebook/read');
const { createPriceBook } = require('../server/pricebook/job');
const { SOURCES } = require('../server/pricebook/sources');

const FIXTURES = path.join(__dirname, 'fixtures', 'pricebook');
const FILE = {
    deepseek: 'deepseek.md', qwen: 'qwen.html', kimi: 'kimi.html', glm: 'glm.md', minimax: 'minimax.md',
    deepinfra: 'deepinfra.json', novita: 'novita.json', featherless: 'featherless.json',
    refuseless: 'refuseless.md', abliteration: 'abliteration.md', openrouter: 'openrouter.json',
};
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const json = (name) => JSON.parse(read(name));

/** The recorded listings, as the job's transport sees them. */
const BY_URL = new Map(SOURCES.map((s) => [s.url, FILE[s.key]]));
async function recorded({ url }) {
    const file = BY_URL.get(url);
    if (!file) return { status: 404, headers: {}, body: '' };
    return { status: 200, headers: {}, body: read(file) };
}

/** The same listings with one price moved: GLM's input price jumps 43%, Qwen's input price rises 7%. */
async function moved({ url }) {
    const res = await recorded({ url });
    if (res.status !== 200) return res;
    let body = res.body;
    if (url.includes('docs.z.ai')) body = body.replace(/(\| GLM-5\.3 \| )\\\$1\.4/, (m, head) => head + '\\$2.0');
    if (url.includes('model-studio')) body = body.replace(/(qwen3\.8-flash<\/p>[\s\S]*?)\$0\.15/, (m, head) => head + '$0.16');
    return { status: 200, headers: {}, body };
}

const t = suite('price-book');
let h;
const CLOCK = { now: () => Date.parse('2026-11-13T09:00:00Z') };
const DAY = '2026-11-13';

t.test('every provider listing is read in its own shape', async () => {
    assert.deepStrictEqual(parsers.glm(read('glm.md'))['glm-5.3'], { in: 1.4, cached: 0.26, out: 4.4 });
    assert.deepStrictEqual(parsers.glm(read('glm.md'))['glm-4.7-flash'], { in: 0, cached: 0, out: 0 });
    assert.deepStrictEqual(parsers.abliteration(read('abliteration.md'))['abliterated-model'], { in: 1, cached: 0.1, out: 3 });
    assert.deepStrictEqual(parsers.minimax(read('minimax.md'))['minimax-m3'], { in: 0.3, cached: 0.06, out: 1.2 });
    assert.deepStrictEqual(parsers.deepseek(read('deepseek.md'))['deepseek-v4-pro'], { in: 1.32, cached: 0.044, out: 3.96 });
    assert.deepStrictEqual(parsers.qwen(read('qwen.html'))['qwen3.8-max'], { in: 2, cached: null, out: 6 });
    assert.deepStrictEqual(parsers.kimi(read('kimi.html'))['kimi-k3.1-pro'], { in: 2, cached: 0.2, out: 10 });
    assert.deepStrictEqual(parsers.deepinfra(json('deepinfra.json'))['deepseek-ai/deepseek-v4.1-flash-1017'], { in: 0.2, cached: 0.006, out: 0.6 });
    assert.deepStrictEqual(parsers.novita(json('novita.json'))['qwen/qwen3.8-max'], { in: 2, cached: 0.25, out: 6 });
    assert.deepStrictEqual(parsers.featherless(json('featherless.json'))['qwen/qwen3-14b'], { in: 0.12, cached: null, out: 0.24 });
    // A provider that publishes no price at all: the price stays unknown, it is never guessed.
    assert.deepStrictEqual(parsers.refuseless(read('refuseless.md'))['deepseek-v4.1-flash-abliterated'], { in: null, cached: null, out: null });
});

t.test('the recorder keeps the rows the catalogue knows, and reads nothing of its own', async () => {
    const recorder = require('../scripts/record-price-book');
    assert.ok(recorder.wantedFor('qwen').includes('qwen3.8-max'));
    const trimmed = JSON.parse(recorder.trimJson(read('deepinfra.json'), ['deepseek-ai/DeepSeek-V4.1-Flash-1017']));
    assert.strictEqual(trimmed.data.length, 1);
    assert.strictEqual(trimmed.data[0].id, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
    assert.ok(recorder.trimQwen(read('qwen.html'), ['qwen3.8-max']).includes('qwen3.8-max'));
    assert.ok(recorder.trimKimi(read('kimi.html'), ['kimi-k3.1-pro']).includes('kimi-k3.1-pro'));
    // The module the service loads is the one the operator console reads.
    assert.strictEqual(typeof require('../server/pricebook').createPriceBook, 'function');
    assert.strictEqual(typeof require('../server/api/exchange').exchangeRouter, 'function');
});

t.test('the guard refuses an IP literal, plain http and an internal name', async () => {
    const transport = async () => ({ status: 200, headers: {}, body: 'never read' });
    assert.strictEqual((await readListing('https://example.com/models', { transport })).ok, true);
    // A redirect is followed by hand, so every hop is judged on its own (MiniMax's price page moves).
    const redirecting = async ({ url }) => (url.endsWith('/docs/pricing/overview.md')
        ? { status: 200, headers: {}, body: 'ok' }
        : { status: 307, headers: { location: 'https://platform.minimax.io/docs/pricing/overview.md' }, body: '' });
    const hop = await readListing('https://platform.minimax.io/docs/pricing.md', { transport: redirecting });
    assert.strictEqual(hop.ok, true);
    assert.strictEqual(hop.final_url, 'https://platform.minimax.io/docs/pricing/overview.md');
    for (const url of ['https://127.0.0.1/models', 'https://169.254.169.254/latest', 'https://10.0.0.5/m', 'http://example.com/m', 'https://localhost/m', 'https://model.internal/m']) {
        const res = await readListing(url, { transport });
        assert.strictEqual(res.ok, false, url + ' must not be read');
    }
});

t.test('boot', async () => {
    h = await boot({ env: { DEEPSEEK_KEY: 'test-deepseek-key', DEEPSEEK_API_KEY: 'test-deepseek-key', DEEPINFRA_KEY: 'test-deepinfra-key' } });
});

t.test('the job applies a small change and waits for the owner on a big one', async () => {
    const book = createPriceBook({ db: h.db, registry: h.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' }, clock: CLOCK, log: silent, transport: moved });
    const report = await book.runOnce();
    // Every listing was read; none of them failed.
    assert.strictEqual(report.unreadable.length, 0, JSON.stringify(report.unreadable));
    assert.strictEqual(report.sources.length, SOURCES.length);
    // The small change (Qwen's input price, +7%) was applied at once.
    const applied = report.applied.find((a) => a.model === 'qwen3.8-flash' && a.field === 'in_per_mtok');
    assert.ok(applied, 'the small change was applied');
    assert.strictEqual(applied.next, 0.16);
    const qwen = await h.registry.getModel('qwen', 'qwen3.8-flash');
    assert.strictEqual(Number(qwen.cost.in_per_mtok), 0.16);
    assert.strictEqual(qwen.cost.verified_at, DAY);
    // The big change (GLM's input price, +43%) waits: the live price is untouched.
    const waiting = report.pending.find((p) => p.model === 'glm-5.3' && p.field === 'in_per_mtok');
    assert.ok(waiting, 'the big change waits for the owner');
    const glm = await h.registry.getModel('glm', 'glm-5.3');
    assert.strictEqual(Number(glm.cost.in_per_mtok), 1.4);
    // Every change is in the log with the old price, the new price, the listing and the day.
    const changes = await h.db.prepare('SELECT * FROM price_changes ORDER BY created_at').all();
    assert.ok(changes.length >= 2);
    const logged = changes.find((c) => c.model_key === 'qwen3.8-flash');
    assert.strictEqual(logged.status, 'applied');
    assert.strictEqual(Number(logged.old_price), 0.15);
    assert.strictEqual(Number(logged.new_price), 0.16);
    assert.strictEqual(String(logged.checked_at).slice(0, 10), DAY);
    assert.strictEqual(logged.source, 'https://www.alibabacloud.com/help/en/model-studio/model-pricing');
    const pending = changes.find((c) => c.model_key === 'glm-5.3');
    assert.strictEqual(pending.status, 'pending');
});

t.test('the owner approves a waiting change and the price the router charges follows', async () => {
    const book = createPriceBook({ db: h.db, registry: h.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' }, clock: CLOCK, log: silent, transport: moved });
    const pending = await h.db.prepare("SELECT * FROM price_changes WHERE status = 'pending'").all();
    assert.strictEqual(pending.length, 1);
    const out = await book.decide(pending[0].id, { decision: 'approve', actor: 'usr_owner' });
    assert.strictEqual(out.ok, true);
    const glm = await h.registry.getModel('glm', 'glm-5.3');
    assert.strictEqual(Number(glm.cost.in_per_mtok), 2);
    assert.strictEqual(glm.cost.verified_at, DAY);
    const row = await h.db.prepare('SELECT * FROM price_changes WHERE id = ?').get(pending[0].id);
    assert.strictEqual(row.status, 'approved');
    assert.strictEqual(row.decided_by, 'usr_owner');
    // A change that was already decided is not decided twice.
    const again = await book.decide(pending[0].id, { decision: 'approve', actor: 'usr_owner' });
    assert.strictEqual(again.ok, false);
});

t.test('the public catalog says when the price was checked', async () => {
    // The catalog lists an offer only when the provider's key is there, as production has it.
    await h.registry.upsertProvider({
        key: 'deepinfra', display_name: 'DeepInfra', kind: 'openai', auth_mode: 'bearer', secret_ref: 'env:DEEPINFRA_KEY',
        base_url: 'https://api.deepinfra.test', capabilities: ['chat'], provider_access: 'AUTHORIZED_WHOLESALE',
    });
    const book = createPriceBook({ db: h.db, registry: h.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' }, clock: CLOCK, log: silent, transport: recorded });
    await book.runOnce();
    const res = await request(h.base, 'GET', '/api/v1/exchange/catalog');
    assert.strictEqual(res.status, 200);
    const offer = res.body.models.flatMap((m) => m.offers).find((o) => o.provider === 'deepinfra' && o.model === 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
    assert.ok(offer, 'the deepinfra offer is listed');
    assert.strictEqual(offer.price_checked_at, DAY);
    assert.strictEqual(offer.price_checked, 'price checked ' + DAY);
});

t.test('the Exchange changelog serves the changes that are live', async () => {
    const res = await request(h.base, 'GET', '/api/v1/exchange/price-changes');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.count >= 1);
    const change = res.body.changes.find((c) => c.model === 'qwen3.8-flash');
    assert.ok(change, 'the applied change is in the changelog');
    assert.strictEqual(change.old_price, 0.15);
    assert.strictEqual(change.new_price, 0.16);
    assert.strictEqual(change.checked_at, DAY);
    assert.ok(change.source.startsWith('https://'));
    // A change that waits for the owner is not a price yet, so it is not in the changelog.
    assert.ok(!res.body.changes.some((c) => c.model === 'glm-5.3' && c.status === 'pending'));
});

t.test('the job is off under a drill and off in test mode', async () => {
    const book = createPriceBook({ db: h.db, registry: h.registry, config: { priceBook: { enabled: false }, nodeEnv: 'test' }, clock: CLOCK, log: silent, transport: recorded });
    assert.deepStrictEqual(await book.runOnce(), { skipped: 'disabled' });
    assert.deepStrictEqual(await book.tick(), { skipped: 'disabled' });
    // A clock past the interval, so the book is due: the drill is what stops it.
    const later = { now: () => Date.parse('2026-12-20T09:00:00Z') };
    const drilled = createPriceBook({ db: h.db, registry: h.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' }, clock: later, log: silent, transport: recorded });
    await h.registry.upsertProvider({ key: 'qwen', display_name: 'Qwen', kind: 'openai', auth_mode: 'bearer', secret_ref: 'vault:qwen', metadata: { drill: true } });
    assert.deepStrictEqual(await drilled.runOnce(), { skipped: 'drill' });
    assert.deepStrictEqual(await drilled.tick(), { skipped: 'drill' });
});

t.test('the operator page shows the change that waits for the owner', async () => {
    const { pages } = require('../server/console/views');
    const pending = await h.db.prepare("SELECT * FROM price_changes WHERE status = 'pending'").all();
    assert.ok(pending.length >= 1);
    const html = pages.pricebook({
        staff: { subject: 'usr_owner', username: 'owner', role: 'owner', caps: ['ai.provider.manage'] },
        csrf: 'csrf-token', canManage: true,
        report: { checked_at: DAY, sources: [{ source: 'glm' }], applied: [], pending: pending, unreadable: [] },
        state: { last_run_at: '2026-11-13T09:00:00.000Z' },
        pending, recent: [],
    });
    assert.match(html, /Price book/);
    assert.match(html, /Waiting for the owner/);
    assert.ok(html.includes(pending[0].model_key), 'the waiting change is on the page');
    assert.match(html, /Approve/);
    assert.ok(!/<script/i.test(html), 'no script on the operator page');
});

t.test('the book is due-based: a restart before the week does not run it, a restart after it does', async () => {
    // Its own database, so the last run of the other tests is not this one's history.
    const own = await boot({ env: { DEEPSEEK_KEY: 'test-deepseek-key', DEEPSEEK_API_KEY: 'test-deepseek-key' } });
    try {
        const at = Date.parse('2026-11-20T09:00:00Z');
        const book = (now) => createPriceBook({
            db: own.db, registry: own.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' },
            clock: { now: () => now }, log: silent, transport: recorded,
        });

        // The first boot has no row: the book has never run, so it is due at once.
        const first = await book(at).tick();
        assert.ok(first && !first.skipped, 'the first run happens');
        assert.ok(first.sources.length > 0, 'the listings were read');

        // A restart a minute later: the week has not passed, so nothing runs.
        assert.deepStrictEqual(await book(at + 60 * 1000).tick(), { skipped: 'not due' });

        // A restart after the interval: the book runs once.
        const later = book(at + 8 * 24 * 60 * 60 * 1000);
        const again = await later.tick();
        assert.ok(again && !again.skipped, 'the week came round');
        assert.deepStrictEqual(await later.tick(), { skipped: 'not due' });

        // The row says when the last run finished, and nobody holds the claim.
        const row = await own.db.prepare("SELECT * FROM price_book_state WHERE id = 'pricebook'").get();
        assert.ok(row.last_run_at, 'the last run is remembered in the database');
        assert.strictEqual(row.claimed_until, null);
        assert.strictEqual(row.claimed_by, null);
    } finally {
        await own.stop();
    }
});

t.test('two instances at the same moment: only one reads the listings', async () => {
    const own = await boot({ env: { DEEPSEEK_KEY: 'test-deepseek-key', DEEPSEEK_API_KEY: 'test-deepseek-key' } });
    try {
        const at = Date.parse('2026-11-27T09:00:00Z');
        // A listing that takes a moment, so the first instance still holds the claim when the second asks.
        const slow = async ({ url }) => { await new Promise((r) => setTimeout(r, 120)); return recorded({ url }); };
        const instance = () => createPriceBook({
            db: own.db, registry: own.registry, config: { priceBook: { enabled: true }, nodeEnv: 'test' },
            clock: { now: () => at }, log: silent, transport: slow,
        });
        const [one, two] = await Promise.all([instance().tick(), instance().tick()]);
        const ran = [one, two].filter((r) => r && !r.skipped);
        const skipped = [one, two].filter((r) => r && r.skipped);
        assert.strictEqual(ran.length, 1, 'one instance read the listings');
        assert.strictEqual(skipped.length, 1);
        assert.strictEqual(skipped[0].skipped, 'claimed');
        // The claim was given back when the run ended.
        const row = await own.db.prepare("SELECT * FROM price_book_state WHERE id = 'pricebook'").get();
        assert.strictEqual(row.claimed_until, null);
        assert.strictEqual(row.claimed_by, null);
    } finally {
        await own.stop();
    }
});

t.test('stop', async () => {
    await h.stop();
});

t.run();
