'use strict';

const { resolveSecret } = require('../util');

function centsToUsd(value) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n / 100 : null;
}

function allocateDetailed(grants, spentUsd, now = Date.now()) {
    let remaining = Math.max(0, Number(spentUsd) || 0);
    const ordered = [...grants].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'promotional' ? -1 : 1;
        return (a.expires_at || '9999').localeCompare(b.expires_at || '9999') || String(a.as_of).localeCompare(String(b.as_of));
    });
    const out = { promotional: 0, purchased: 0 };
    const grantBalances = {};
    for (const g of ordered) {
        if (g.expires_at && Date.parse(g.expires_at) <= now) { grantBalances[g.id] = 0; continue; }
        const amount = Math.max(0, Number(g.remaining_as_of_usd == null ? g.amount_usd : g.remaining_as_of_usd) || 0);
        const used = Math.min(amount, remaining);
        remaining -= used;
        out[g.kind] += amount - used;
        grantBalances[g.id] = amount - used;
    }
    return { ...out, grantBalances };
}
/**
 * The billing cycle that holds `now` for a plan that renews on `day` of the month (UTC). A plan that renews on the 31st
 * renews on the last day of a shorter month. → { start, end } in milliseconds.
 */
function cycleOf(day, now) {
    const at = (y, m) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(day, last)); };
    const d = new Date(now);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    let start = at(y, m);
    if (start > now) { m -= 1; if (m < 0) { m = 11; y -= 1; } start = at(y, m); }
    let ny = y, nm = m + 1;
    if (nm > 11) { nm = 0; ny += 1; }
    return { start, end: at(ny, nm) };
}
const planGrantKey = (planId, cycleStart) => `plan:${planId}:${new Date(cycleStart).toISOString().slice(0, 10)}`;
const isPlanGrant = (g) => /^plan:\d+:/.test(String(g && g.applies_to || ''));
const round2 = (n) => Math.round(n * 100) / 100;

function allocate(grants, spentUsd, now = Date.now()) { const { promotional, purchased } = allocateDetailed(grants, spentUsd, now); return { promotional, purchased }; }

function createCreditGrants({ db, env = process.env, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() } }) {
    const latest = new Map();
    let running = null;
    const list = async (provider = 'anthropic') => db.prepare('SELECT id, provider_key, kind, amount_usd, as_of, expires_at, applies_to, received_at, remaining_as_of_usd, remaining_as_of FROM provider_credit_grants WHERE provider_key = ? ORDER BY as_of DESC, id DESC').all(provider);
    async function add(grant) {
        const { provider_key = 'anthropic', kind, amount_usd, as_of, expires_at = null, applies_to = null, received_at = as_of, remaining_as_of_usd = amount_usd, remaining_as_of = as_of } = grant || {};
        if (!['purchased', 'promotional'].includes(kind) || !Number.isFinite(Number(amount_usd)) || Number(amount_usd) < 0 || !as_of || Number.isNaN(Date.parse(as_of))) throw new TypeError('grant requires kind, nonnegative amount_usd, and as_of');
        const result = await db.prepare('INSERT INTO provider_credit_grants (provider_key, kind, amount_usd, as_of, expires_at, applies_to, created_at, received_at, remaining_as_of_usd, remaining_as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id').get(provider_key, kind, Number(amount_usd), as_of, expires_at, applies_to, new Date(clock.now()).toISOString(), received_at, Number(remaining_as_of_usd), remaining_as_of);
        return result;
    }
    // ── Monthly credits from a plan (2026-11-12): one promotional grant per billing cycle, expiring when it ends ──
    const listPlans = async (provider = null) => (provider
        ? db.prepare('SELECT * FROM provider_credit_plans WHERE provider_key = ? ORDER BY id').all(provider)
        : db.prepare('SELECT * FROM provider_credit_plans ORDER BY provider_key, id').all());
    async function addPlan(plan) {
        const p = plan || {};
        const provider = String(p.provider_key || '').trim();
        const monthly = Number(p.monthly_usd);
        const day = Number(p.renews_day);
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new TypeError('a plan names a provider key');
        if (!String(p.label || '').trim()) throw new TypeError('a plan has a label (what grants it, e.g. "ChatGPT Pro API credits")');
        if (!Number.isFinite(monthly) || monthly < 0 || monthly > 1000000) throw new TypeError('monthly_usd is a nonnegative amount');
        if (!Number.isInteger(day) || day < 1 || day > 31) throw new TypeError('renews_day is a day of the month, 1-31');
        if (!p.starts_on || Number.isNaN(Date.parse(p.starts_on))) throw new TypeError('starts_on is a date');
        if (p.ends_on && Number.isNaN(Date.parse(p.ends_on))) throw new TypeError('ends_on is a date');
        const at = new Date(clock.now()).toISOString();
        const row = await db.prepare(`INSERT INTO provider_credit_plans (provider_key, label, monthly_usd, renews_day, starts_on, ends_on, prorate_first, active, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING id`).get(provider, String(p.label).trim().slice(0, 120), monthly, day,
            new Date(p.starts_on).toISOString(), p.ends_on ? new Date(p.ends_on).toISOString() : null, p.prorate_first === false ? 0 : 1,
            p.notes ? String(p.notes).slice(0, 500) : null, at, at);
        await materialize();
        return row;
    }
    async function setPlanActive(id, active) {
        const n = (await db.prepare('UPDATE provider_credit_plans SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, new Date(clock.now()).toISOString(), Number(id))).changes;
        if (!active) {
            // A plan turned off stops granting from now: this cycle's unexpired grant ends today.
            await db.prepare(`UPDATE provider_credit_grants SET expires_at = ? WHERE applies_to LIKE ? AND (expires_at IS NULL OR expires_at > ?)`)
                .run(new Date(clock.now()).toISOString(), `plan:${Number(id)}:%`, new Date(clock.now()).toISOString());
        } else await materialize();
        return n;
    }
    /** Each active plan's grant for the cycle that holds now, once (the first cycle prorated when it starts mid-cycle). */
    async function materialize(now = clock.now()) {
        const made = [];
        for (const p of await listPlans()) {
            if (!Number(p.active)) continue;
            const startsAt = Date.parse(p.starts_on);
            if (!Number.isFinite(startsAt) || startsAt > now) continue;
            if (p.ends_on && Date.parse(p.ends_on) <= now) continue;
            const cycle = cycleOf(Number(p.renews_day), now);
            const applies = planGrantKey(p.id, cycle.start);
            const have = await db.prepare('SELECT id FROM provider_credit_grants WHERE provider_key = ? AND applies_to = ?').get(p.provider_key, applies);
            if (have) continue;
            const begin = Math.max(cycle.start, startsAt);
            const end = p.ends_on ? Math.min(cycle.end, Date.parse(p.ends_on)) : cycle.end;
            const full = Number(p.monthly_usd);
            const amount = Number(p.prorate_first) && begin > cycle.start ? round2(full * (end - begin) / (cycle.end - cycle.start)) : full;
            made.push(await add({ provider_key: p.provider_key, kind: 'promotional', amount_usd: amount, as_of: new Date(begin).toISOString(),
                expires_at: new Date(end).toISOString(), applies_to: applies }));
        }
        return made;
    }
    /** The spend OpenVibe metered for one provider from `sinceMs` on (a plan grant's own cycle). */
    async function meteredSince(provider, sinceMs) {
        const r = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM requests WHERE provider_key = ? AND status = 'ok' AND created_at >= ?").get(provider, new Date(sinceMs).toISOString());
        return Number(r && r.spent) || 0;
    }
    async function providersWithCredit() {
        const rows = await db.prepare('SELECT DISTINCT provider_key FROM provider_credit_grants UNION SELECT DISTINCT provider_key FROM provider_credit_plans').all();
        return [...new Set(['anthropic', 'openai', ...rows.map((r) => r && r.provider_key).filter((k) => typeof k === 'string' && k)])];
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
        const ref = env[`AI_${provider.toUpperCase()}_ADMIN_KEY_REF`];
        const key = resolveSecret(ref, env);
        const last = lastAdminAtByProvider.get(provider) || 0;
        if (provider === 'anthropic' && key && clock.now() - last >= 60000) {
            lastAdminAtByProvider.set(provider, clock.now());
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
        if (provider === 'openai' && key && clock.now() - last >= 60000) {
            lastAdminAtByProvider.set(provider, clock.now());
            try {
                const since = grants.map((g) => Date.parse(g.remaining_as_of || g.as_of)).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), clock.now());
                let after = null; let total = 0; let pages = 0;
                do {
                    const url = new URL('https://api.openai.com/v1/organization/costs');
                    url.searchParams.set('start_time', String(Math.floor(since / 1000)));
                    url.searchParams.set('bucket_width', '1d');
                    if (after) url.searchParams.set('page', after);
                    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
                    if (!response.ok) break;
                    const data = await response.json();
                    for (const bucket of data.data || []) for (const row of bucket.results || []) total += Number(row.amount && row.amount.value) || 0;
                    after = data.has_more ? data.next_page : null;
                    pages++;
                } while (after && pages < 100);
                if (pages) return { usd: total, source: 'Admin API' };
            } catch { /* Admin analytics unavailable: use the service's own metering below. */ }
        }
        const since = grants.map((g) => Date.parse(g.as_of)).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), clock.now());
        const r = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM requests WHERE provider_key = ? AND status = 'ok' AND created_at >= ?").get(provider, new Date(since).toISOString());
        return { usd: Number(r && r.spent) || 0, source: "OpenVibe's own metering" };
    }
    async function poll() {
        if (running) return running;
        running = (async () => {
            await materialize().catch(() => null);
            const now = clock.now();
            for (const provider of await providersWithCredit()) {
                const grants = await list(provider);
                if (!grants.length) continue;
                // A plan's grant only ever pays for its own cycle: its spend is what was metered since it began, so
                // last month's use never eats this month's credit (and an expired one is simply gone).
                const planGrants = grants.filter((g) => isPlanGrant(g) && (!g.expires_at || Date.parse(g.expires_at) > now));
                const plans = [];
                let absorbed = 0;
                for (const g of planGrants) {
                    const used = await meteredSince(provider, Date.parse(g.as_of));
                    const amount = Math.max(0, Number(g.amount_usd) || 0);
                    absorbed += Math.min(amount, used);
                    plans.push({ id: g.id, applies_to: g.applies_to, amount_usd: amount, used_usd: Math.min(amount, used), remaining_usd: Math.max(0, amount - used), expires_at: g.expires_at });
                }
                const others = grants.filter((g) => !isPlanGrant(g));
                const spentResult = others.length ? await spend(provider, others) : { usd: 0, source: "OpenVibe's own metering" };
                const balances = allocateDetailed(others, Math.max(0, spentResult.usd - absorbed), now);
                const planLeft = plans.reduce((a, p) => a + p.remaining_usd, 0);
                latest.set(provider, { ...balances, promotional: balances.promotional + planLeft, plans, grants, preference: await preference(provider), spent_usd: spentResult.usd + absorbed, source: spentResult.source, at: now });
            }
            return values();
        })().finally(() => { running = null; });
        return running;
    }
    function values() { return [...latest.entries()].map(([provider, value]) => ({ provider, ...value })); }
    const lastAdminAtByProvider = new Map();
    return { add, list, poll, values, preference, setPreference, shouldPrefer, listPlans, addPlan, setPlanActive, materialize };
}

module.exports = { createCreditGrants, centsToUsd, allocate, allocateDetailed, cycleOf, planGrantKey };
