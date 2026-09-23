'use strict';
/**
 * Shared test fixtures: a generated Network signing key and token minting, a booted AI service on
 * a random port with a temp database, a tiny assertion runner, and a local HTTP-seam provider
 * server whose behaviour each test scripts.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeHttp = require('http');
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');

const ISSUER = 'https://openvibe.network';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const silent = { log() {}, warn() {}, error(...a) { if (process.env.DEBUG) console.error(...a); } };

function token(slug, cap, { aud = 'openvibe.ai', ns = [], exp = Math.floor(Date.now() / 1000) + 300, key = privateKey, sub } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: sub || `svc:${slug}`, actor_type: 'service', aud: [aud], cap, ns, iat: now, exp,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
    }, key);
}

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-test-'));
    made.push(d);
    return d;
}

/** Boot the service. `env` goes through config.load() and is also what secrets resolve against. */
async function boot({ env = {}, dir = tmpDir(), clock, fetchImpl } = {}) {
    const fullEnv = {
        NODE_ENV: 'test', PORT: '0', AI_DB_PATH: path.join(dir, 'ai.db'), OV_NETWORK_PUBLIC_KEY: publicKey,
        AI_PROVIDER_RETRY_DELAY_MS: '5', AI_QUOTA_SERVICE_RPM: '0', AI_QUOTA_SERVICE_RPD: '0',
        ...env,
    };
    const config = load(fullEnv);
    const h = await start({ config, env: fullEnv, log: silent, clock, fetchImpl });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, dir, env: fullEnv, stop: () => h.close() };
}

async function request(base, method, p, { tok, body, headers = {} } = {}) {
    const h = { ...headers };
    if (tok) h.Authorization = `Bearer ${tok}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
}

/**
 * A local HTTP-seam provider: handler(body) -> response object (or { status, body }, or a Promise).
 * .calls counts requests, .last is the last request body.
 */
async function seamServer(handler) {
    const s = { calls: 0, last: null, handler };
    s.server = nodeHttp.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
            s.calls++;
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
            s.last = body;
            try {
                const out = await s.handler(body, req);
                const status = out && out.status ? out.status : 200;
                const payload = out && out.status ? out.body : out;
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload || {}));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    });
    await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
    s.url = `http://127.0.0.1:${s.server.address().port}`;
    s.close = () => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(() => r()); });
    return s;
}

/** Sequential async test runner with a summary line; exits non-zero on any failure. */
function suite(name) {
    const tests = [];
    return {
        test(title, fn) { tests.push({ title, fn }); },
        async run() {
            let failed = 0;
            for (const t of tests) {
                try {
                    await t.fn();
                    console.log(`  ✓ ${t.title}`);
                } catch (e) {
                    failed++;
                    console.log(`  ✗ ${t.title}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n    ') : e}`);
                }
            }
            console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
            // Exit explicitly: a failed test may leave a server or timer open behind it.
            process.exit(failed ? 1 : 0);
        },
    };
}

const ALL = ['ai.run.create', 'ai.run.read', 'ai.workflow.manage', 'ai.provider.manage', 'ai.usage.read'];

module.exports = { token, boot, request, seamServer, suite, tmpDir, silent, publicKey, privateKey, ISSUER, ALL };
