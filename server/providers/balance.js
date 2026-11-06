'use strict';
/**
 * Hourly provider balance probe (Track O): a provider that publishes its account balance is asked what is
 * left, so the operator hears about an empty account before every AI feature on the network fails.
 *
 *   DeepSeek  GET https://api.deepseek.com/user/balance
 *             { "is_available": true, "balance_infos": [ { "currency": "USD", "total_balance": "0.05", ... } ] }
 *
 * The reading is exposed as ai_provider_balance_usd{provider} on GET /metrics (server/observability.js) and
 * the operator alert fires below $2 (OpenVibe.Host deploy/prometheus/openvibe-rules.yml). The key is read by
 * reference and only ever sent in the request's Authorization header: it is never logged, returned or stored.
 * Off when AI_BALANCE_PROBE=0 or under a restore drill (AI_DRILL=1; server/config.js balance.enabled).
 */
const { resolveSecret } = require('../util');

const HOST = /(^|\.)api\.deepseek\.com$/i;

/** DeepSeek's answer: the USD total when it reports one (the gauge is dollars), else null. */
function deepseekUsd(j) {
    const infos = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
    const usd = infos.find((x) => x && String(x.currency || '').toUpperCase() === 'USD');
    const n = usd ? Number(usd.total_balance) : NaN;
    return Number.isFinite(n) ? n : null;
}

function createBalanceProbe({ registry, config, env = process.env, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console }) {
    const latest = new Map();   // provider key -> { usd, at, currency }
    let timer = null;
    let running = null;

    /** A provider record with a balance API, or null: DeepSeek today. */
    function apiOf(p) {
        try {
            const u = new URL(String(p && p.base_url || ''));
            return HOST.test(u.hostname) ? { origin: u.origin, path: '/user/balance' } : null;
        } catch { return null; }
    }

    async function read(p) {
        const api = apiOf(p);
        if (!api) return null;
        const key = resolveSecret(p.secret_ref, env);
        if (!key) return null;
        let res;
        try {
            res = await fetchImpl(`${api.origin}${api.path}`, {
                headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(config.balance.timeoutMs),
            });
        } catch (err) {
            throw new Error(`balance API unreachable: ${err && err.message || err}`);
        }
        if (!res.ok) throw new Error(`balance API answered ${res.status}`);
        const j = await res.json().catch(() => null);
        const usd = deepseekUsd(j);
        return usd == null ? null : { usd };
    }

    /** Every configured provider with a balance API, then the research key when no provider record carries it. */
    async function targets() {
        const out = [];
        for (const p of await registry.listProviders()) {
            if (p.status !== 'active') continue;
            if (apiOf(p)) out.push(p);
        }
        return out;
    }

    async function poll() {
        if (running) return running;
        running = (async () => {
            let found = 0;
            for (const p of await targets()) {
                found++;
                try {
                    const r = await read(p);
                    if (r) latest.set(p.key, { usd: r.usd, at: clock.now(), currency: 'USD' });
                } catch (err) {
                    log.warn(`[ai] balance probe ${p.key}: ${String(err && err.message || err).slice(0, 200)}`);
                }
            }
            // The research key can be the only DeepSeek credential (AI_RESEARCH_DEEPSEEK_KEY_REF) when the shared
            // provider is something else: still expose its balance under the label `deepseek`.
            if (!found && config.research && config.research.deepseek && resolveSecret(config.research.deepseekKeyRef, env)) {
                try {
                    const r = await read({ base_url: config.research.deepseekUrl, secret_ref: config.research.deepseekKeyRef });
                    if (r) latest.set('deepseek', { usd: r.usd, at: clock.now(), currency: 'USD' });
                } catch (err) {
                    log.warn(`[ai] balance probe deepseek: ${String(err && err.message || err).slice(0, 200)}`);
                }
            }
            return values();
        })().finally(() => { running = null; });
        return running;
    }

    function values() { return [...latest.entries()].map(([provider, r]) => ({ provider, usd: r.usd, at: r.at })); }

    function start() {
        if (timer || !config.balance.enabled) return;
        const tick = () => { poll().catch((err) => log.warn(`[ai] balance probe: ${err && err.message}`)); };
        const first = setTimeout(tick, 5000);
        if (first.unref) first.unref();
        timer = setInterval(tick, config.balance.intervalMs);
        if (timer.unref) timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { start, stop, poll, values, apiOf };
}

module.exports = { createBalanceProbe, deepseekUsd };
