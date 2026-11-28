'use strict';
// GET /api/v1/routes works out each route's offers six at a time (11-28: one after another, 45 routes took ~25 s, each
// placement ~0.5 s, and Vision's /compare waited on it). The answer keeps the routes' order, a route whose placement
// fails keeps an empty list, and never more than six placements run at once.
const assert = require('assert');
const express = require('express');
const { createServer } = require('http');
const { adminRouter } = require('../server/api/admin');

const N = 20;
const routes = Array.from({ length: N }, (_, i) => ({ key: `r${String(i).padStart(2, '0')}.chat`, capability: 'chat', status: 'active' }));
let running = 0, most = 0;
const pool = {
    stats: {},
    async offers(route) {
        running++; most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        if (route.key === 'r07.chat') throw new Error('placement failed');
        return [{ provider: 'p', model: route.key }];
    },
};
const registry = { async listRoutes() { return routes.map((r) => ({ ...r })); }, async resolveRoute() { return null; } };
const app = express();
app.use((req, _res, next) => { req.principal = { sub: 'svc', subject: { type: 'service', id: 'vision' } }; req.ov = { traceId: 't' }; next(); });
const auth = { requireCap: () => (_req, _res, next) => next() };
app.use(adminRouter({ config: {}, db: {}, registry, pool, quotas: {}, cache: {}, runs: {}, auth, log: { warn() {}, info() {} }, ops: {} }));

(async () => {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const t0 = Date.now();
        const res = await fetch(`${base}/api/v1/routes`);
        const took = Date.now() - t0;
        assert.strictEqual(res.status, 200, await res.clone().text());
        const body = await res.json();
        assert.deepStrictEqual(body.routes.map((r) => r.key), routes.map((r) => r.key), 'the routes keep their order');
        assert.deepStrictEqual(body.routes[3].offers, [{ provider: 'p', model: 'r03.chat' }], 'each route its own offers');
        assert.deepStrictEqual(body.routes[7].offers, [], 'a failed placement is an empty list, not a failed answer');
        assert.ok(most > 1 && most <= 6, `six at a time at most (${most})`);
        assert.ok(took < N * 40 * 0.6, `not one after another (${took} ms for ${N} routes of 40 ms)`);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    process.stdout.write('routes-offers-parallel: route offers six at a time, in order, a failure is an empty list\n');
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
