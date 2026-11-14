'use strict';
/**
 * The owner's decisions settings (2026-11-14): per kind, the model that answers, the ladder to escalate
 * along and the confidence below which an answer is escalated. They live on openvibe-shared/config in AI's own
 * namespace (ai.decisions) — the same store and the same vault the rest of the owner's settings use.
 *
 *   <kind>.default_model   the model that answers this kind of question (unset: today's order)
 *   <kind>.ladder          the models to escalate along, in order (unset: the cheapest available first)
 *   <kind>.threshold       the confidence below which the answer is escalated (0.75)
 *
 * The kinds are the ones a caller names: routing, moderation, grading, tool_choice and other.
 */
const { createConfigStore } = require('openvibe-shared/config');
const { AiError } = require('../util');

const NAMESPACE = 'ai.decisions';
const SERVICE = 'ai';
const GROUP = 'Decisions';

/** The kinds of decision a caller may name. */
const KINDS = Object.freeze(['routing', 'moderation', 'grading', 'tool_choice', 'other']);
/** The confidence a non-calibrated answer must reach before it is trusted (the owner's seed). */
const DEFAULT_THRESHOLD = 0.75;
const MAX_LADDER = 20;

const KIND_WORDS = {
    routing: 'routing a request to the right model or person',
    moderation: 'checking a post, a comment or a message',
    grading: 'grading an answer, a submission or a test',
    tool_choice: 'choosing which tool or model to use next',
    other: 'any other question',
};

/** The owner rows of one kind: the model, the ladder and the threshold. */
function kindProperties(kind) {
    const what = KIND_WORDS[kind] || KIND_WORDS.other;
    return {
        [kind + '.default_model']: {
            type: 'string', maxLength: 200, title: 'The model that answers ' + what, 'x-group': GROUP,
            description: 'The model that answers this kind of question. Leave it empty and OpenVibe picks the best available one, as it does today. The list of models is at GET /api/v1/decisions/models.',
            'x-owner-input': {
                group: 'ai-providers',
                unlocks: 'Lets one model answer every ' + what + ' question, with the price and speed of that model instead of the one OpenVibe would pick.',
                get_it_how: 'Pick a model from the Decisions step of the AI setup; the list shows its price, its measured speed and whether its answers are calibrated.',
                test: false,
            },
        },
        [kind + '.ladder']: {
            type: 'array', maxItems: MAX_LADDER, items: { type: 'string', maxLength: 200 },
            title: 'The models to escalate along for ' + what, 'x-group': GROUP, 'x-advanced': true,
            description: 'When the first answer is not sure enough, the next model in this list is asked. Leave it empty and OpenVibe escalates to the cheapest available model first.',
        },
        [kind + '.threshold']: {
            type: 'number', minimum: 0, maximum: 1, 'x-group': GROUP,
            title: 'How sure an answer must be for ' + what, 'x-example': DEFAULT_THRESHOLD,
            description: 'Below this confidence (0 to 1, 0.75 by default) the question is asked again of the next model in the ladder. A calibrated answer is never escalated.',
        },
    };
}

/** The schema of the ai.decisions namespace. */
const DECISIONS_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Decisions',
    description: 'Which model answers a routing, moderation, grading or tool-choice question, which model is asked when the answer is not sure enough, and how sure "sure enough" is.',
    type: 'object',
    additionalProperties: false,
    properties: Object.assign({}, ...KINDS.map((k) => kindProperties(k))),
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);

/**
 * The decisions store: the owner's per-kind settings, read and written through the shared config store.
 */
async function createDecisionsSettings({ db, env = process.env, log = console, onChange } = {}) {
    const store = await createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: DECISIONS_SCHEMA, env, log, onChange,
    });

    /** The owner's settings, per kind, with the defaults filled in. */
    function values() {
        const v = store.get() || {};
        const out = {};
        for (const kind of KINDS) {
            out[kind] = {
                default_model: str(v[kind + '.default_model']) || null,
                ladder: list(v[kind + '.ladder']),
                threshold: num(v[kind + '.threshold'], DEFAULT_THRESHOLD),
            };
        }
        return out;
    }

    /** One kind's settings. */
    function of(kind) {
        const all = values();
        return all[kind] || all.other;
    }

    /**
     * Save one kind's settings. An empty value clears the key, so "the route picks for itself again" is
     * one click and not a special value.
     */
    async function set(kind, patch = {}, { actor, reason } = {}) {
        if (!KINDS.includes(kind)) throw new AiError(404, 'decisions.kind_unknown', 'no decision kind ' + kind + ': use ' + KINDS.join(', '));
        const valuesToWrite = {};
        const unset = [];
        if (patch.default_model !== undefined) {
            const model = patch.default_model == null ? '' : str(patch.default_model);
            if (!model) unset.push(kind + '.default_model');
            else {
                if (model.length > 200) throw new AiError(422, 'decisions.model_invalid', 'a model id is at most 200 characters');
                valuesToWrite[kind + '.default_model'] = model;
            }
        }
        if (patch.ladder !== undefined) {
            const ladder = list(patch.ladder);
            if (ladder.length > MAX_LADDER) throw new AiError(422, 'decisions.ladder_invalid', 'a ladder holds at most ' + MAX_LADDER + ' models');
            for (const m of ladder) if (m.length > 200) throw new AiError(422, 'decisions.ladder_invalid', 'a model id is at most 200 characters');
            if (!ladder.length) unset.push(kind + '.ladder');
            else valuesToWrite[kind + '.ladder'] = ladder;
        }
        if (patch.threshold !== undefined) {
            const t = Number(patch.threshold);
            if (!Number.isFinite(t) || t < 0 || t > 1) throw new AiError(422, 'decisions.threshold_invalid', 'the threshold is a confidence from 0 to 1');
            valuesToWrite[kind + '.threshold'] = t;
        }
        if (!Object.keys(valuesToWrite).length && !unset.length) return of(kind);
        await store.apply(valuesToWrite, { merge: true, unset, actor, reason });
        return of(kind);
    }

    return { store, proxy: store, namespace: NAMESPACE, values, of, set, get sealed() { return Boolean(store.sealed); } };
}

module.exports = { createDecisionsSettings, DECISIONS_SCHEMA, NAMESPACE, SERVICE, KINDS, DEFAULT_THRESHOLD, MAX_LADDER };
