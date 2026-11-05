'use strict';
/**
 * AI Exchange P7: per-deployment observed performance (PLAN §D "ObservedPerformance", §E), behind
 * AI_ROUTING_EVIDENCE.
 *
 * Every attempt the router already makes updates one EWMA row per deployment (provider:model): TTFT, decode
 * tokens/s, success rate, timeout rate and the cache-hit ratio. The row is written to provider_metrics
 * (migrations/0026) so a restart keeps the measurements; the counts are kept apart, so a streamed answer that
 * has a TTFT and a non-streamed one that has none do not dilute each other.
 *
 * The arithmetic is deliberately simple and honest: alpha is the configured weight of the new observation
 * (default 0.2). A metric with no observations stays null and is reported as unmeasured, never as zero.
 */
const { iso } = require('../util');

/** EWMA: alpha is the new observation's weight; the first observation is the value itself. */
function ewma(prev, value, alpha) {
    if (!Number.isFinite(Number(value))) return prev == null ? null : Number(prev);
    if (prev == null || !Number.isFinite(Number(prev))) return Number(value);
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return a * Number(value) + (1 - a) * Number(prev);
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const offerKey = (provider, model) => `${provider}:${model || ''}`;

/** Decode tokens per second: output tokens over the time between the first token and the answer's end. */
function decodeTps({ ttftMs, latencyMs, outputTokens }) {
    if (ttftMs == null || latencyMs == null || outputTokens == null) return null;
    const ttft = Number(ttftMs);
    const latency = Number(latencyMs);
    const output = Number(outputTokens);
    if (!Number.isFinite(ttft) || !Number.isFinite(latency) || !Number.isFinite(output)) return null;
    const decodeMs = latency - ttft;
    if (decodeMs <= 0 || output <= 0) return null;
    return output / (decodeMs / 1000);
}

function createProviderMetrics({ db, clock = { now: () => Date.now() }, alpha = 0.2 } = {}) {
    // alpha may be a function: the AI Exchange setting is read live (D11), so an owner change applies to the next attempt.
    const alphaNow = () => (typeof alpha === 'function' ? alpha() : alpha);
    const selectAll = db.prepare('SELECT * FROM provider_metrics');
    const selectOne = db.prepare('SELECT * FROM provider_metrics WHERE provider_key = ? AND model_key = ?');
    const upsert = db.prepare(`INSERT INTO provider_metrics
            (provider_key, model_key, ttft_ms, ttft_samples, decode_tps, decode_samples, success_rate, timeout_rate,
             cache_hit_ratio, cache_samples, sample_count, updated_at)
        VALUES (@provider_key, @model_key, @ttft_ms, @ttft_samples, @decode_tps, @decode_samples, @success_rate, @timeout_rate,
                @cache_hit_ratio, @cache_samples, @sample_count, @updated_at)
        ON CONFLICT(provider_key, model_key) DO UPDATE SET
            ttft_ms = excluded.ttft_ms, ttft_samples = excluded.ttft_samples,
            decode_tps = excluded.decode_tps, decode_samples = excluded.decode_samples,
            success_rate = excluded.success_rate, timeout_rate = excluded.timeout_rate,
            cache_hit_ratio = excluded.cache_hit_ratio, cache_samples = excluded.cache_samples,
            sample_count = excluded.sample_count, updated_at = excluded.updated_at`);

    function view(row) {
        if (!row) return null;
        return {
            provider: row.provider_key,
            model: row.model_key,
            ttft_ms: row.ttft_ms == null ? null : Number(row.ttft_ms),
            ttft_samples: Number(row.ttft_samples) || 0,
            decode_tps: row.decode_tps == null ? null : Number(row.decode_tps),
            decode_samples: Number(row.decode_samples) || 0,
            success_rate: Number(row.success_rate) || 0,
            timeout_rate: Number(row.timeout_rate) || 0,
            cache_hit_ratio: Number(row.cache_hit_ratio) || 0,
            cache_samples: Number(row.cache_samples) || 0,
            sample_count: Number(row.sample_count) || 0,
            updated_at: row.updated_at || null,
        };
    }

    async function all() {
        const map = new Map();
        for (const row of await selectAll.all()) map.set(offerKey(row.provider_key, row.model_key), view(row));
        return map;
    }

    async function get(provider, model) {
        return view(await selectOne.get(String(provider), String(model || '')));
    }

    /**
     * One attempt. `ok` and `timeout` always update; TTFT, decode and the cache ratio update only when the
     * attempt actually measured them (a null never becomes a zero observation).
     */
    async function record({ provider, model = '', ok = false, timeout = false, ttftMs = null, latencyMs = null,
        outputTokens = 0, inputTokens = 0, cachedTokens = 0 } = {}) {
        if (!provider) return null;
        const prev = view(await selectOne.get(String(provider), String(model || '')));
        const samples = (prev ? prev.sample_count : 0) + 1;
        const next = {
            provider_key: String(provider), model_key: String(model || ''),
            ttft_ms: prev ? prev.ttft_ms : null,
            ttft_samples: prev ? prev.ttft_samples : 0,
            decode_tps: prev ? prev.decode_tps : null,
            decode_samples: prev ? prev.decode_samples : 0,
            success_rate: ewma(prev ? prev.success_rate : null, ok ? 1 : 0, alphaNow()) || 0,
            timeout_rate: ewma(prev ? prev.timeout_rate : null, timeout ? 1 : 0, alphaNow()) || 0,
            cache_hit_ratio: prev && prev.cache_samples > 0 ? prev.cache_hit_ratio : null,
            cache_samples: prev ? prev.cache_samples : 0,
            sample_count: samples,
            updated_at: iso(clock.now()),
        };
        const ttft = ttftMs == null || ttftMs === '' ? null : Number(ttftMs);
        if (ttft != null && Number.isFinite(ttft) && ttft >= 0) {
            next.ttft_ms = ewma(next.ttft_ms, ttft, alphaNow());
            next.ttft_samples += 1;
        }
        const tps = decodeTps({ ttftMs, latencyMs, outputTokens });
        if (tps != null) {
            next.decode_tps = ewma(next.decode_tps, tps, alphaNow());
            next.decode_samples += 1;
        }
        const input = Number(inputTokens);
        const cached = Number(cachedTokens);
        if (Number.isFinite(input) && input > 0 && Number.isFinite(cached) && cached >= 0) {
            next.cache_hit_ratio = clamp01(ewma(next.cache_hit_ratio, clamp01(cached / input), alphaNow()));
            next.cache_samples += 1;
        }
        await upsert.run(next);
        return next;
    }

    return { record, all, get };
}

module.exports = { createProviderMetrics, ewma, decodeTps, offerKey };
