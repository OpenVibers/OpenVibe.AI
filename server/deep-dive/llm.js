'use strict';
/**
 * The deep dive's model calls: one JSON answer per call, validated against a schema before it is used.
 *
 * Everything goes through the provider pool (server/providers/) with the run's own context, so the call is on the
 * run's receipt, its provider quota and its cancellation signal. A route is resolved like a workflow's: the JSON
 * route (`default.json`) for text, the same route with an image for a vision call, and `background.vision` for
 * Expert reads that may wait. A call that answers invalid JSON is asked once more; a second bad answer fails the
 * run (output.invalid), because nothing is ever filled in.
 */
const { AiError, parseJsonLoose, sha256 } = require('../util');
const schemas = require('../schemas');

function createLlm({ registry, pool, config = {}, log = console, clock = { now: () => Date.now() } }) {
    async function routeFor(key) {
        const r = await registry.resolveRoute(key);
        if (!r) throw new AiError(503, 'route.unavailable', `no route ${key}`);
        if (r.disabled) throw new AiError(503, 'route.unavailable', `route ${key} is disabled`);
        return r;
    }

    /**
     * call({ routeKey, system, user, image, schema, schemaName, maxTokens, temperature, signal, ctx })
     * -> { json, provider, model, tokens_in, tokens_out, cost_usd, ms, route, synthetic }
     */
    async function call({ routeKey = 'default.json', system, user, image = null, schema = null, schemaName = 'result', maxTokens = 3000, temperature = 0.3, signal = null, ctx = {}, retry = true }) {
        const route = await routeFor(routeKey);
        const req = {
            system: system ? [{ text: system, cache: true }] : [],
            messages: [{ role: 'user', content: user }],
            image,
            json: schema ? { name: schemaName, schema, strict: false } : null,
            maxTokens: Math.max(64, Math.min(8000, maxTokens)),
            temperature,
            timeoutMs: route.timeout_ms || 90000,
            cacheKey: null,
        };
        const t0 = clock.now();
        const exec = await pool.execute(route, 'chat', req, {
            ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: sha256({ s: system, u: user, i: image ? 1 : 0 }),
            ...(signal ? { signal } : {}),
        });
        const text = exec.result.text || '';
        let json = exec.result.json || null;
        if (!json) json = parseJsonLoose(text);
        let valid = json && (!schema || schemas.validate(schema, json).valid);
        if (!valid && retry) {
            const problem = json ? schemas.validate(schema, json).errors.map((e) => `${e.path} ${e.message}`).join('; ') : 'the answer was not JSON';
            const again = await call({
                routeKey, system, user: `${user}\n\nYour previous answer was not valid (${problem.slice(0, 400)}). Answer again with only the JSON object the instructions name, nothing before or after it.`,
                image, schema, schemaName, maxTokens, temperature: 0.1, signal, ctx, retry: false,
            });
            return again;
        }
        if (!valid) {
            const errors = json ? schemas.validate(schema, json).errors : [{ path: '/', message: 'not JSON' }];
            throw new AiError(502, 'output.invalid', `the model answered a shape the deep dive cannot use: ${errors.map((e) => `${e.path} ${e.message}`).slice(0, 4).join('; ')}`);
        }
        return {
            json, provider: exec.provider || null, model: exec.model || null,
            tokens_in: (exec.usage && exec.usage.input) || 0, tokens_out: (exec.usage && exec.usage.output) || 0,
            cost_usd: Number(exec.cost) || 0, ms: clock.now() - t0, route, synthetic: Boolean(exec.synthetic),
        };
    }

    return { call, routeFor };
}

module.exports = { createLlm };
