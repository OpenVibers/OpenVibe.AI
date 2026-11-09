'use strict';
const { AiError } = require('../util');
const { modelsOf } = require('./defaults');
// A local wrapper leaves the shared provider router's admission, caps, billing and
// fallback rules in charge. Explicit caller model pins take precedence over defaults.
function wrapPool(pool) {
    return Object.assign(Object.create(pool), {
        async execute(route, operation, request, ctx = {}) {
            if (!['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages'].includes(operation)) return pool.execute(route, operation, request, ctx);
            const policy = ctx.effortPolicy;
            let runCtx = ctx;
            if (policy && policy.role_default && !ctx.exact && !ctx.routePin) {
                const offered = await pool.offers(route, operation, ctx);
                const choices = modelsOf(policy.role_default);
                const chosen = choices.map(id => offered.find(o => `${o.provider}/${o.model}` === id)).find(Boolean);
                if (!chosen) throw new AiError(503, 'role.model_unavailable', 'no model from this role default is offered by the route');
                runCtx = { ...ctx, policy: 'exact', exact: { id: `${chosen.provider}/${chosen.model}`, offers: [{ provider: chosen.provider, model: chosen.model }] } };
            }
            const result = await pool.execute(route, operation, { ...request, ...(policy ? { effort: policy.effort_resolved } : {}) }, runCtx);
            return { ...result, explain: { ...(result.explain || {}), effort_applied: result.result && result.result.effortApplied || null } };
        },
    });
}
module.exports = { wrapPool };
