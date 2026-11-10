'use strict';

/**
 * The 18+ board's published data and its objective arithmetic.
 *
 * The prompt set, the base/abliterated pairs and the objective benchmark set are data files, not code,
 * so the exact questions that produce a rate can be read from the repository. This module loads and
 * checks them once, and exports the classifiers and the intervals from classify.js.
 */

const promptsData = require('./datasets/prompts.json');
const pairsData = require('./datasets/abliteration-pairs.json');
const objectiveData = require('./datasets/objective-set.json');
const classify = require('./classify');

const PROMPT_SET_VERSION = promptsData.version;
const PROMPTS = Object.freeze(promptsData.prompts.map((p) => Object.freeze({ id: p.id, category: p.category, prompt: p.prompt })));
const CATEGORIES = Object.freeze({ ...promptsData.categories });
const SYSTEM = promptsData.system;
const REVIEW = Object.freeze({ ...promptsData.review });
const PAIRS = Object.freeze(pairsData.pairs.map((p) => Object.freeze({
    id: p.id, family: p.family, base: Object.freeze({ ...p.base }),
    abliterated: Object.freeze({ ...p.abliterated }), source: p.source, note: p.note,
})));
const PAIRS_VERSION = pairsData.version;
const OBJECTIVE = Object.freeze(objectiveData.items.map((i) => Object.freeze({ ...i })));
const OBJECTIVE_VERSION = objectiveData.version;

/** The data files are the contract: fail the boot, not a measurement, when one is malformed. */
function validate() {
    if (!/^willing-\d{4}-\d{2}-\d{2}\.v\d+$/.test(PROMPT_SET_VERSION)) throw new Error(`willing prompt set version is malformed: ${PROMPT_SET_VERSION}`);
    if (PROMPTS.length !== 60) throw new Error(`the willing prompt set must hold 60 prompts, not ${PROMPTS.length}`);
    if (new Set(PROMPTS.map((p) => p.id)).size !== PROMPTS.length) throw new Error('the willing prompt set has a duplicate id');
    for (const p of PROMPTS) {
        if (!p.prompt || p.prompt.length > 2000) throw new Error(`willing prompt ${p.id} is empty or too long`);
        if (!Object.prototype.hasOwnProperty.call(CATEGORIES, p.category)) throw new Error(`willing prompt ${p.id} has an unknown category ${p.category}`);
    }
    for (const [category, text] of Object.entries(CATEGORIES)) {
        const count = PROMPTS.filter((p) => p.category === category).length;
        if (count < 1) throw new Error(`willing category ${category} has no prompts (${String(text).slice(0, 40)})`);
    }
    if (!REVIEW || !Array.isArray(REVIEW.reviewed_against) || REVIEW.reviewed_against.length < 2) throw new Error('the willing prompt set is missing its policy review');
    if (!Array.isArray(PAIRS) || !PAIRS.length) throw new Error('the abliteration pair file is empty');
    for (const pair of PAIRS) {
        if (!pair.id || !pair.base || !pair.base.provider || !pair.base.model || !pair.abliterated || !pair.abliterated.provider || !pair.abliterated.model) throw new Error(`abliteration pair ${pair.id} is incomplete`);
        if (!/^https:\/\//.test(String(pair.source || ''))) throw new Error(`abliteration pair ${pair.id} has no https source link`);
    }
    if (!Array.isArray(OBJECTIVE) || OBJECTIVE.length < 20) throw new Error(`the objective set must hold at least 20 items, not ${OBJECTIVE.length}`);
    for (const item of OBJECTIVE) {
        if (!item.id || !item.prompt || !['number', 'exact', 'contains', 'all', 'any', 'json'].includes(item.match)) throw new Error(`objective item ${item.id} is malformed`);
    }
}

validate();

const TOKENS_PER_CHAR = 4;
const DEFAULT_OUTPUT_TOKENS = 256;

/** A deliberately rough token estimate: the plan's number can be audited, not a bill. */
const estimateTokens = (text) => Math.max(1, Math.ceil(String(text == null ? '' : text).length / TOKENS_PER_CHAR));

/** The input tokens of one prompt with the published system line. */
const promptTokens = (prompt, system = SYSTEM) => estimateTokens(prompt) + estimateTokens(system);

/** The price of one answer from a per-million rate card. A missing or non-finite price is null, never zero. */
function costOf(price, inputTokens, outputTokens = DEFAULT_OUTPUT_TOKENS) {
    const inRate = price && Number(price.in);
    const outRate = price && Number(price.out);
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;
    return Math.round(((Math.max(0, inputTokens) * inRate + Math.max(0, outputTokens) * outRate) / 1e6) * 1e6) / 1e6;
}

/** The token counts and cost of asking every prompt once. */
function setCost({ prompts = PROMPTS, price, outputTokens = DEFAULT_OUTPUT_TOKENS } = {}) {
    const inputTokens = prompts.reduce((n, p) => n + promptTokens(p.prompt), 0);
    const output = prompts.length * Math.max(1, Number(outputTokens) || DEFAULT_OUTPUT_TOKENS);
    return { prompts: prompts.length, input_tokens: inputTokens, output_tokens: output, estimated_cost_usd: costOf(price, inputTokens, output) };
}

/** Round a money amount to the micro-dollar, or null. */
const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1e6) / 1e6);

module.exports = {
    PROMPT_SET_VERSION, PROMPTS, CATEGORIES, SYSTEM, REVIEW,
    PAIRS, PAIRS_VERSION, OBJECTIVE, OBJECTIVE_VERSION,
    DEFAULT_OUTPUT_TOKENS, estimateTokens, promptTokens, costOf, setCost, money,
    ...classify,
};
