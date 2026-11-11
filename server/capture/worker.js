'use strict';
/**
 * The capture worker process (systemd: openvibe-ai-capture.service, MemoryMax=1500M).
 *
 *   AI_CAPTURE_PORT=4710 AI_CAPTURE_HOST=127.0.0.1 node server/capture/worker.js
 *
 * It speaks JSON on loopback only: POST /capture { url, runId, owner, extras } -> the capture (Media ids, DOM
 * facts, Expert extras); GET /health -> { status, chrome, enabled }. OpenVibe.AI calls it when AI_CAPTURE_URL is
 * set, so the browser lives in a process of its own: a page that eats memory is killed by MemoryMax without
 * taking the API down, and one deploy of AI does not need a browser running in it. No sign-in, no cookie kept,
 * every URL through the egress guard, robots.txt respected, one browser at a time.
 *
 * It is off under a restore drill (AI_DRILL/LIVE_DRILL): /capture answers 503 capture.drill and no Chrome starts.
 * AI_CAPTURE_TOKEN, when set, must match the `x-ov-capture-token` header; it is read from the environment and
 * never written into a request or a log.
 */
const http = require('http');
const { load } = require('../config');
const { createMediaStore } = require('../media-store');
const { createCapture } = require('./index');

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}

function createCaptureWorker({ config, env = process.env, log = console, capture = null, media = null } = {}) {
    const mediaStore = media || createMediaStore({ config, env, log });
    const cap = capture || createCapture({ config, env, log, upload: (o) => mediaStore.put({ ...o, visibility: 'private' }) });
    const token = String(env.AI_CAPTURE_TOKEN || '');
    const host = env.AI_CAPTURE_HOST || '127.0.0.1';
    const port = Math.max(1, Number(env.AI_CAPTURE_PORT) || 4710);
    let server = null;

    const handler = async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', service: 'openvibe-ai-capture', chrome: cap.available(), enabled: cap.enabled(), budget_ms: config.capture.pageBudgetMs });
        if (req.method !== 'POST' || req.url !== '/capture') return json(res, 404, { code: 'capture.not_found', detail: 'POST /capture or GET /health' });
        if (token && req.headers['x-ov-capture-token'] !== token) return json(res, 401, { code: 'capture.unauthorized', detail: 'x-ov-capture-token does not match' });
        if (!cap.enabled()) return json(res, 503, { code: 'capture.drill', detail: 'capture is off under a restore drill' });
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 65536) return json(res, 413, { code: 'capture.too_large', detail: 'capture body is larger than 64 KB' });
        }
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return json(res, 422, { code: 'input.invalid', detail: 'JSON body required' }); }
        if (!body || typeof body.url !== 'string' || !body.url) return json(res, 422, { code: 'input.invalid', detail: 'url is required' });
        if (body.owner != null && !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(body.owner))) return json(res, 422, { code: 'input.invalid', detail: 'owner must be a user subject id' });
        if (body.runId != null && !/^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(body.runId))) return json(res, 422, { code: 'input.invalid', detail: 'runId must be a run id' });
        try {
            const out = await cap.captureSite({ url: body.url, runId: body.runId || null, owner: body.owner || null, extras: body.extras === true });
            return json(res, out.skipped && out.skipped !== 'cancelled' ? 200 : 200, out);
        } catch (err) {
            log.error(`[capture] ${String(err && err.stack || err).slice(0, 500)}`);
            return json(res, err && err.code === 'run.cancelled' ? 409 : 502, { code: (err && err.code) || 'capture.failed', detail: String((err && err.message) || err).slice(0, 300) });
        }
    };

    function start() {
        return new Promise((resolve, reject) => {
            server = http.createServer((req, res) => { handler(req, res).catch((err) => json(res, 500, { code: 'capture.internal', detail: String((err && err.message) || err).slice(0, 200) })); });
            server.once('error', reject);
            server.listen(port, host, () => {
                log.log(`[capture] listening on http://${host}:${port} (chrome ${cap.available() ? 'ready' : 'missing'})`);
                resolve(server);
            });
        });
    }

    function close() {
        return new Promise((resolve) => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); });
    }

    return { start, close, handler, capture: cap };
}

/** The process entry point (systemd ExecStart). */
async function main() {
    const config = load(process.env);
    const worker = createCaptureWorker({ config, env: process.env, log: console });
    const server = await worker.start();
    const stop = async () => { await worker.close(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('unhandledRejection', (err) => console.error('[capture] unhandled rejection:', err));
    return { worker, server };
}

if (require.main === module) main().catch((err) => { console.error('[capture] failed to start:', err && err.stack || err); process.exit(1); });

module.exports = { createCaptureWorker, main };
