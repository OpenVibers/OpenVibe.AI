'use strict';

/**
 * Provider fidelity on an Exchange offer (stage B5).
 *
 * OpenVibe.Bench measures the same fixed objective set through every provider that serves an open-weight
 * model and publishes the latest score at GET /api/v1/fidelity. This is a read-through of that public
 * answer, keyed by the provider and exact endpoint: AI never measures fidelity itself and never invents
 * a score. Bench being down (or not configured) leaves the field null, which the catalog renders as "not
 * measured", never as zero.
 *
 * The read is cached in this process for five minutes; a failed read keeps the last good answer for the
 * same window, and a first failure is retried after a minute rather than on every page view.
 */
const CACHE_MS = 5 * 60 * 1000;
const FAIL_MS = 60 * 1000;

const keyOf = (provider, model) => `${String(provider || '').toLowerCase()}\0${String(model || '').toLowerCase()}`;
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function createFidelitySource({ url = null, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console, timeoutMs = 2500, enabled = true } = {}) {
    const base = String(url || '').replace(/\/+$/, '');
    const live = enabled && Boolean(base) && typeof fetchImpl === 'function';
    let hit = null;
    let pending = null;

    async function load() {
        if (!live) return new Map();
        let body;
        try {
            const res = await fetchImpl(`${base}/api/v1/fidelity`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(Math.max(250, Math.min(5000, Number(timeoutMs) || 2500))),
            });
            if (!res.ok) throw new Error(`Bench answered ${res.status}`);
            body = await res.json();
        } catch (err) {
            log.warn('[exchange] fidelity read failed: ' + String((err && err.message) || err).slice(0, 200));
            return null;
        }
        const map = new Map();
        for (const offer of (Array.isArray(body && body.offers) ? body.offers : [])) {
            const provider = String((offer && offer.provider) || '').trim();
            const model = String((offer && (offer.provider_model || offer.model)) || '').trim();
            const score = num(offer && offer.score);
            const n = num(offer && offer.n);
            if (!provider || !model || score == null || n == null || n <= 0) continue;
            const interval = offer.interval && num(offer.interval.lower) != null && num(offer.interval.upper) != null
                ? { lower: num(offer.interval.lower), upper: num(offer.interval.upper) }
                : null;
            map.set(keyOf(provider, model), {
                score,
                n,
                interval,
                compared_to: (offer && (offer.compared_to || offer.model)) || null,
                measured_at: (offer && offer.measured_at) || null,
                prompt_set: (offer && offer.prompt_set) || (body && body.objective_set) || null,
            });
        }
        return map;
    }

    /** The fidelity map for this snapshot. Never throws: the market/catalog answer without the field. */
    async function read() {
        if (!live) return new Map();
        if (hit && clock.now() - hit.at < (hit.ok ? CACHE_MS : FAIL_MS)) return hit.value;
        if (pending) return pending;
        pending = load()
            .then((map) => {
                hit = { at: clock.now(), value: map || hit?.value || new Map(), ok: Boolean(map) };
                return hit.value;
            })
            .finally(() => { pending = null; });
        return pending;
    }

    return { read, enabled: live, url: base || null, keyOf };
}

module.exports = { createFidelitySource, keyOf, CACHE_MS, FAIL_MS };
