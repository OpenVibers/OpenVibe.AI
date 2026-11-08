'use strict';

const { resolveSecret } = require('../util');

function centsToUsd(value) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n / 100 : null;
}

function allocate(grants, spentUsd, now = Date.now()) {
    let remaining = Math.max(0, Number(spentUsd) || 0);
    const ordered = [...grants].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'promotional' ? -1 : 1;
        if (a.kind === 'promotional') return (a.expires_at || '9999').localeCompare(b.expires_at || '9999') || String(b.as_of).localeCompare(String(a.as_of));
        return String(b.as_of).localeCompare(String(a.as_of));
    });
    const out = { promotional: 0, purchased: 0 };
    for (const g of ordered) {
        if (g.expires_at && Date.parse(g.expires_at) <= now) continue;
        const amount = Math.max(0, Number(g.amount_usd) || 0);
        const used = Math.min(amount, remaining);
        remaining -= used;
        out[g.kind] += amount - used;
    }
    return out;
}

function createCreditGrants({ db, env = process.env, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() } }) {
    const latest = new Map();
    let running = null;
    let lastAdminAt = 0;
    const list = async (provider = 'anthropic') => db.prepare('SELECT id, provider_key, kind, amount_usd, as_of, expires_at, applies_to FROM provider_credit_grants WHERE provider_key = ? ORDER BY as_of DESC, id DESC').all(provider);
    async function add(grant) {
        const { provider_key = 'anthropic', kind, amount_usd, as_of, expires_at = null, applies_to = null } = grant || {};
        if (!['purchased', 'promotional'].includes(kind) || !Number.isFinite(Number(amount_usd)) || Number(amount_usd) < 0 || !as_of || Number.isNaN(Date.parse(as_of))) throw new TypeError('grant requires kind, nonnegative amount_usd, and as_of');
        const result = await db.prepare('INSERT INTO provider_credit_grants (provider_key, kind, amount_usd, as_of, expires_at, applies_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id').get(provider_key, kind, Number(amount_usd), as_of, expires_at, applies_to, new Date(clock.now()).toISOString());
        return result;
    }
    async function preference(provider = 'anthropic') {
        const row = await db.prepare('SELECT use_promotional_first, promotional_floor_usd FROM provider_credit_preferences WHERE provider_key = ?').get(provider);
        return row ? { enabled: Boolean(row.use_promotional_first), floor_usd: Number(row.promotional_floor_usd) } : { enabled: true, floor_usd: 5 };
    }
    async function setPreference({ provider_key = 'anthropic', enabled = true, floor_usd = 5 }) {
        if (typeof enabled !== 'boolean' || !Number.isFinite(Number(floor_usd)) || Number(floor_usd) < 0 || Number(floor_usd) > 1000000) throw new TypeError('preference requires a boolean enabled and nonnegative floor_usd');
        await db.prepare(`INSERT INTO provider_credit_preferences (provider_key, use_promotional_first, promotional_floor_usd, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (provider_key) DO UPDATE SET use_promotional_first = excluded.use_promotional_first, promotional_floor_usd = excluded.promotional_floor_usd, updated_at = excluded.updated_at`)
            .run(provider_key, enabled ? 1 : 0, Number(floor_usd), new Date(clock.now()).toISOString());
        return preference(provider_key);
    }
    function shouldPrefer(provider = 'anthropic') {
        const balance = latest.get(provider);
        if (!balance) return false;
        // Preferences are loaded in the hourly poll, so routing never needs a database read per request.
        const pref = balance.preference || { enabled: true, floor_usd: 5 };
        return pref.enabled && balance.promotional > pref.floor_usd;
    }
    async function spend(provider, grants) {
        const ref = env.AI_ANTHROPIC_ADMIN_KEY_REF;
        const key = resolveSecret(ref, env);
        if (provider === 'anthropic' && key && clock.now() - lastAdminAt >= 60000) {
            lastAdminAt = clock.now();
            try {
                const since = grants.map((g) => Date.parse(g.as_of)).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), clock.now());
                const url = new URL('https://api.anthropic.com/v1/organizations/analytics/cost');
                url.searchParams.set('starting_at', new Date(since).toISOString());
                url.searchParams.set('ending_at', new Date(clock.now()).toISOString());
                url.searchParams.set('bucket_width', '1d');
                const response = await fetchImpl(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'analytics-usage-cost-2026-08-24', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
                if (response.ok) {
                    const data = await response.json();
                    const values = (data.data || data.rows || []).map((row) => centsToUsd(row.cost && row.cost.amount)).filter((x) => x != null);
                    if (values.length) return { usd: values.reduce((a, b) => a + b, 0), source: 'Admin API' };
                }
            } catch { /* Admin analytics unavailable: use the service's own metering below. */ }
        }
        const since = grants.map((g) => Date.parse(g.as_of)).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), clock.now());
        const r = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM requests WHERE provider_key = ? AND status = 'ok' AND created_at >= ?").get(provider, new Date(since).toISOString());
        return { usd: Number(r && r.spent) || 0, source: "OpenVibe's own metering" };
    }
    async function poll() {
        if (running) return running;
        running = (async () => {
            const grants = await list();
            if (!grants.length) return values();
            const spentResult = await spend('anthropic', grants);
            const balances = allocate(grants, spentResult.usd, clock.now());
            latest.set('anthropic', { ...balances, grants, ...{ preference: await preference('anthropic') }, spent_usd: spentResult.usd, source: spentResult.source, at: clock.now() });
            return values();
        })().finally(() => { running = null; });
        return running;
    }
    function values() { return [...latest.entries()].map(([provider, value]) => ({ provider, ...value })); }
    return { add, list, poll, values, preference, setPreference, shouldPrefer };
}

module.exports = { createCreditGrants, centsToUsd, allocate };
