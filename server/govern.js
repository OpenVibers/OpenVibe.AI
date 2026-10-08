'use strict';
/**
 * T6 step 8 (decision D5): the SaaS tier budgets on openvibe-sdk/govern, its counters in Valkey (ADR-035).
 * Behind AI_GOVERN_TIERS (default off: none of this runs and Valkey is not needed).
 *
 * Admission. Before a run touches a provider, admit() holds an estimate (config.govern.hold) of the units
 * ai-token and ai-usd against two budgets: the subject's (the attribution, else the actor, else the requester)
 * inside its project (the calling product, `service:live`), and the project's as a whole. Each budget's tier
 * (free, paid, staff) comes from config.govern.tiers, else config.govern.defaultTier; the windows per unit and
 * tier are config.govern.policy (a missing tier or window is unlimited, 0 refuses). A hold that would pass a
 * limit refuses the run with 429 govern.exceeded and retry_after_seconds; govern's reserve is one atomic step
 * per budget, so two runs can never both take the last unit. settle() commits the real tokens and the priced
 * cost (the free-allowance share left out) when the run is accounted; release() gives the hold back when the
 * run spent nothing. quota.js reserve() and its request counters are unchanged and run after admit().
 *
 * Valkey unreachable: a run any of whose budgets is not on the free tier is refused (503 govern.unavailable,
 * fail closed); an all-free run is admitted on the PostgreSQL quotas alone, as with the flag off.
 *
 * Pricing. freeStore() is the step-2 provider free allowance (server/free-allowance.js) on the same Valkey:
 * one counter per subject, provider, metric and the card's own period (UTC day, UTC month, or the card's terms
 * for 'none'), claimed atomically (min(wanted, cap − used)), so the numbers are step 2's. PostgreSQL's
 * free_allowance_usage stays the record (the console reads it, a lost Valkey key restarts from it).
 *
 * Readings. meter() is an in-process governor whose onUsage builds each platform.usage-sample@1
 * (server/usage-samples.js): never refuses, never needs Valkey.
 */
const { createGovernor } = require('openvibe-sdk/govern');
const { createValkey } = require('openvibe-sdk/valkey');
const { AiError } = require('./util');
const { subjectOf } = require('./free-allowance');

const UNITS = ['ai-token', 'ai-usd'];
const TIERS = ['free', 'paid', 'staff'];
/** The default policy (AI_GOVERN_POLICY_JSON replaces it): staff is unlimited. */
const DEFAULT_POLICY = {
    'ai-token': { free: { day: 200000, month: 2000000 }, paid: { day: 5000000 }, staff: {} },
    'ai-usd': { free: { day: 0.5, month: 5 }, paid: { day: 50 }, staff: {} },
};

const timeout = (p, ms) => {
    let timer;
    return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms); if (timer.unref) timer.unref(); })]).finally(() => clearTimeout(timer));
};

const CLAIM = `
-- KEYS[1]: one free-allowance counter. ARGV: wanted, cap, floor (PostgreSQL's free_used), expire-at ms (0: never).
-- Claims min(wanted, cap - used) and returns { claimed, used after }.
local used = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), tonumber(ARGV[3]))
local free = math.min(tonumber(ARGV[1]), math.max(0, tonumber(ARGV[2]) - used))
used = used + free
redis.call('SET', KEYS[1], tostring(used))
if tonumber(ARGV[4]) > 0 then redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[4])) end
return { free, used }`;

/** The free-allowance counters: on Valkey (one Lua call each), else in this process (tests, one process). */
function freeCounters(valkey) {
    if (!valkey) {
        const m = new Map();
        return { async claim(key, wanted, cap, floor, expireAt, t) {
            for (const [k, v] of m) if (v.until && v.until <= t) m.delete(k);
            const c = m.get(key) || { used: 0, until: expireAt };
            c.used = Math.max(c.used, floor);
            const free = Math.min(wanted, Math.max(0, cap - c.used));
            c.used += free; m.set(key, c);
            return { free, used: c.used };
        } };
    }
    const c = valkey.client;
    if (typeof c.ovAiFreeClaim !== 'function') c.defineCommand('ovAiFreeClaim', { numberOfKeys: 1, lua: CLAIM });
    return { async claim(key, wanted, cap, floor, expireAt) {
        const r = await c.ovAiFreeClaim(valkey.key('gov', 'free', key), String(wanted), String(cap), String(floor), String(expireAt));
        return { free: Number(r[0]), used: Number(r[1]) };
    } };
}

function createTiers({ config, valkey = null, clock = { now: () => Date.now() }, log = console } = {}) {
    const g = config.govern;
    if (!g.enabled) return { enabled: false, admit: async () => null, settle: async () => {}, release: async () => {}, freeStore: null, close: async () => {} };
    const owned = !valkey && Boolean(g.valkeyUrl);
    if (owned) valkey = createValkey({ url: g.valkeyUrl, prefix: g.valkeyPrefix, log });
    if (!valkey && config.isProduction) throw new Error('AI_GOVERN_TIERS=1 needs VALKEY_URL: the tier budgets are counted in Valkey');
    if (!valkey) log.warn('[govern] no VALKEY_URL: tier budgets are counted in this process only');
    const gov = createGovernor({ service: 'ai', policy: g.policy, valkey, now: () => clock.now(), log });
    const free = freeCounters(valkey);
    const tierOf = (...keys) => { for (const k of keys) if (k && g.tiers[k]) return g.tiers[k]; return g.defaultTier; };
    let lastError = null;
    const warn = (msg) => { if (msg !== lastError) log.warn(`[govern] ${msg}`); lastError = msg; };

    /**
     * Hold the run's estimate on every budget, or refuse it. Returns the hold ({ ids: { unit: [id] } }) to settle
     * or release, or null when an all-free run was admitted without Valkey.
     */
    async function admit(ctx, runId) {
        const project = `${ctx.requesterType}:${ctx.requesterId}`;
        const subject = subjectOf(ctx) || project;
        const budgets = [{ scope: 'subject', subject, project, tier: tierOf(subject, project) }, { scope: 'project', subject: '*', project, tier: tierOf(project) }];
        const hold = { ids: { 'ai-token': [], 'ai-usd': [] }, budgets };
        try {
            for (const b of budgets) {
                for (const unit of UNITS) {
                    const r = await timeout(gov.reserve({ subject: b.subject, project: b.project, tier: b.tier, unit, amount: g.hold[unit], key: `ai:${runId}:hold` }), g.timeoutMs);
                    if (!r.ok) {
                        await release(hold);
                        throw new AiError(429, 'govern.exceeded', `the ${b.tier} tier allows ${r.limit} ${unit} per ${r.window} for this ${b.scope}`, {
                            retry_after_seconds: r.retryAfterS, govern: { scope: b.scope, tier: b.tier, unit, window: r.window, limit: r.limit, used: r.used } });
                    }
                    hold.ids[unit].push(r.id);
                }
            }
        } catch (err) {
            if (err instanceof AiError) throw err;
            warn(`Valkey unreachable: ${err.message}`);
            await release(hold);
            if (budgets.some((b) => b.tier !== 'free')) throw new AiError(503, 'govern.unavailable', 'the tier budgets cannot be checked right now; retry shortly', { retry_after_seconds: 5 });
            return null;
        }
        lastError = null;
        return hold;
    }

    /** The run is accounted: commit its real tokens and priced cost on every budget it held. */
    async function settle(hold, { tokens = 0, usd = 0 } = {}) {
        if (!hold) return;
        const actual = { 'ai-token': Math.max(0, Number(tokens) || 0), 'ai-usd': Math.max(0, Number(usd) || 0) };
        for (const unit of UNITS) {
            for (const id of hold.ids[unit]) {
                try { await timeout(gov.commit(id, actual[unit]), g.timeoutMs); } catch (err) { warn(`commit failed (the hold stays counted): ${err.message}`); }
            }
        }
        hold.ids = { 'ai-token': [], 'ai-usd': [] };
    }

    /** The run spent nothing: every hold goes back. */
    async function release(hold) {
        if (!hold) return;
        for (const unit of UNITS) {
            for (const id of hold.ids[unit]) {
                try { await timeout(gov.release(id), g.timeoutMs); } catch (err) { warn(`release failed (the hold stays counted until it expires): ${err.message}`); }
            }
        }
        hold.ids = { 'ai-token': [], 'ai-usd': [] };
    }

    /** The free-allowance store for createFreeAllowance({ store }): Valkey unreachable → nothing is free (priced fully). */
    const freeStore = {
        async claim(key, wanted, cap, floor, expireAt, now) {
            try { return await timeout(free.claim(key, wanted, cap, floor, expireAt, now), g.timeoutMs); } catch (err) { warn(`free allowance unreadable, priced in full: ${err.message}`); return { free: 0, used: null }; }
        },
    };

    async function close() { if (owned) await valkey.close().catch(() => {}); }

    return { enabled: true, admit, settle, release, freeStore, usage: (o) => gov.usage(o), policy: g.policy, close };
}

/**
 * The reading meter: an in-process governor (no policy, so nothing is ever refused) whose onUsage is where a
 * platform.usage-sample@1 comes from. reading(fields) reserves the run's tokens under its idempotency key and
 * returns the onUsage record, or null when that key is already being read (a replay).
 */
function createMeter() {
    const seen = new Map();
    const gov = createGovernor({ service: 'ai', onUsage: (e) => { if (seen.has(e.idempotency_key)) seen.set(e.idempotency_key, e); } });
    return async function reading({ subject, quantity, key }) {
        if (seen.has(key)) return null;
        seen.set(key, null);
        try {
            const r = await gov.reserve({ subject, tier: 'meter', unit: 'ai-token', amount: quantity, key });
            if (r.ok) await gov.commit(r.id, quantity);
            return seen.get(key);
        } finally { seen.delete(key); }
    };
}

/** config.govern from the environment (server/config.js). */
function loadGovern(env, { bool, int, num }) {
    let policy = DEFAULT_POLICY;
    if (env.AI_GOVERN_POLICY_JSON) {
        try { policy = JSON.parse(env.AI_GOVERN_POLICY_JSON); } catch { throw new Error('AI_GOVERN_POLICY_JSON is not valid JSON'); }
        for (const u of Object.keys(policy || {})) if (!UNITS.includes(u)) throw new Error(`AI_GOVERN_POLICY_JSON: unit ${u} is not one of ${UNITS.join(', ')}`);
    }
    const tiers = {};
    for (const pair of String(env.AI_GOVERN_TIER_MAP || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const i = pair.lastIndexOf('=');
        const who = pair.slice(0, i).trim(); const tier = pair.slice(i + 1).trim();
        if (i <= 0 || !TIERS.includes(tier)) throw new Error(`AI_GOVERN_TIER_MAP: "${pair}" is not subject=${TIERS.join('|')}`);
        tiers[who] = tier;
    }
    const defaultTier = env.AI_GOVERN_DEFAULT_TIER || 'free';
    if (!TIERS.includes(defaultTier)) throw new Error(`AI_GOVERN_DEFAULT_TIER must be one of ${TIERS.join(', ')}`);
    return {
        enabled: bool(env.AI_GOVERN_TIERS, false),
        policy, tiers, defaultTier,
        hold: { 'ai-token': Math.max(0, int(env.AI_GOVERN_HOLD_TOKENS, 4000)), 'ai-usd': Math.max(0, num(env.AI_GOVERN_HOLD_USD, 0.02)) },
        timeoutMs: Math.max(50, int(env.AI_GOVERN_TIMEOUT_MS, 1000)),
        valkeyUrl: env.VALKEY_URL || '', valkeyPrefix: env.VALKEY_PREFIX || '',
    };
}

module.exports = { createTiers, createMeter, loadGovern, freeCounters, DEFAULT_POLICY, UNITS, TIERS };
