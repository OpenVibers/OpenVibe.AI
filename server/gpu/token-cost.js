'use strict';
/**
 * What a catalogued model costs per token on a rented GPU.
 *
 *   hourly price from the public marketplace readings (server/gpu/market.js)
 *   × 1,000,000 / the model's tokens per hour (the catalog's planning estimate)
 *   = USD per million output tokens
 *
 * Beside it is the cheapest published API price for the same or a comparable model, so the owner can see
 * whether the rent is cheaper than buying the tokens. The comparison is deliberately narrow: the exact model
 * first, then the same family (with the same uncensored/standard weights when both say), then any priced model
 * with the same weights. If nothing comparable is priced, there is no comparison rather than a misleading one.
 */
const { list: catalogModels } = require('./catalog');

const THROUGHPUT_SOURCE = 'catalog planning estimate (server/gpu/catalog.js)';

function number(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function nameOf(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
}

/**
 * The cheapest priced API model comparable with one catalog model.
 * → `{ ...model, match }` or null.
 */
function cheapestComparable(spec, models = []) {
    const sameKeys = new Set([spec.key, spec.model_key, ...(Array.isArray(spec.api_comparables) ? spec.api_comparables : [])].filter(Boolean));
    const family = spec.family ? String(spec.family).toLowerCase() : null;
    const uncensored = spec.uncensored === true || spec.uncensored === false ? Boolean(spec.uncensored) : null;
    const ranked = [];
    for (const model of models) {
        if (!model || String(model.provider_key || '').startsWith('gpu.')) continue;
        const out = number(model.cost && model.cost.out_per_mtok);
        if (out === null || out < 0) continue;
        const modelFamily = model.family ? String(model.family).toLowerCase() : null;
        const modelUncensored = model.uncensored === true || model.uncensored === false ? Boolean(model.uncensored) : null;
        let match = null;
        let score = 4;
        if (sameKeys.has(model.model_key)) { match = 'same_model'; score = 0; }
        else if (family && modelFamily === family) {
            if (uncensored !== null && modelUncensored === uncensored) { match = 'same_family_weights'; score = 1; }
            else { match = 'same_family'; score = 2; }
        }
        else if (uncensored === true && modelUncensored === true) { match = 'uncensored'; score = 3; }
        if (score === 4) continue;
        ranked.push({ ...model, match, score, out_per_mtok: out, in_per_mtok: number(model.cost && model.cost.in_per_mtok) });
    }
    ranked.sort((a, b) => a.score - b.score || a.out_per_mtok - b.out_per_mtok || String(a.model_key).localeCompare(String(b.model_key)));
    const best = ranked[0];
    if (!best) return null;
    return {
        model_key: best.model_key,
        display_name: best.display_name || best.model_key,
        provider_key: best.provider_key,
        family: best.family || null,
        uncensored: best.uncensored === true || best.uncensored === false ? Boolean(best.uncensored) : null,
        in_per_mtok: best.in_per_mtok,
        out_per_mtok: best.out_per_mtok,
        usd_per_million_output_tokens: best.out_per_mtok,
        usd_per_million_input_tokens: best.in_per_mtok,
        match: best.match,
        source: (best.cost && best.cost.source) || best.source || null,
    };
}

/**
 * One row per catalog model, GPU it fits, kind of price (on demand and spot) and provider reading, so the
 * owner sees the Vast 4090 hour beside the Salad 4090 hour. `is_cheapest` marks the fresh floor for that
 * card and kind. `market` is the report from server/gpu/market.js.
 */
function tokenCosts({ market = null, models = [], catalog = null } = {}) {
    if (!market || !Array.isArray(market.gpus)) return [];
    const catalogList = Array.isArray(catalog) ? catalog : (catalog && typeof catalog.list === 'function' ? catalog.list() : catalogModels());
    const gpus = new Map(market.gpus.map((gpu) => [nameOf(gpu.gpu), gpu]));
    const out = [];
    for (const spec of catalogList) {
        const fits = ((spec.requirements && spec.requirements.gpu_names) || []).map(nameOf).filter((name) => gpus.has(name));
        const throughput = number(spec.throughput_tokens_per_hour);
        if (!Number.isFinite(throughput) || throughput <= 0) continue;
        for (const gpuName of fits) {
            const gpu = gpus.get(gpuName);
            const readings = Array.isArray(gpu.readings) ? gpu.readings : [];
            for (const kind of ['on_demand', 'spot']) {
                const best = gpu[kind];
                for (const reading of readings.filter((r) => r.kind === kind)) {
                    const hourly = number(reading.hourly_usd);
                    if (!Number.isFinite(hourly) || hourly <= 0) continue;
                    out.push({
                        model_key: spec.key,
                        model_display_name: spec.display_name || spec.key,
                        gpu: gpu.gpu,
                        gpu_key: gpu.key,
                        kind,
                        provider: reading.provider,
                        provider_label: reading.provider_label || reading.provider,
                        region: reading.region || '',
                        hourly_usd: hourly,
                        reliability: reading.reliability == null ? null : number(reading.reliability),
                        observed_at: reading.observed_at,
                        stale: Boolean(reading.stale),
                        is_cheapest: Boolean(best && best.provider === reading.provider && best.hourly_usd === reading.hourly_usd && best.observed_at === reading.observed_at),
                        source: reading.source,
                        throughput_tokens_per_hour: throughput,
                        throughput_source: THROUGHPUT_SOURCE,
                        usd_per_million_tokens: round((hourly * 1e6) / throughput),
                        cheapest_api: cheapestComparable(spec, models),
                    });
                }
            }
        }
    }
    return out;
}

module.exports = { tokenCosts, cheapestComparable, THROUGHPUT_SOURCE };
