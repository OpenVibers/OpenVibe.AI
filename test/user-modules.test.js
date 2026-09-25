'use strict';
/**
 * AI's Network user modules (server/user-modules.js, Contracts 0.41.0, WS-B task 9):
 *   - a run on a person's behalf follows their ai.preferences: style/length/perspective reach the system
 *     prompt, history: false keeps neither the input nor a cache entry; other runs are untouched
 *   - ai.usage_summary: runs, tokens and services over 30 days, written as the owner, only when changed
 */
const assert = require('assert');
const http = require('http');
const { boot, request, token, suite, seamServer, ALL } = require('./helpers');
const { preferenceLines } = require('../server/user-modules');

const t = suite('user modules');
const live = token('live', ALL);
const A = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA' };
const B = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB' };
let h, seam, network;
const prefs = { [A.id]: { style: 'casual', length: 'short', perspective: 'a night-shift worker', history: false } };
const puts = [];
const systemOf = () => (seam.last.system || []).map((s) => s.text || s).join('\n');
const summarize = (extra = {}) => request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok: live, body: { workflow: 'ai.summarize', input: { text: 'A long day at the plant, told briefly.' }, ...extra } });

t.test('boot with a stub Network and a seam provider', async () => {
    network = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'svc-ai', token_type: 'Bearer', expires_in: 300 }));
            assert.strictEqual(req.headers.authorization, 'Bearer svc-ai');
            const m = req.url.match(/^\/internal\/modules\/(ai\.[a-z_]+)\/(usr_[0-9A-Z]+)$/);
            if (m && req.method === 'GET' && m[1] === 'ai.preferences') {
                if (!prefs[m[2]]) { res.statusCode = 404; return res.end(JSON.stringify({ code: 'modules.not_found' })); }
                return res.end(JSON.stringify({ namespace: 'ai.preferences', revision: 1, data: prefs[m[2]] }));
            }
            if (m && req.method === 'PUT' && m[1] === 'ai.usage_summary') { puts.push({ subject: m[2], data: JSON.parse(raw).data }); res.statusCode = 201; return res.end('{}'); }
            res.statusCode = 404; res.end('{}');
        });
    });
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    seam = await seamServer(() => ({ text: `summary #${seam.calls}`, usage: { input: 30, output: 10 } }));
    h = await boot({ env: { AI_STUB_FALLBACK: 'false', OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40), OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${network.address().port}` } });
    await request(h.base, 'POST', '/api/v1/providers', { tok: live, body: { key: 'seam', kind: 'http', base_url: seam.url, auth_mode: 'none', capabilities: ['summarize', 'generate', 'chat', 'json'] } });
    await request(h.base, 'POST', '/api/v1/routes/default.chat/versions', { tok: live, body: { primary: { provider: 'seam' }, fallbacks: [] } });
});

t.test('preference lines', () => {
    assert.strictEqual(preferenceLines({}), '');
    assert.strictEqual(preferenceLines({ personalization: false, history: true }), '', 'only style, length and perspective change a prompt');
    const l = preferenceLines({ style: 'formal', length: 'long', perspective: 'x'.repeat(200) });
    assert.ok(l.includes('formal style') && l.includes('longer answer') && l.includes('x'.repeat(80) + '.') && !l.includes('x'.repeat(81)));
});

t.test("a run on A's behalf follows A's preferences; history off keeps no input and no cache entry", async () => {
    const r = await summarize({ on_behalf_of: A });
    assert.strictEqual(r.body.run.status, 'succeeded', r.text);
    const sys = systemOf();
    assert.ok(sys.includes('casual style') && sys.includes('Keep it short.') && sys.includes('a night-shift worker'), sys);
    const row = h.db.prepare('SELECT input, cache_key, options FROM runs WHERE id = ?').get(r.body.run.id);
    assert.strictEqual(row.input, 'null'); assert.strictEqual(row.cache_key, null);
    assert.strictEqual(JSON.parse(row.options).history, false);
    const calls = seam.calls;
    const again = await summarize({ on_behalf_of: A });
    assert.strictEqual(again.body.run.status, 'succeeded', 'computed again: nothing was cached');
    assert.strictEqual(seam.calls, calls + 1);
});

t.test('runs for someone without preferences, or for nobody, are untouched', async () => {
    await summarize({ on_behalf_of: B });
    assert.ok(!systemOf().includes('The person this is for asked'));
    const r = await summarize();
    assert.ok(!systemOf().includes('The person this is for asked'));
    assert.notStrictEqual(h.db.prepare('SELECT input FROM runs WHERE id = ?').get(r.body.run.id).input, 'null');
});

t.test('ai.usage_summary: 30-day runs and tokens per person, written only when changed', async () => {
    const mods = require('../server/user-modules').createUserModules({ db: h.db, config: h.config || { networkInternalUrl: h.env.OV_NETWORK_INTERNAL_URL }, env: h.env, log: {} });
    mods.ensureSchema();
    const s = mods.summarize(A.id);
    assert.strictEqual(s.runs_30d, 2); assert.strictEqual(s.tokens_30d, 80);
    assert.deepStrictEqual(s.by_service, { live: 2 });
    assert.ok(await mods.push(A.id));
    assert.strictEqual(puts.at(-1).subject, A.id);
    assert.ok(puts.at(-1).data.computed_at);
    const { modules } = require('openvibe-contracts');
    if (modules.get('ai.usage_summary')) assert.ok(modules.validateData('ai.usage_summary', puts.at(-1).data).valid);
    assert.strictEqual(await mods.push(A.id), false, 'unchanged: not written again');
    assert.strictEqual(await mods.scan(Date.now() + 1000), 2, 'the scan sees A and B (their runs were just made)');
    assert.deepStrictEqual(puts.map((p) => p.subject).sort(), [A.id, B.id].sort());
    assert.strictEqual(mods.summarize('usr_01JAB2C3D4E5F6G7H8J9K0MNPC'), null);
});

t.test('shutdown', async () => { await h.stop(); await seam.close(); network.close(); });

t.run();
