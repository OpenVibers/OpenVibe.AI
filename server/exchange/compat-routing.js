'use strict';
const { AiError } = require('../util');
const sorts = ['price', 'throughput', 'latency', 'quality', 'value'];
const fields = [
    'order',
    'only',
    'ignore',
    'allow_fallbacks',
    'sort',
    'max_price',
    'data_collection',
    'zdr',
];
const bad = (message) => {
    throw new AiError(400, 'input.invalid', message);
};
function normalize(provider = {}) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider))
        bad('provider must be an object');
    for (const key of Object.keys(provider))
        if (!fields.includes(key))
            bad('Unsupported provider parameter');
    const out = {};
    for (const key of ['order', 'only', 'ignore'])
        if (provider[key] !== undefined) {
            if (
                !Array.isArray(provider[key]) ||
                provider[key].length > 64 ||
                provider[key].some(
                    (x) =>
                        typeof x !== 'string' ||
                        !/^[a-zA-Z0-9._-]{1,100}$/.test(x),
                )
            )
                bad(`provider.${key} must be a list of provider ids`);
            out[key] = [...new Set(provider[key])];
        }
    for (const key of ['allow_fallbacks', 'zdr'])
        if (provider[key] !== undefined) {
            if (typeof provider[key] !== 'boolean')
                bad(`provider.${key} must be boolean`);
            out[key] = provider[key];
        }
    if (provider.sort !== undefined) {
        if (!sorts.includes(provider.sort)) bad('Unknown provider.sort');
        out.sort = provider.sort;
    }
    if (provider.data_collection !== undefined) {
        if (!['allow', 'deny'].includes(provider.data_collection))
            bad('Unknown data_collection policy');
        out.data_collection = provider.data_collection;
    }
    if (provider.max_price !== undefined) {
        const p = provider.max_price;
        if (
            !p ||
            typeof p !== 'object' ||
            Array.isArray(p) ||
            Object.keys(p).some((k) => !['prompt', 'completion'].includes(k))
        )
            bad(
                'max_price accepts prompt and completion in USD per million tokens',
            );
        out.max_price = {};
        for (const [k, v] of Object.entries(p)) {
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
                bad('Prices must be finite nonnegative numbers');
            out.max_price[k] = v;
        }
    }
    return out;
}
function modelName(value) {
    if (typeof value !== 'string' || !value || value.length > 256)
        bad('model must be a model id');
    const m = /:(free|floor|nitro|online)$/.exec(value);
    return {
        model: m ? value.slice(0, -m[0].length) : value,
        variant: m?.[1] || null,
    };
}
function policyFor(body) {
    const { model, variant } = modelName(body.model || 'openvibe/auto');
    const policy = normalize(body.provider);
    if (variant === 'free') policy.max_price = { prompt: 0, completion: 0 };
    if (variant === 'floor') policy.sort = 'price';
    if (variant === 'nitro') policy.sort = 'throughput';
    return { model, variant, policy };
}
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
async function select(list, policy, facts) {
    const ranked = [],
        excluded = [];
    for (const [index, candidate] of list.entries()) {
        const f = await facts(candidate),
            id = candidate.provider;
        let reason = null;
        if (policy.only && !policy.only.includes(id)) reason = 'provider.only';
        if (policy.ignore?.includes(id)) reason = 'provider.ignore';
        if (policy.data_collection === 'deny' && f.training !== false)
            reason = 'provider.data_collection';
        if (policy.zdr && f.retention !== 'none') reason = 'provider.zdr';
        for (const [key, fact] of [
            ['prompt', 'priceIn'],
            ['completion', 'priceOut'],
        ])
            if (
                policy.max_price?.[key] !== undefined &&
                (!finite(f[fact]) || f[fact] > policy.max_price[key])
            )
                reason = 'provider.max_price';
        const cost =
            finite(f.priceIn) && finite(f.priceOut)
                ? f.priceIn + f.priceOut
                : null;
        let score = 0;
        if (policy.sort === 'price') score = cost ?? Infinity;
        if (policy.sort === 'latency') {
            if (!finite(f.latency)) reason = 'provider.latency_unavailable';
            score = finite(f.latency) ? f.latency : Infinity;
        }
        if (policy.sort === 'throughput') {
            if (!finite(f.throughput))
                reason = 'provider.throughput_unavailable';
            score = finite(f.throughput) ? -f.throughput : Infinity;
        }
        if (policy.sort === 'quality' || policy.sort === 'value') {
            if (!finite(f.quality)) reason = 'provider.rating_unavailable';
            score =
                policy.sort === 'quality'
                    ? -f.quality
                    : cost === null
                      ? Infinity
                      : -(f.quality / Math.max(cost, 0.000001));
        }
        if (reason)
            excluded.push({ provider: id, model: candidate.model, reason });
        else
            ranked.push({
                candidate,
                score,
                index,
                order: policy.order?.includes(id)
                    ? policy.order.indexOf(id)
                    : Infinity,
            });
    }
    ranked.sort(
        (a, b) => a.order - b.order || a.score - b.score || a.index - b.index,
    );
    const allowed = ranked.map((x) => x.candidate);
    return {
        allowed:
            policy.allow_fallbacks === false ? allowed.slice(0, 1) : allowed,
        excluded,
    };
}
// Validated once at admission, retained in the run input and never forwarded upstream.
function request(body) {
    if (body.models !== undefined && (!Array.isArray(body.models) || !body.models.length || body.models.length > 8))
        bad('models must contain one to eight model ids');
    const names = [...new Set([...(body.model ? [body.model] : []), ...(body.models || [])])];
    if (names.length > 8) bad('At most eight distinct models are supported');
    const entries = (names.length ? names : ['openvibe/auto']).map(modelName);
    const policy = normalize(body.provider);
    return { entries, policy };
}
module.exports = { normalize, policyFor, modelName, select, request };
