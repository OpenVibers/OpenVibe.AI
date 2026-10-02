'use strict';
// openvibe-sdk/service in AI: sendError keeps AI's problem bodies (an AiError's status, code, detail, errors and
// extra; Retry-After on a 429; anything else 500 ai.internal, never a provider's upstream status), and the
// process stop drains the server, then closes the handles (exit 0, or 1 when handles.close() fails).
const assert = require('assert');
const http = require('http');
const { AiError, sendError } = require('../server/util');
const { ProviderError } = require('../server/providers/common');
const { gracefulStop } = require('openvibe-sdk/service');
const { suite } = require('./helpers');

const t = suite('service-kit');
const quiet = { log() {}, warn() {}, error() {} };
const ctx = { requestId: 'req_1', traceId: 'trace_1' };

function fakeRes() {
    const headers = {};
    return {
        headers, statusCode: 0, body: null, headersSent: false,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        getHeader(k) { return headers[k.toLowerCase()]; },
        end(s) { this.body = JSON.parse(s); this.headersSent = true; },
    };
}

t.test('an AiError answers its own status, code, detail, errors and extra; a 429 sets Retry-After', () => {
    const res = fakeRes();
    sendError(res, new AiError(429, 'quota.exceeded', 'quota exceeded for global *', { retry_after_seconds: 42, quota: { id: 1 }, errors: [{ path: '/x', message: 'bad' }] }), ctx, quiet);
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.headers['retry-after'], '42');
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.deepStrictEqual(res.body, {
        type: 'https://openvibe.network/problems/quota.exceeded', title: 'Too Many Requests', status: 429, code: 'quota.exceeded',
        detail: 'quota exceeded for global *', errors: [{ path: '/x', message: 'bad' }], request_id: 'req_1', trace_id: 'trace_1',
        error: 'quota exceeded for global *', retry_after_seconds: 42, quota: { id: 1 },
    });
});

t.test('anything else is a logged 500 ai.internal, even an error that carries an HTTP status and a code', () => {
    for (const err of [new Error('boom'), new ProviderError('upstream said no', { status: 401, code: 'provider.error' })]) {
        const res = fakeRes();
        const logged = [];
        sendError(res, err, ctx, { ...quiet, error: (...a) => logged.push(a.join(' ')) });
        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            type: 'https://openvibe.network/problems/ai.internal', title: 'Internal Server Error', status: 500, code: 'ai.internal',
            detail: 'internal error', request_id: 'req_1', trace_id: 'trace_1', error: 'internal error',
        });
        assert.ok(logged.length === 1 && logged[0].includes(err.message), 'the stack is logged');
    }
});

t.test('the stop drains the server, then closes the handles; a failing close exits 1', async () => {
    for (const fails of [false, true]) {
        const server = http.createServer((_req, res) => res.end('ok'));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const order = [];
        const handles = { close: async () => { order.push(server.listening ? 'close while listening' : 'close'); if (fails) throw new Error('db'); } };
        let exited = null;
        const code = await gracefulStop({ name: 'ai', server, handles, drainMs: 8000, deadlineMs: 10000, signals: false, exit: (c) => { exited = c; }, log: quiet }).stop('SIGTERM');
        assert.deepStrictEqual(order, ['close']);
        assert.strictEqual(code, fails ? 1 : 0);
        assert.strictEqual(exited, code);
    }
});

t.run();
