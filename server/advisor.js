'use strict';
/**
 * The advisor (ai.advisor@1, plan AL3): a run on a cheap executor model may ask a stronger model for advice
 * mid-run. The executor sends its transcript and a question; the advisor sees the transcript, runs without
 * tools and answers in at most 100 words. At most 3 uses per run, and each use is recorded on the run's
 * receipt with the advice run, the model, the tokens and the cost.
 *
 * Off unless the run request asks: `advisor: true` takes the defaults, an object may name a model, an effort
 * and smaller caps. No environment switch enables it. The advice is a run of workflow ai.chat on a pinned
 * offer, so it has the ordinary receipt, quota and usage record. The executor stays in charge: the answer is
 * guidance the caller feeds back into its own loop, never an answer to its task.
 */
const { AiError } = require('./util');

const MAX_USES = 3;
const MAX_WORDS = 100;
const MIN_WORDS = 10;
const EFFORTS = ['low', 'medium', 'high', 'max'];
// The workflows whose executor can ask: the OpenAI-compatible completion, the chat passthrough and the
// Anthropic-compatible messages run. A product workflow with its own output schema is not an executor.
const EXECUTORS = new Set(['ai.complete', 'ai.chat', 'ai.messages']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const DEFAULT_PROMPT = 'You are the advisor to the executor that is doing this work. You see its transcript. Give concrete guidance it can act on now: what to do next, what to avoid, and what to check before it declares the work done. Do not restate the task, do not write the answer for it, and do not use tools.';

/** The advisor value on a run request: top-level `advisor`, or `options.advisor` (the compat endpoints pass it there). */
function rawOf(body) {
    if (!body || typeof body !== 'object') return undefined;
    if (body.advisor !== undefined) return body.advisor;
    if (body.options && typeof body.options === 'object' && body.options.advisor !== undefined) return body.options.advisor;
    return undefined;
}

/**
 * Parse and validate the request's advisor control. Returns { enabled: false } when it was not asked for.
 * A refusal is 422 before the run exists, so a bad cap never spends.
 */
function policy(body, wf) {
    const raw = rawOf(body);
    if (raw === undefined || raw === null || raw === false) return { enabled: false };
    if (raw !== true && (typeof raw !== 'object' || Array.isArray(raw))) throw new AiError(422, 'input.invalid', 'advisor must be true or an object with model, effort, max_uses and max_words');
    if (raw === true && (!wf || !EXECUTORS.has(wf.key))) throw new AiError(422, 'input.invalid', 'advisor is available on ai.complete, ai.chat and ai.messages runs');
    if (raw !== true && (!wf || !EXECUTORS.has(wf.key))) throw new AiError(422, 'input.invalid', 'advisor is available on ai.complete, ai.chat and ai.messages runs');
    const out = { enabled: true, max_uses: MAX_USES, max_words: MAX_WORDS, effort: 'high' };
    if (raw === true) return out;
    for (const key of Object.keys(raw)) if (!['model', 'effort', 'max_uses', 'max_words'].includes(key)) throw new AiError(422, 'input.invalid', `advisor has no field ${key}`);
    if (raw.model !== undefined) {
        if (typeof raw.model !== 'string' || !MODEL_RE.test(raw.model.trim())) throw new AiError(422, 'input.invalid', 'advisor.model must be provider/model from GET /api/v1/routes');
        out.model = raw.model.trim();
    }
    if (raw.effort !== undefined) {
        if (!EFFORTS.includes(raw.effort)) throw new AiError(422, 'input.invalid', 'advisor.effort must be low|medium|high|max');
        out.effort = raw.effort;
    }
    if (raw.max_uses !== undefined) {
        if (!Number.isInteger(raw.max_uses) || raw.max_uses < 1 || raw.max_uses > MAX_USES) throw new AiError(422, 'input.invalid', `advisor.max_uses must be an integer from 1 to ${MAX_USES}`);
        out.max_uses = raw.max_uses;
    }
    if (raw.max_words !== undefined) {
        if (!Number.isInteger(raw.max_words) || raw.max_words < MIN_WORDS || raw.max_words > MAX_WORDS) throw new AiError(422, 'input.invalid', `advisor.max_words must be an integer from ${MIN_WORDS} to ${MAX_WORDS}`);
        out.max_words = raw.max_words;
    }
    return out;
}

/** The transcript a caller sends: 1 to 200 messages, text only, bounded so one advice call cannot carry a whole repo. */
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
function transcript(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new AiError(422, 'input.invalid', 'transcript must be 1 to 200 messages');
    let total = 0;
    return value.map((m) => {
        if (!m || typeof m !== 'object' || !ROLES.has(m.role)) throw new AiError(422, 'input.invalid', 'each transcript message needs a role (system, user, assistant, tool)');
        if (typeof m.content !== 'string' || !m.content.trim()) throw new AiError(422, 'input.invalid', 'each transcript message needs text content');
        total += m.content.length;
        if (total > 300000) throw new AiError(413, 'input.too_large', 'the transcript is larger than 300000 characters');
        return { role: m.role, content: m.content.slice(0, 200000) };
    });
}

/** Cut to at most n words; never cut mid-word. */
function words(text, n) {
    const list = String(text || '').trim().split(/\s+/).filter(Boolean);
    return { text: list.slice(0, n).join(' '), count: Math.min(list.length, n) };
}

/** The messages of an ai.chat run: the advisor prompt and the transcript flattened to user/assistant turns. */
function messagesFor(transcriptList, question, maxWords) {
    const system = [];
    const messages = [];
    const push = (role, content) => {
        if (!content) return;
        const last = messages[messages.length - 1];
        if (last && last.role === role) last.content += `\n\n${content}`;
        else messages.push({ role, content });
    };
    for (const m of transcriptList) {
        if (m.role === 'system') { system.push(m.content); continue; }
        if (m.role === 'tool') { push('user', `Tool result:\n${m.content}`); continue; }
        push(m.role === 'assistant' ? 'assistant' : 'user', m.content);
    }
    const ask = question && String(question).trim() ? String(question).trim() : 'Given the transcript, what should the executor do next, and what should it check before declaring the work done?';
    push('user', `${ask}\n\nAnswer with at most ${maxWords} words of concrete guidance only.`);
    return { system: [DEFAULT_PROMPT, ...system].join('\n\n'), messages };
}

/** The receipt/explain block for a set of uses (the run's receipt and explain carry the same object). */
function summary(uses, policy) {
    const list = uses || [];
    return {
        max_uses: policy.max_uses,
        max_words: policy.max_words,
        count: list.length,
        cost_usd: Math.round(list.reduce((n, u) => n + Number(u.cost_usd || 0), 0) * 1e8) / 1e8,
        uses: list,
    };
}

module.exports = { policy, transcript, words, messagesFor, summary, MAX_USES, MAX_WORDS, MIN_WORDS, EFFORTS, EXECUTORS };
