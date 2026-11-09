'use strict';
const { AiError, parseJson } = require('../util');
const { checkEffort } = require('./providers');
const ROLES = ['router', 'gate', 'assessor', 'worker', 'subagent', 'reviewer'];
const BASE = {
    router: { model: 'deepseek/deepseek-v4-flash', effort: 'low' },
    gate: { model: 'deepseek/deepseek-v4-flash', effort: 'low' },
    assessor: { model: 'deepseek/deepseek-v4-flash', effort: 'medium' },
    worker: { model: 'deepseek/deepseek-v4-flash', effort: 'medium' },
    subagent: { model: 'deepseek/deepseek-v4-flash', effort: 'low' },
    reviewer: { model: 'anthropic/claude-sonnet-5-5', effort: 'high' },
};
const modelsOf = (v) => v.model ? [v.model] : v.choice_order;
function family(model) {
    const m = model.toLowerCase();
    for (const [pattern, name] of [[/claude/, 'anthropic'], [/deepseek/, 'deepseek'], [/gpt-|\/o[134]/, 'openai'], [/gemini/, 'google'], [/qwen/, 'qwen']]) if (pattern.test(m)) return name;
    return m.split('/')[0];
}
function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['model', 'choice_order', 'effort'].includes(k))) throw new AiError(422, 'input.invalid', 'role default needs model or choice_order, and effort');
    checkEffort(value.effort);
    if (value.effort === 'auto') throw new AiError(422, 'input.invalid', 'a role default must resolve auto to a concrete effort');
    if (Boolean(value.model) === Boolean(value.choice_order)) throw new AiError(422, 'input.invalid', 'set exactly one of model or choice_order');
    const models = modelsOf(value);
    if (!Array.isArray(models) || !models.length || models.length > 8 || new Set(models).size !== models.length || models.some(m => typeof m !== 'string' || !/^[\w.-]+\/[\w./:-]{1,200}$/.test(m))) throw new AiError(422, 'input.invalid', 'models must be distinct provider/model ids (one to eight)');
    return JSON.parse(JSON.stringify(value));
}
function createDefaults({ db, registry, clock = { now: () => Date.now() } }) {
    async function get() {
        const result = JSON.parse(JSON.stringify(BASE));
        const rows = await db.prepare('SELECT role, body FROM agent_role_defaults').all();
        for (const row of rows) if (ROLES.includes(row.role)) result[row.role] = parseJson(row.body, result[row.role]);
        // A worker changed alone still gets a different reviewer family by default.
        if (!rows.some(r => r.role === 'reviewer') && modelsOf(result.worker).some(m => family(m) === 'anthropic')) result.reviewer = { model: 'openai/gpt-5.5', effort: 'high' };
        return result;
    }
    async function put(role, value, actor) {
        if (!ROLES.includes(role)) throw new AiError(422, 'input.invalid', 'unknown agent role');
        const checked = validate(value);
        return db.tx(async () => {
            // Serialize updates to the two roles even when their rows do not exist yet.
            await db.prepare('SELECT pg_advisory_xact_lock(570157)').get();
            const before = await get();
            const after = { ...before, [role]: checked };
            if (['worker', 'reviewer'].includes(role)) {
                const reviewerSaved = await db.prepare("SELECT role FROM agent_role_defaults WHERE role = 'reviewer'").get();
                if (role === 'worker' && !reviewerSaved) after.reviewer = modelsOf(checked).some(m => family(m) === 'anthropic') ? { model: 'openai/gpt-5.5', effort: 'high' } : BASE.reviewer;
                const workers = new Set(modelsOf(after.worker).map(family));
                if (modelsOf(after.reviewer).some(m => workers.has(family(m)))) throw new AiError(422, 'input.invalid', 'reviewer must use a different provider family than worker');
            }
            await db.prepare('INSERT INTO agent_role_defaults (role, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(role) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(role, JSON.stringify(checked), new Date(clock.now()).toISOString());
            await registry.audit(actor.actor, 'agent.role-default.update', 'agent-role', role, { trace: actor.trace, metadata: { before: before[role], after: checked } });
            return checked;
        });
    }
    return { get, put };
}
function controls(body) {
    const out = {};
    for (const k of ['effort', 'agent_role', 'ladder_id', 'rung', 'kind']) if (body[k] !== undefined) out[k] = body[k];
    return out;
}
async function resolve(body, workflow, defaults) {
    const asked = checkEffort(body.effort === undefined ? 'auto' : body.effort);
    if (body.agent_role !== undefined && !ROLES.includes(body.agent_role)) throw new AiError(422, 'input.invalid', 'unknown agent_role');
    if ((body.ladder_id === undefined) !== (body.rung === undefined)) throw new AiError(422, 'input.invalid', 'ladder_id and rung must be supplied together');
    if (body.ladder_id !== undefined && (typeof body.ladder_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.ladder_id) || !Number.isSafeInteger(body.rung) || body.rung < 0)) throw new AiError(422, 'input.invalid', 'invalid ladder_id or rung');
    if (body.kind !== undefined && (typeof body.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(body.kind))) throw new AiError(422, 'input.invalid', 'invalid kind');
    const policy = body.agent_role ? (await defaults.get())[body.agent_role] : null;
    const taskEffort = policy ? policy.effort : workflow.metadata && workflow.metadata.effort || 'medium';
    const resolved = asked === 'auto' ? checkEffort(taskEffort) : asked;
    if (resolved === 'auto') throw new AiError(422, 'input.invalid', 'task default effort cannot itself be auto');
    return { effort_requested: asked, effort_resolved: resolved, ...(policy ? { agent_role: body.agent_role, role_default: policy } : {}), ...(body.ladder_id !== undefined ? { ladder_id: body.ladder_id, effort_rung: body.rung } : {}), ...(body.kind ? { kind: body.kind } : {}) };
}
module.exports = { createDefaults, controls, resolve, ROLES, family, modelsOf };
