'use strict';
/**
 * The traits a provider record carries beyond its price (part 1 of the 2026-11-10 provider wave): the
 * classes of work it may answer, how many requests it takes at once, a free allowance and when it ends,
 * how it is paid, and the OpenRouter provider routing an offer pins.
 *
 * They live in metadata.traits on the provider row (server/providers/pool-seed.js writes them from
 * server/providers/pool-providers.js) and in metadata on a model row for the per-offer facts. The
 * router reads them; nothing here calls a provider or invents a fact.
 *
 *   latency_classes    interactive | background | batch    absent: every class
 *   tier_latency       { flex: ['background', 'batch'] }     a tier's own classes (Flex never interactive)
 *   concurrency        number                               at most that many calls at once
 *   free_allowance     { tokens, period, ends_at, ... }      spent first, then stops at its date
 *   payment            'crypto-prepaid' | null
 *   trains_note        the provider's own wording about training, when it is not in data_policy
 */

const CLASSES = ['interactive', 'background', 'batch'];
const RETENTION_KEEPS = new Set(['limited', 'standard']);

function traitsOf(record) {
    return (record && record.metadata && record.metadata.traits) || null;
}

/** The provider record's data policy (the facts the Exchange privacy label reads). */
function policyOf(record) {
    return (record && record.metadata && record.metadata.data_policy) || null;
}

/** The classes one offer may answer, or null when it may answer every class. */
function latencyClassesOf(record, model, tier = 'standard') {
    const t = traitsOf(record);
    if (t && t.tier_latency && tier && Array.isArray(t.tier_latency[tier])) return t.tier_latency[tier];
    if (t && Array.isArray(t.latency_classes) && t.latency_classes.length) return t.latency_classes;
    const m = (model && model.metadata) || null;
    if (m && Array.isArray(m.latency_classes) && m.latency_classes.length) return m.latency_classes;
    // A model offer that names a Flex service tier is a Flex offer: it may wait, never answer in front of a person.
    if (m && String(m.service_tier || '').toLowerCase() === 'flex') return ['background', 'batch'];
    return null;
}

/**
 * May this offer answer a request of that class? An unknown class is interactive (the safe default).
 *
 * The two owner switches of part 5 are the only way past a provider's own class list:
 *   allowLimitedInteractive  a background/batch-only provider may answer interactively
 *   allowFlexInteractive     a Flex offer may answer interactively
 * Both default false and are read from owner_inference_rules by the pool.
 */
function latencyAllows(record, model, latencyClass = 'interactive', tier = 'standard', { allowLimitedInteractive = false, allowFlexInteractive = false } = {}) {
    const asked = CLASSES.includes(latencyClass) ? latencyClass : 'interactive';
    const m = (model && model.metadata) || null;
    const flexModel = Boolean(m && String(m.service_tier || '').toLowerCase() === 'flex');
    if (asked === 'interactive' && flexModel && !allowFlexInteractive) return false;
    if (allowLimitedInteractive) return true;
    // The owner allowed the Flex offer in front of a person: only the provider's own classes still apply.
    const t = traitsOf(record);
    const classes = flexModel && allowFlexInteractive
        ? ((t && t.latency_classes) || null)
        : latencyClassesOf(record, model, tier);
    return !classes || classes.includes(asked);
}

/** The free allowance the provider states, or null. */
function freeAllowanceOf(record) {
    const t = traitsOf(record);
    return t && t.free_allowance ? t.free_allowance : null;
}

/** The provider's concurrency cap, or null when it states none. */
function concurrencyOf(record) {
    const t = traitsOf(record);
    const n = t && Number(t.concurrency);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * What is left of a free allowance. `used` is the provider's token count for the current period from
 * usage_daily (the caller reads it; this function does no I/O).
 *
 * → { tokens, used, left, ends_at, ended, period, shared } or null when the provider has none.
 */
function allowanceLeft(record, { used = 0, now = Date.now() } = {}) {
    const a = freeAllowanceOf(record);
    if (!a) return null;
    const tokens = Number(a.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) return null;
    const endsAt = a.ends_at ? Date.parse(a.ends_at) : null;
    const ended = Number.isFinite(endsAt) && now >= endsAt;
    const spent = Math.max(0, Number(used) || 0);
    return {
        tokens,
        used: spent,
        left: ended ? 0 : Math.max(0, tokens - spent),
        ends_at: a.ends_at || null,
        ended,
        period: a.period || 'once',
        shared: a.shared !== false,
    };
}

/** The start of the allowance's current period, as an ISO day, or null for a one-time allowance. */
function allowancePeriodStart(record, now = Date.now()) {
    const a = freeAllowanceOf(record);
    if (!a) return null;
    if (a.starts_at) return String(a.starts_at).slice(0, 10);
    if (a.period === 'month') {
        const d = new Date(now);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    }
    return null;
}

/**
 * Does this provider train on or retain a prompt? The two facts the private rule reads. A provider that
 * says nothing is not trusted with a person's private data: unknown counts as retaining.
 */
function trainsOrRetains(record) {
    const p = policyOf(record);
    if (!p) return true;
    // Training must be an explicit "no": a provider that says nothing is not trusted with private data.
    if (p.trains !== false && p.training !== false) return true;
    if (p.retention == null) return true;
    return RETENTION_KEEPS.has(String(p.retention));
}

/** Is this request a person's private data? A preset that asks for strict privacy is; so is `options.private`. */
function isPrivateRequest(ctx = {}) {
    if (ctx.private === true) return true;
    const policy = ctx.presetPolicy || null;
    return Boolean(policy && String(policy.data_policy || '').toLowerCase() === 'private');
}

module.exports = {
    CLASSES, traitsOf, policyOf, latencyClassesOf, latencyAllows, freeAllowanceOf, concurrencyOf,
    allowanceLeft, allowancePeriodStart, trainsOrRetains, isPrivateRequest,
};
