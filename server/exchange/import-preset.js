'use strict';
const { normalize, modelName } = require('./compat-routing');
const { AiError } = require('../util');
const accepted = [
    'name',
    'model',
    'models',
    'system',
    'provider',
    'temperature',
    'top_p',
    'max_tokens',
    'seed',
    'response_format',
];
// Import preview is intentionally pure: no keys, URLs, provider calls or writes.
function normalizePreset(source) {
    const bad = (detail) => {
        throw new AiError(400, 'input.invalid', detail);
    };
    if (!source || typeof source !== 'object' || Array.isArray(source))
        bad('A preset must be a JSON object');
    const unsupported = Object.keys(source).filter(
        (k) => !accepted.includes(k),
    );
    if (unsupported.length)
        bad('Preset contains unsupported fields; remove them before importing');
    if (
        typeof source.name !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.name)
    )
        bad('Preset name must be a lowercase slug');
    const out = { name: source.name };
    if (source.model !== undefined) {
        modelName(source.model);
        if (source.model.startsWith('@preset/'))
            bad('Nested presets are not supported');
        out.model = source.model;
    }
    if (source.models !== undefined) {
        if (
            !Array.isArray(source.models) ||
            source.models.length < 1 ||
            source.models.length > 8
        )
            bad('models must contain one to eight model ids');
        source.models.forEach((x) => {
            modelName(x);
            if (x.startsWith('@preset/'))
                bad('Nested presets are not supported');
        });
        out.models = [...new Set(source.models)];
    }
    if (!out.model && !out.models)
        bad('A preset must name a model or fallbacks');
    if (source.provider !== undefined)
        out.provider = normalize(source.provider);
    if (source.system !== undefined) {
        if (typeof source.system !== 'string' || source.system.length > 32000)
            bad('system must be at most 32000 characters');
        out.system = source.system;
    }
    for (const [k, max] of [
        ['temperature', 2],
        ['top_p', 1],
        ['max_tokens', 64000],
    ])
        if (source[k] !== undefined) {
            if (
                !Number.isFinite(source[k]) ||
                source[k] < 0 ||
                source[k] > max ||
                (k === 'max_tokens' &&
                    (!Number.isInteger(source[k]) || source[k] < 1))
            )
                bad('Invalid sampling parameter');
            out[k] = source[k];
        }
    if (source.seed !== undefined) {
        if (!Number.isSafeInteger(source.seed))
            bad('seed must be a safe integer');
        out.seed = source.seed;
    }
    if (source.response_format !== undefined) {
        if (
            !source.response_format ||
            typeof source.response_format !== 'object' ||
            Array.isArray(source.response_format)
        )
            bad('response_format must be an object');
        out.response_format = JSON.parse(
            JSON.stringify(source.response_format),
        );
    }
    return out;
}
function importPreset(source) {
    const out = normalizePreset(source);
    return {
        valid: true,
        fields: Object.keys(out),
        model_count: out.models ? out.models.length : 1,
        warnings: [
            'Preview only: this does not save a preset or make a provider request.',
        ],
    };
}
module.exports = { importPreset, normalizePreset };
