'use strict';
/**
 * The video analysis' model calls: one JSON answer per call, checked against its shape before it is used.
 *
 * Every call goes through the provider pool (server/providers/) with the run's own context, so it is on
 * the run's receipt, on the provider's quota and under the run's cancellation. A route is resolved the
 * way a workflow's is: the vision route for a keyframe (with the picture), the JSON route for the whole
 * video. An answer that is not valid JSON is asked once more; a second bad answer fails that step with
 * a named gap, because nothing is ever filled in.
 */
const { AiError, parseJsonLoose, sha256 } = require('../util');
const schemas = require('../schemas');

function createLlm({ registry, pool, config = {}, log = console, clock = { now: () => Date.now() } }) {
    async function routeFor(key) {
        const r = await registry.resolveRoute(key);
        if (!r) throw new AiError(503, 'route.unavailable', 'no route ' + key);
        if (r.disabled) throw new AiError(503, 'route.unavailable', 'route ' + key + ' is disabled');
        return r;
    }

    /**
     * call({ routeKey, system, user, image, schema, schemaName, maxTokens, temperature, signal, ctx })
     * -> { json, provider, model, tokens_in, tokens_out, cost_usd, ms, route, synthetic }
     */
    async function call({ routeKey = 'default.json', system, user, image = null, schema = null, schemaName = 'result', maxTokens = 1200, temperature = 0.2, signal = null, ctx = {}, retry = true }) {
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
        let valid = Boolean(json) && (!schema || schemas.validate(schema, json).valid);
        if (!valid && retry) {
            const problem = json ? schemas.validate(schema, json).errors.map((e) => e.path + ' ' + e.message).join('; ') : 'the answer was not JSON';
            return await call({
                routeKey, system, user: user + '\n\nYour previous answer was not valid (' + problem.slice(0, 400) + '). Answer again with only the JSON object the instructions name, nothing before or after it.',
                image, schema, schemaName, maxTokens, temperature: 0.1, signal, ctx, retry: false,
            });
        }
        if (!valid) {
            const errors = json ? schemas.validate(schema, json).errors : [{ path: '/', message: 'not JSON' }];
            throw new AiError(502, 'output.invalid', 'the model answered a shape a video analysis cannot use: ' + errors.map((e) => e.path + ' ' + e.message).slice(0, 4).join('; '));
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
