'use strict';

const { AiError } = require('../util');
const money = require('./money');

const PROVIDERS = Object.freeze(['vast', 'runpod', 'salad', 'tensordock', 'shadeform', 'verda', 'thunder', 'runpod_serverless', 'reserved']);
const DEFAULTS = Object.freeze({
    enabled: false, order: 50, classes: ['interactive', 'batch'], interruptible_allowed: false,
    max_hourly_nano: null, max_replicas: 1, regions: [], monthly_cap_share_percent: 100,
});
const GLOBAL = Object.freeze({ quote_only: true, interactive_cap_nano: null, batch_cap_nano: null });
const OWNED = new Set(['svc:exchange']);

function defaultsFor(provider) {
    return { ...DEFAULTS, ...(provider === 'salad' ? { classes: ['batch'], max_replicas: 3 } : {}) };
}

/**
 * The policy in force for a provider. Before the owner has saved one, a provider whose key is already
 * in the vault stays on: adding this table must not silently stop the rentals the owner had. Saving
 * any provider setting makes its stored `enabled` the one that counts.
 */
function effectiveProvider(provider, saved, hasKey) {
    const out = { ...defaultsFor(provider), ...(saved || {}) };
    if (!saved) out.enabled = Boolean(hasKey);
    return out;
}

function invalid(message) { throw new AiError(422, 'gpu.policy_invalid', message); }
function nano(value, name) {
    if (value == null || value === '') return null;
    const n = money.nanoCount(value, name);
    if (n < 0n || n > 1000000000000000n) invalid(name + ' is out of range');
    return n.toString();
}
function providerInput(body, current, provider) {
    const out = { ...current };
    const allowed = new Set(Object.keys(DEFAULTS));
    for (const [k, v] of Object.entries(body)) {
        if (!allowed.has(k)) invalid('unknown provider setting ' + k);
        if (k === 'enabled' || k === 'interruptible_allowed') {
            if (typeof v !== 'boolean') invalid(k + ' must be true or false');
            out[k] = v;
        } else if (k === 'order') {
            if (!Number.isInteger(v) || v < 0 || v > 1000) invalid('order must be 0-1000');
            out[k] = v;
        } else if (k === 'max_replicas') {
            if (!Number.isInteger(v) || v < 1 || v > 100) invalid('max_replicas must be 1-100');
            out[k] = v;
        } else if (k === 'monthly_cap_share_percent') {
            if (!Number.isInteger(v) || v < 0 || v > 100) invalid('monthly_cap_share_percent must be 0-100');
            out[k] = v;
        } else if (k === 'max_hourly_nano') out[k] = nano(v, k);
        else if (k === 'classes') {
            if (!Array.isArray(v) || !v.length || v.length > 2 || v.some(x => !['interactive', 'batch'].includes(x)) || new Set(v).size !== v.length) invalid('classes must contain interactive or batch');
            out[k] = [...v];
        } else if (k === 'regions') {
            if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/.test(x))) invalid('regions must be region codes');
            out[k] = [...new Set(v.map(x => x.toUpperCase()))];
        }
    }
    if (provider === 'salad' && !Object.hasOwn(body, 'max_replicas') && current === DEFAULTS) out.max_replicas = 3;
    if (provider === 'salad' && out.classes.includes('interactive')) invalid('SaladCloud is batch only');
    if (provider === 'reserved' && out.interruptible_allowed) invalid('a reserved server cannot be interruptible');
    return out;
}
function globalInput(body, current) {
    const out = { ...current };
    for (const [k, v] of Object.entries(body)) {
        if (k === 'quote_only') { if (typeof v !== 'boolean') invalid('quote_only must be true or false'); out[k] = v; }
        else if (['monthly_cap_nano', 'interactive_cap_nano', 'batch_cap_nano'].includes(k)) out[k] = nano(v, k);
        else invalid('unknown global setting ' + k);
    }
    const cap = BigInt(out.monthly_cap_nano || 0);
    for (const key of ['interactive_cap_nano', 'batch_cap_nano']) if (out[key] != null && BigInt(out[key]) > cap) invalid(key + ' exceeds the monthly cap');
    return out;
}

function createGpuPolicy({ db, settings, clock = { now: () => Date.now() } }) {
    async function row(scope) {
        const found = await db.prepare('SELECT settings FROM gpu_supply_policy WHERE scope = ?').get(scope);
        return found ? JSON.parse(found.settings) : null;
    }
    async function read() {
        const values = settings.gpus.values();
        const summary = await settings.gpus.store.summary();
        const global = { ...GLOBAL, ...(await row('global') || {}), monthly_cap_nano: values.monthly_cap };
        const providers = [];
        for (const key of PROVIDERS) {
            const marker = summary.secrets && summary.secrets[`${key === 'runpod_serverless' ? 'runpod' : key}.key`];
            const saved = await row(key);
            const policy = effectiveProvider(key, saved, Boolean(marker));
            providers.push({ key, ...policy, configured: Boolean(saved), key_state: key === 'reserved' ? { required: false } : { required: true, present: Boolean(marker), last_four: marker?.hint || null } });
        }
        return { global, providers };
    }
    async function save(scope, body, actor, trace = null) {
        if (scope !== 'global' && !PROVIDERS.includes(scope)) invalid('unknown GPU provider');
        if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('settings must be an object');
        let before;
        if (scope === 'global') {
            before = { ...GLOBAL, monthly_cap_nano: settings.gpus.values().monthly_cap, ...(await row('global') || {}) };
        } else {
            const summary = await settings.gpus.store.summary();
            const marker = summary.secrets && summary.secrets[`${scope === 'runpod_serverless' ? 'runpod' : scope}.key`];
            before = effectiveProvider(scope, await row(scope), Boolean(marker));
        }
        const after = scope === 'global' ? globalInput(body, before) : providerInput(body, before, scope);
        const changes = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
        if (!changes.length) return scope === 'global' ? (await read()).global : (await read()).providers.find(x => x.key === scope);
        // The existing GPU budget remains the one cap the provisioner checks.
        if (scope === 'global' && changes.includes('monthly_cap_nano')) {
            await settings.gpus.store.apply({ monthly_cap: Number(after.monthly_cap_nano || 0) }, { merge: true, actor: { type: 'user', id: actor }, reason: 'GPU supply monthly cap' });
        }
        if (scope === 'global' && changes.includes('quote_only')) {
            await settings.gpus.store.apply({ dry_run: after.quote_only }, { merge: true, actor: { type: 'user', id: actor }, reason: 'GPU supply quote-only switch' });
        }
        const persist = { ...after };
        if (scope === 'global') delete persist.monthly_cap_nano;
        const at = new Date(clock.now()).toISOString();
        await db.tx(async tdb => {
            await tdb.prepare('INSERT INTO gpu_supply_policy(scope,settings,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET settings=excluded.settings,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(scope, JSON.stringify(persist), actor, at);
            for (const setting of changes) await tdb.prepare('INSERT INTO audit_log(at,actor,action,target_type,target_id,trace_id,metadata) VALUES(?,?,?,?,?,?,?)')
                .run(at, actor, 'gpu.policy.change', 'gpu_supply_policy', scope, trace, JSON.stringify({ setting: `${scope}.${setting}`, old: before[setting] ?? null, new: after[setting] ?? null }));
        });
        return scope === 'global' ? (await read()).global : (await read()).providers.find(x => x.key === scope);
    }
    async function setKey(provider, value, actor, trace = null) {
        if (!PROVIDERS.includes(provider) || provider === 'reserved') invalid('unknown keyed GPU provider');
        const key = provider === 'runpod_serverless' ? 'runpod' : provider;
        if (typeof value !== 'string' || value.length < 8 || value.length > 400 || /\s/.test(value)) invalid('key must be 8-400 characters without spaces');
        const old = Boolean((await settings.gpus.store.summary()).secrets?.[`${key}.key`]);
        const marker = await settings.gpus.store.setSecret(`${key}.key`, value, { actor: { type: 'user', id: actor }, reason: 'GPU provider key' });
        await db.prepare('INSERT INTO audit_log(at,actor,action,target_type,target_id,trace_id,metadata) VALUES(?,?,?,?,?,?,?)')
            .run(new Date(clock.now()).toISOString(), actor, 'gpu.policy.change', 'gpu_supply_policy', provider, trace, JSON.stringify({ setting: `${provider}.key`, old, new: true }));
        return { present: true, last_four: marker.hint || null };
    }
    return { read, save, setKey };
}

module.exports = { createGpuPolicy, PROVIDERS, DEFAULTS, GLOBAL, defaultsFor, effectiveProvider };
