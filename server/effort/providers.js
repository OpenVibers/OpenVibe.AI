'use strict';
const { AiError } = require('../util');
const LEVELS = ['auto', 'low', 'medium', 'high', 'max'];
const TEXT = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages'];
function checkEffort(value) {
    if (!LEVELS.includes(value)) throw new AiError(422, 'input.invalid', `effort must be ${LEVELS.join('|')}`);
    return value;
}
// Verified against the providers' own documentation, 2026-11-09. Token budgets below
// are OpenVibe policy, not provider presets. Unknown models/providers receive no control.
function control({ kind, key = '', model = '', base_url = '' }, effort) {
    if (effort == null) return { applied: null, fields: {} };
    checkEffort(effort);
    if (effort === 'auto') throw new AiError(422, 'input.invalid', 'resolve auto against task defaults before calling a provider');
    const m = String(model).replace(/^models\//, '').toLowerCase();
    const source = `${key} ${base_url}`.toLowerCase();
    // https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat
    if (['openai', 'responses'].includes(kind) && /openai|api\.openai\.com/.test(source) && /^(gpt-[56]|o[134])/.test(m) && !/chat|non-reasoning/.test(m)) {
        const native = effort !== 'max' ? effort : /^gpt-6/.test(m) ? 'max' : /^gpt-5\.[2-9]/.test(m) ? 'xhigh' : 'high';
        return { applied: effort === 'max' && native === 'high' ? 'high' : effort, fields: kind === 'responses' ? { reasoning: { effort: native } } : { reasoning_effort: native } };
    }
    // https://platform.claude.com/docs/en/build-with-claude/thinking
    // https://platform.claude.com/docs/en/build-with-claude/effort
    if (kind === 'anthropic' && /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])\b/.test(m)) {
        return { applied: effort, fields: { thinking: { type: 'adaptive' }, output_config: { effort } } };
    }
    // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
    if (kind === 'gemini' && /^gemini-[234]/.test(m)) {
        if (/^gemini-[34]/.test(m)) {
            const level = effort === 'max' ? 'high' : effort === 'medium' && /^gemini-3-pro/.test(m) ? 'high' : effort;
            return { applied: level, fields: { generationConfig: { thinkingConfig: { thinkingLevel: level.toUpperCase() } } } };
        }
        if (/^gemini-2\.5/.test(m)) return { applied: effort, fields: { generationConfig: { thinkingConfig: { thinkingBudget: { low: 1024, medium: 4096, high: 16384, max: /pro/.test(m) ? 32768 : 24576 }[effort] } } } };
    }
    // https://www.alibabacloud.com/help/en/model-studio/deep-thinking
    if (kind === 'openai' && /qwen|dashscope/.test(source) && /^qwen3/.test(m) && !/omni|coder|instruct/.test(m)) {
        const only = /thinking|2\.4t/.test(m);
        return { applied: effort, fields: { ...(!only ? { enable_thinking: effort !== 'low' } : {}), ...(only || effort !== 'low' ? { thinking_budget: { low: 1024, medium: 4096, high: 16384, max: 32768 }[effort] } : {}) } };
    }
    // https://api-docs.deepseek.com/guides/thinking_mode/
    if (['openai', 'anthropic'].includes(kind) && /deepseek/.test(source) && /^deepseek-(v[34]|chat|reasoner|flash|pro)/.test(m)) {
        return { applied: effort === 'low' ? 'low' : 'medium', fields: { thinking: { type: effort === 'low' ? 'disabled' : 'enabled' } } };
    }
    return { applied: null, fields: {} };
}
function apply(body, req, fallback) {
    const c = req._effortControl || control({ ...fallback, model: req.model }, req.effort);
    if (/^claude-(opus|sonnet)-5-5/.test(req.model || '') && req.thinking && Object.hasOwn(req.thinking, 'budget_tokens')) {
        throw new AiError(422, 'input.invalid', 'Opus/Sonnet 5.5 require adaptive thinking; budget_tokens is refused');
    }
    for (const [key, value] of Object.entries(c.fields)) body[key] = typeof value === 'object' ? { ...(body[key] || {}), ...value } : value;
    return body;
}
function wrapAdapter(adapter, record) {
    for (const op of TEXT) if (typeof adapter[op] === 'function') {
        const call = adapter[op];
        adapter[op] = async (req) => {
            const c = control({ ...record, kind: adapter.kind, model: req.model }, req.effort);
            const result = await call({ ...req, _effortControl: c });
            return { ...result, effortApplied: c.applied };
        };
    }
    return adapter;
}
module.exports = { LEVELS, checkEffort, control, apply, wrapAdapter };
