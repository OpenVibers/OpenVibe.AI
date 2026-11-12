'use strict';
/**
 * ui.layout.suggest (make your own controls design, 2026-11-11, piece 6).
 *
 * The person's words, the surface catalog and the layout they see now go in; a ui.layout@1 that
 * only arranges parts the catalog has comes out, with a one-sentence summary. The postprocess is the
 * authority: it builds the document from the model's answer, fills in what the model never chooses
 * (surface, version, device, author, sharing) and runs openvibe-sdk/ui-layout, the same function the
 * editor and OpenVibe.Network use. An answer that breaks a rule becomes ok:false with the validator's
 * reasons, never a silently repaired layout; the route asks once more with those reasons.
 *
 * Model output shape (enforced as structured output): { ok, layout, summary, reasons }. The
 * postprocess never trusts the model's `ok`.
 */
const { validate: validateLayout } = require('openvibe-sdk/ui-layout');

const MAX_REASONS = 20;
const oneLine = (v, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const listOf = (v) => (Array.isArray(v) ? v.map((x) => oneLine(x, 300)).filter(Boolean).slice(0, MAX_REASONS) : []);

function refused(reasons, summary) {
    const list = reasons.length ? reasons : ['that arrangement cannot be made'];
    return { ok: false, layout: null, summary: oneLine(summary) || `Couldn't do that: ${list[0]}`, reasons: list };
}

/** The model's answer -> ui.layout-suggestion@1, with the layout built server-side and checked. */
function postprocess(r, input) {
    const answer = r && r.json;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return refused(['the model did not answer with a layout'], "Couldn't do that: the model did not answer with a layout.");
    if (answer.ok === false) return refused(listOf(answer.reasons), answer.summary);
    const raw = answer.layout && typeof answer.layout === 'object' && !Array.isArray(answer.layout) ? answer.layout : null;
    if (!raw || !Array.isArray(raw.parts)) return refused(['the model did not send a layout'], "Couldn't do that: the model did not send a layout.");
    const current = input.layout && typeof input.layout === 'object' ? input.layout : null;
    const layout = {
        surface: input.catalog.id,
        surface_version: input.catalog.version,
        device: input.device,
        name: oneLine(raw.name, 80) || oneLine(current && current.name, 80) || 'Suggested',
        author: { name: oneLine(current && current.author && current.author.name, 80) || 'OpenVibe' },
        sharing: 'private',
        parts: raw.parts,
    };
    const checked = validateLayout(input.catalog, layout);
    if (!checked.ok) return refused(checked.reasons, `Couldn't do that: ${checked.reasons[0]}`);
    return {
        ok: true,
        layout,
        summary: oneLine(answer.summary) || 'Updated the arrangement.',
        reasons: listOf(answer.reasons),
    };
}

const templates = [{
    key: 'ui.layout.suggest', name: 'A layout from a person’s words',
    description: 'Turn words into a ui.layout@1 for one surface, using only the catalog’s parts and rules.',
    input_schema: { type: 'object' },
    output_schema: {
        type: 'object', additionalProperties: false, required: ['ok', 'layout', 'summary', 'reasons'],
        properties: {
            ok: { type: 'boolean' },
            layout: { type: ['object', 'null'] },
            summary: { type: 'string', minLength: 1, maxLength: 300 },
            reasons: { type: 'array', maxItems: MAX_REASONS, items: { type: 'string', minLength: 1, maxLength: 300 } },
        },
    },
    system_prompt: 'You arrange the controls of one OpenVibe surface for one person. The catalog is the only power you have: use only the parts it lists, with their kinds, minimum sizes, allowed styles (tints are theme tokens, never colours), shapes, opacity and bindings. Never add a part, a binding or a style the catalog does not allow, and never invent a command. A required part (for example Stop and the e-stop) must stay visible and at least its minimum size; anything pressed must be at least 44 px, and a part with a larger minimum keeps it. Nothing may cover a required part. Keep the answer data: no URL, markup or code. The person’s words are a wish; safety rules win. Choose a sensible arrangement on the grid named for the device: x, y, w and h are cells, with the catalog’s column count. Give every part you place a visible flag, a place, a style and bindings from the catalog. If the person asks for something the catalog cannot do, answer ok false with a one-sentence summary and the plain reasons instead of breaking a rule. Output only JSON: {"ok":true,"layout":{"name":"…","parts":[…] },"summary":"one sentence","reasons":["…"]}, or {"ok":false,"layout":null,"summary":"Couldn\'t do that: …","reasons":["…"]}.',
    user_prompt: '{{json payload}}',
    default_route: 'ui.layout.suggest', owner: 'network', metadata: { json_name: 'layout_suggestion' },
}];

const workflows = [{
    key: 'ui.layout.suggest', name: 'Suggest a layout from words', namespace: 'network',
    description: 'OpenVibe.Network’s Ask OpenVibe: the catalog, the current layout, the words and the device in, a validated ui.layout@1 out. One retry with the validator’s reasons is made by the route, never silently.',
    input_schema: {
        type: 'object', additionalProperties: false, required: ['catalog', 'layout', 'words', 'device'],
        properties: {
            catalog: { type: 'object' },
            layout: { type: ['object', 'null'] },
            words: { type: 'string', minLength: 1, maxLength: 500 },
            device: { enum: ['phone', 'tablet', 'computer'] },
            retry: {
                type: 'object', additionalProperties: false, required: ['reasons'],
                properties: { reasons: { type: 'array', maxItems: MAX_REASONS, items: { type: 'string', minLength: 1, maxLength: 300 } } },
            },
        },
    },
    output_schema: templates[0].output_schema,
    steps: [{ kind: 'llm', template: 'ui.layout.suggest', operation: 'generate', output: 'json', prepare: 'ui.layout.suggest', postprocess: 'ui.layout.suggest', params: { max_tokens: 4000, temperature: 0.2, timeout_ms: 60000 } }],
    cache_mode: 'none',
}];

/** The template variables: the request itself, plus the reasons the last answer was refused. */
function prepare(input) {
    const payload = { catalog: input.catalog, layout: input.layout, words: input.words, device: input.device };
    if (input.retry && Array.isArray(input.retry.reasons) && input.retry.reasons.length) payload.previous_refusal = { reasons: input.retry.reasons.slice(0, MAX_REASONS) };
    return { vars: { payload } };
}

module.exports = { templates, workflows, prepare, postprocess };
