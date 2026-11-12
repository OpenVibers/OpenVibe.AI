'use strict';
/**
 * A provider's published request limits, kept by the router itself (2026-11-12: Altare Inference's free plan, 60
 * requests a minute and 30 a minute for each flagship model, https://docs.altare.gg/inference/limits). A provider row
 * carries them in metadata.rate_limits (the catalogue's `rate_limits`, seeded by pool-seed): { rpm, model_rpm: { model:
 * n } }. Each request the router sends is counted in its UTC minute; a provider (or one of its models) whose minute is
 * used up is skipped with `rate_limited`, so the router steps to the next offer instead of earning a 429. The provider's
 * own 429 still opens nothing on its own (failure.js classes it rate_limit). The counts live in this process only: one
 * AI process serves the router, and a restart starts the minute again, which can only under-count by one minute.
 */
const { byKey } = require('./pool-providers');

function createRateGate({ now = () => Date.now(), margin = 1 } = {}) {
    const counts = new Map();   // `${provider}` or `${provider}\u0000${model}` -> { minute, n }
    const minuteOf = (t) => Math.floor(t / 60000);
    const limitsOf = (p) => {
        if (!p) return null;
        const own = p.metadata && p.metadata.rate_limits;
        if (own && typeof own === 'object') return own;
        const cat = byKey && typeof byKey.get === 'function' ? byKey.get(p.key) : null;
        return cat && cat.rate_limits ? cat.rate_limits : null;
    };
    const used = (key, m) => { const c = counts.get(key); return c && c.minute === m ? c.n : 0; };
    const bump = (key, m) => {
        const c = counts.get(key);
        if (c && c.minute === m) c.n += 1; else counts.set(key, { minute: m, n: 1 });
        if (counts.size > 5000) counts.delete(counts.keys().next().value);
    };
    const modelLimit = (l, model) => {
        if (!model || !l.model_rpm) return null;
        const leaf = String(model).split('/').pop().toLowerCase();
        for (const [k, v] of Object.entries(l.model_rpm)) if (String(k).toLowerCase() === leaf && Number(v) > 0) return Number(v);
        return null;
    };
    /** True when this provider (or this model of it) has used its minute. */
    function full(p, model) {
        const l = limitsOf(p);
        if (!l) return false;
        const m = minuteOf(now());
        if (Number(l.rpm) > 0 && used(p.key, m) >= Math.floor(Number(l.rpm) * margin)) return true;
        const ml = modelLimit(l, model);
        return ml != null && used(`${p.key}\u0000${String(model).toLowerCase()}`, m) >= Math.floor(ml * margin);
    }
    /** One request sent to this provider and model. */
    function take(p, model) {
        const l = limitsOf(p);
        if (!l) return;
        const m = minuteOf(now());
        bump(p.key, m);
        if (modelLimit(l, model) != null) bump(`${p.key}\u0000${String(model).toLowerCase()}`, m);
    }
    /** What a provider has left this minute, for the console: { rpm, used, models: { model: { limit, used } } } or null. */
    function view(p) {
        const l = limitsOf(p);
        if (!l) return null;
        const m = minuteOf(now());
        const models = {};
        for (const [k, v] of Object.entries(l.model_rpm || {})) models[k] = { limit: Number(v), used: used(`${p.key}\u0000${String(k).toLowerCase()}`, m) };
        return { rpm: Number(l.rpm) || null, used: used(p.key, m), models };
    }
    return { full, take, view };
}

module.exports = { createRateGate };
