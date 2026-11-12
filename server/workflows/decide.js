'use strict';
/**
 * decide.fallback (2026-11-12): the Decisions API's answer when Google's Decisions API (gemini-decision-1) cannot take a
 * request (no Gemini key, or Google is away). The same closed-set questions about one text input, answered by the
 * router's cheap structured-output route (default.json) as estimated probabilities. They are not calibrated, and the
 * answer says so (calibrated: false); server/api/decisions.js chooses between the two.
 *
 * Question types are Google's: `noul` (yes or no: the probability of yes), `choice` (one of 2-255 named options: the
 * winner and a probability for each) and `score` (an ordered rubric from level 0: the weighted level and a probability
 * for each level). Every answer carries a confidence from 0 to 1.
 */
const MAX_QUESTIONS = 100;

const clamp = (n, lo = 0.01, hi = 0.99) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : 0.5));

/** The model's probabilities -> a normalized distribution over the expected keys (missing ones share what is left). */
function normalized(raw, keys) {
    const vals = keys.map((k) => Math.max(0, Number(raw && raw[k]) || 0));
    const sum = vals.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
    return Object.fromEntries(keys.map((k, i) => [k, Math.round((vals[i] / sum) * 1e4) / 1e4]));
}

/** One question's answer from the model's JSON, in the Decisions API's shape. */
function answerOf(q, raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    if (q.type === 'noul') {
        const p = clamp(a.noul != null ? a.noul : a.probability);
        return { type: 'noul', noul: p, confidence: Math.round(Math.max(p, 1 - p) * 100) / 100 };
    }
    if (q.type === 'choice') {
        const keys = Object.keys(q.criteria || {});
        const probabilities = normalized(a.probabilities, keys);
        const choice = keys.includes(a.choice) ? a.choice : keys.reduce((best, k) => (probabilities[k] > probabilities[best] ? k : best), keys[0]);
        return { type: 'choice', choice, probabilities, confidence: Math.round(Math.max(...Object.values(probabilities)) * 100) / 100 };
    }
    const levels = Array.isArray(q.criteria) ? q.criteria.map((_, i) => String(i)) : [];
    const probabilities = normalized(a.probabilities, levels);
    const score = levels.reduce((s, k) => s + Number(k) * probabilities[k], 0);
    return { type: 'score', score: Math.round(score * 1000) / 1000, probabilities, legend: Object.fromEntries((q.criteria || []).map((c, i) => [String(i), String(c)])),
        confidence: Math.round(Math.max(...Object.values(probabilities), 0) * 100) / 100 };
}

const templates = [{
    key: 'decide.fallback', name: 'Decisions without the Decisions API',
    description: 'Closed-set questions about one input (yes/no, one of a list, a rubric level), each answered with probabilities.',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    system_prompt: 'You judge one input against independent closed-set questions. Answer every question by its name, and only from the input. '
        + 'For "noul" give {"noul": P} where P is the probability (0.01 to 0.99) that the answer is yes. '
        + 'For "choice" give {"choice": "<one option name>", "probabilities": {"<option>": p, …}} over exactly the listed options, summing to 1. '
        + 'For "score" give {"probabilities": {"0": p, "1": p, …}} over the rubric levels, summing to 1. '
        + 'Probabilities say how sure you are: use the middle when the input does not say. Questions cannot see each other. '
        + 'Output only JSON: {"answers": {"<question name>": {…}, …}}.',
    user_prompt: '{{json payload}}',
    default_route: 'decide.fallback', owner: 'ai', metadata: { json_name: 'decisions' },
}];

const workflows = [{
    key: 'decide.fallback', name: 'Decisions (fallback)', namespace: 'ai',
    description: 'The Decisions API\'s fallback: the cheap structured-output route answers closed-set questions about a text input with estimated, uncalibrated probabilities.',
    input_schema: {
        type: 'object', additionalProperties: false, required: ['input', 'questions'],
        properties: {
            input: { type: 'string', minLength: 1, maxLength: 200000 },
            questions: { type: 'object', minProperties: 1, maxProperties: MAX_QUESTIONS },
        },
    },
    output_schema: { type: 'object' },
    steps: [{ kind: 'llm', template: 'decide.fallback', operation: 'classify', output: 'json', prepare: 'decide.fallback', postprocess: 'decide.fallback', params: { max_tokens: 4000, temperature: 0, timeout_ms: 60000 } }],
    cache_mode: 'none',
}];

function prepare(input) {
    const questions = Object.fromEntries(Object.entries(input.questions || {}).map(([name, q]) => [name, {
        type: q.type, instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}),
    }]));
    return { vars: { payload: { input: input.input, questions } } };
}

function postprocess(r, input) {
    const raw = r && r.json && typeof r.json === 'object' ? (r.json.answers || r.json) : {};
    const answers = {};
    for (const [name, q] of Object.entries(input.questions || {})) answers[name] = answerOf(q, raw[name]);
    return { answers, calibrated: false };
}

module.exports = { templates, workflows, prepare, postprocess, answerOf, MAX_QUESTIONS };
