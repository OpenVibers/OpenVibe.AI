'use strict';
/**
 * AI Exchange P7: OpenVibe.Bench's per-artifact evidence (Bench PR #120, GET /api/v1/variant-evidence/:exactId).
 *
 * The only facts this client accepts are the ones Bench measured for an exact id (D3:
 * org/model[:quant]@revision): sample_count, success_rate, timeout_rate, TTFT p50/p95 and decode tokens/s.
 * A sparse row is returned with its sample count and status `sparse`, never dropped and never filled in; the
 * router reports it as sparse. A 404 is `absent`; a network failure is `unavailable` and never fails a request.
 *
 * Reads are cached for a short TTL per exact id (positive and negative), so a burst of alias traffic makes one
 * Bench call, and an unavailable Bench does not get hammered. No prompt, output or request id is sent.
 */
const DEFAULT_TTL_MS = 60 * 1000;
const FAILURE_TTL_MS = 5 * 1000;

function normalise(evidence) {
    if (!evidence || typeof evidence !== 'object') return null;
    const samples = Number.isSafeInteger(Number(evidence.sample_count)) && Number(evidence.sample_count) >= 0 ? Number(evidence.sample_count) : 0;
    const metrics = evidence.metrics && typeof evidence.metrics === 'object' ? evidence.metrics : {};
    const rate = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(1, Number(v))));
    const tps = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
    return {
        exact_id: typeof evidence.exact_id === 'string' ? evidence.exact_id : null,
        samples,
        success_rate: rate(evidence.success_rate),
        timeout_rate: rate(evidence.timeout_rate),
        ttft_p50_ms: tps(metrics.ttft_p50_ms != null ? metrics.ttft_p50_ms : evidence.ttft_p50_ms),
        ttft_p95_ms: tps(metrics.ttft_p95_ms != null ? metrics.ttft_p95_ms : evidence.ttft_p95_ms),
        decode_tokens_per_s: tps(metrics.decode_tokens_per_s != null ? metrics.decode_tokens_per_s : evidence.decode_tokens_per_s),
        measured_at: evidence.measured_at || null,
        sparse: evidence.sparse === true || Boolean(evidence.confidence && evidence.confidence.sparse),
        confidence: evidence.confidence || null,
    };
}

function createVariantEvidence({ config = {}, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console, ttlMs = DEFAULT_TTL_MS } = {}) {
    const base = String((config.bench && config.bench.url) || '').replace(/\/+$/, '');
    const timeoutMs = Math.max(100, Number(config.bench && config.bench.timeoutMs) || 15000);
    const cache = new Map();   // exact id -> { at, expires, result }

    function remember(id, result, ttl = result.status === 'unavailable' ? FAILURE_TTL_MS : ttlMs) {
        if (cache.size > 512) cache.delete(cache.keys().next().value);
        cache.set(id, { at: clock.now(), expires: ttl, result });
        return result;
    }

    /**
     * → { status: 'ok' | 'sparse' | 'absent' | 'unavailable', samples, success_rate, timeout_rate,
     *      ttft_p50_ms, decode_tokens_per_s, exact_id, sparse }
     */
    async function get(exactId) {
        const id = typeof exactId === 'string' ? exactId.trim() : '';
        if (!id) return { status: 'absent', samples: 0, exact_id: null };
        const hit = cache.get(id);
        if (hit && clock.now() - hit.at <= hit.expires) return hit.result;
        if (!base || typeof fetchImpl !== 'function') return remember(id, { status: 'absent', samples: 0, exact_id: id });
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/variant-evidence/${encodeURIComponent(id)}`, {
                method: 'GET', headers: { Accept: 'application/json' }, signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
            });
        } catch (err) {
            log.warn(`[routing-evidence] Bench evidence unavailable for ${id}: ${String(err && err.message || err).slice(0, 160)}`);
            return remember(id, { status: 'unavailable', samples: 0, exact_id: id });
        }
        if (res.status === 404) return remember(id, { status: 'absent', samples: 0, exact_id: id });
        if (!res.ok) return remember(id, { status: 'unavailable', samples: 0, exact_id: id });
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        const evidence = normalise(body && body.evidence);
        if (!evidence) return remember(id, { status: 'absent', samples: 0, exact_id: id });
        return remember(id, { ...evidence, status: evidence.sparse ? 'sparse' : 'ok' });
    }

    return { get, clear: () => cache.clear(), base };
}

module.exports = { createVariantEvidence, normalise };
