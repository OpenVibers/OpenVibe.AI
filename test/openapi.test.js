'use strict';
/**
 * /openapi.json documents this service's run API, and the document is the API: every route it lists
 * is a route the app mounts, and every mounted public /api/v1 route is listed (the probes, the
 * redirect, the operator/admin API, the attribution-quota API and credentials excepted). The mounted
 * set is read from the real Express stack, so a route added, renamed or removed without the document
 * fails here. Credentials are excluded on purpose: no secret-bearing field may reach the document.
 */
const assert = require('assert');
const H = require('./helpers');
const { routes, MOUNT } = require('../server/openapi');

/** The path an app.use(...) layer mounts its router at, decoded from Express's compiled regexp. */
function mountOf(layer) {
    const source = String((layer.regexp && layer.regexp.source) || '');
    if (layer.regexp && layer.regexp.fast_slash) return '';
    const m = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
    assert.ok(m, `cannot read the mount path of a router layer (${source})`);
    return m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

/** ":param" as OpenAPI writes it, "{param}". */
const templated = (p) => String(p).replace(/\\:/g, '\u0000').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}').replace(/\u0000/g, ':');

/** Every "METHOD /path" the app answers, routers included. */
function mounted(app) {
    const out = new Set();
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                for (const [method, on] of Object.entries(layer.route.methods)) {
                    if (!on || method === '_all') continue;
                    for (const p of [].concat(layer.route.path)) out.add(`${method.toUpperCase()} ${prefix}${templated(p)}`);
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountOf(layer));
            }
        }
    };
    assert.ok(app._router && app._router.stack, 'the app has a router');
    walk(app._router.stack, '');
    return out;
}

/**
 * Not public API surface: probes and redirect, the operator/admin API, the attribution-quota API and
 * the credential routes (which must never appear in a public document). The person's own /api/v1/me/*
 * routes are person-only and carry a key on PUT, so they stay out for the same reason.
 */
const LEFT_OUT = [
    '/api/health', '/api/ready', '/api/v1/openapi.json',
    '/api/v1/status', '/api/v1/providers', '/api/v1/models', '/api/v1/routes', '/api/v1/templates', '/api/v1/workflows',
    '/api/v1/quotas', '/api/v1/usage', '/api/v1/requests', '/api/v1/audit', '/api/v1/cache',
    '/api/v1/credentials', '/api/v1/attribution-quotas', '/api/v1/me',
];
const excluded = (key) => {
    const p = key.split(' ')[1];
    return LEFT_OUT.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
};

(async () => {
    const h = await H.boot();
    try {
        const r = await H.request(h.base, 'GET', '/openapi.json');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
        assert.ok(r.body, 'the response is JSON');

        const doc = r.body;
        assert.strictEqual(doc.openapi, '3.1.0');
        assert.ok(doc.paths && typeof doc.paths === 'object', 'paths is an object');
        assert.strictEqual(doc.info.title, 'OpenVibe.AI API');
        assert.deepStrictEqual(doc.servers, [{ url: 'https://openvibe.ai' }]);
        const documented = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)).sort();
        assert.ok(documented.length > 0, 'paths is not empty');
        for (const [p, item] of Object.entries(doc.paths)) {
            assert.ok(p.startsWith('/api/'), `${p} is outside /api`);
            for (const [method, op] of Object.entries(item)) {
                assert.ok(op.operationId, `${method.toUpperCase()} ${p} has an operationId`);
                assert.ok(op.responses && Object.keys(op.responses).length, `${method.toUpperCase()} ${p} describes its responses`);
            }
        }
        // The document never carries a credential or a provider secret field.
        const text = JSON.stringify(doc);
        for (const field of ['credential', 'api_key', 'secret_ref', 'project_provider']) {
            assert.ok(!text.includes(`"${field}"`), `the document must not name ${field}`);
        }

        const live = [...mounted(h.app)].filter((key) => key.split(' ')[1].startsWith(`${MOUNT}/`) && !excluded(key)).sort();
        assert.deepStrictEqual(documented, live, 'every mounted public /api/v1 route is documented and vice versa');
        assert.deepStrictEqual(routes(), documented, 'server/openapi.js routes() and the document agree');

        const redirect = await fetch(`${h.base}/api/v1/openapi.json`, { redirect: 'manual' });
        assert.strictEqual(redirect.status, 308);
        assert.strictEqual(redirect.headers.get('location'), '/openapi.json');
    } finally {
        await h.stop();
    }
    console.log('openapi: /openapi.json documents exactly the public /api/v1 routes');
})().catch((err) => { console.error(err); process.exitCode = 1; });
