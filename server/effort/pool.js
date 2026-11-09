'use strict';
const { AiError } = require('../util');
const { modelsOf } = require('./defaults');
// A local wrapper leaves the shared provider router's admission, caps, billing and
// fallback rules in charge. Explicit caller model pins take precedence over defaults.
function wrapPool(pool) {
    if (!pool) return pool;
    return Object.assign(Object.create(pool), {
        async execute(route, operation, request, ctx = {}) {
            if (!['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages'].includes(operation)) return pool.execute(route, operation, request, ctx);
            const policy = ctx.effortPolicy;
            let runCtx = ctx;
            if (policy && policy.role_default && !ctx.exact && !ctx.routePin && ctx.taskChoice?.why !== 'run') {
                const offered = await pool.offers(route, operation, ctx);
                const choices = modelsOf(policy.role_default);
                const selected = choices.map(id => offered.find(o => `${o.provider}/${o.model}` === id)).filter(Boolean);
                const chosen = selected[0];
                if (!chosen) throw new AiError(503, 'role.model_unavailable', 'no model from this role default is offered by the route');
                runCtx = { ...ctx, taskChoice: null, policy: 'exact', exact: { id: `${chosen.provider}/${chosen.model}`, offers: selected.map(o => ({ provider: o.provider, model: o.model })) } };
            }
            const result = await pool.execute(route, operation, { ...request, ...(policy ? { effort: policy.effort_resolved } : {}) }, runCtx);
            return { ...result, explain: { ...(result.explain || {}), effort_applied: result.result && result.result.effortApplied || null } };
        },
    });
}
module.exports = { wrapPool };
