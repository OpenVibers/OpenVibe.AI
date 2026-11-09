'use strict';
const { parseJson } = require('../util');
function receiptEffort(row, explain) {
    const policy = parseJson(row.options, {}).effort_policy;
    if (!policy) return {};
    const applied = explain && explain.effort_applied || null;
    return {
        effort_requested: policy.effort_requested,
        effort_applied: applied,
        ...(policy.ladder_id ? {
            ladder_id: policy.ladder_id, effort_rung: policy.effort_rung,
            ladder: row.model_key ? [{ model: row.model_key, effort: applied || policy.effort_resolved, cost_usd: Number(row.cost_usd) || 0, outcome: row.status || 'succeeded' }] : [],
        } : {}),
    };
}
module.exports = { receiptEffort };
