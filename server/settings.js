'use strict';
/**
 * Owner settings (D11): AI's configuration on openvibe-shared/config.
 *
 *   ai.exchange        the AI Exchange's switches: the model catalogue, Billing Credits (danger) and the
 *                      routing-evidence flag with its parameters. Every key keeps today's environment variable
 *                      as its x-env pin, so the env wins while it is set and nothing changes until the owner sets
 *                      one; onActivate puts a change into the live config object.
 *   ai.provider_keys   the home of the owner's provider keys, replacing the provider_secrets vault. For each
 *                      provider `<p>.origin` is the origin of its base URL (AI writes it whenever a provider is
 *                      created or its base URL changes) and `<p>.key` is the secret, x-bind'ed to `<p>.origin`, so
 *                      a key can never be sent to a host it was not entered for.
 *
 * The provider pool resolves a key synchronously (server/vault.js holds the in-process cache), so the provider-key
 * store refreshes that cache in onActivate. The proxy below lets the factory rebuild the namespace's schema when a
 * provider is added, without remounting the admin routes.
 */
const { createConfigStore, ConfigError } = require('openvibe-shared/config');
const { AiError } = require('./util');

const EXCHANGE_NAMESPACE = 'ai.exchange';
const PROVIDER_KEYS_NAMESPACE = 'ai.provider_keys';
const SERVICE = 'ai';
const SELF = Object.freeze({ type: 'service', id: SERVICE });
const GROUP = 'AI Exchange';
const PROVIDER_GROUP = 'Provider keys';

/** Bounds from server/config.js (load()), so the schema and the code agree. */
const EXCHANGE_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AI Exchange',
    type: 'object',
    additionalProperties: false,
    properties: {
        model_catalog: {
            type: 'boolean', title: 'Model catalogue', 'x-group': GROUP, 'x-env': 'AI_MODEL_CATALOG',
            description: 'Serve the truthful model catalogue: exact ids, dynamic aliases and the offers each route can use. Off means today\'s single `openvibe` model.',
        },
        credits: {
            type: 'boolean', title: 'Credits', 'x-group': GROUP, 'x-env': 'AI_CREDITS', 'x-danger': true,
            description: 'Paid AI requests hold and spend Credits',
        },
        routing_evidence: {
            type: 'boolean', title: 'Routing evidence', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE',
            description: 'Rank alias routes by measured cost per success instead of their recorded order.',
        },
        alpha: {
            type: 'number', title: 'Evidence EWMA alpha', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_ALPHA',
            minimum: 0.01, maximum: 1,
            description: 'How fast a new measurement moves the per-deployment EWMA (0.01 keeps the most history, 1 trusts the last call).',
        },
        min_samples: {
            type: 'integer', title: 'Minimum samples', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_MIN_SAMPLES',
            minimum: 1,
            description: 'Below this many attempts evidence is sparse: it is reported, never trusted to reorder a route.',
        },
        success_floor: {
            type: 'number', title: 'Success floor', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_SUCCESS_FLOOR',
            minimum: 0.01, maximum: 1,
            description: 'A candidate below this success probability is never promoted by evidence.',
        },
        hysteresis_decisions: {
            type: 'integer', title: 'Hysteresis decisions', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_DECISIONS',
            minimum: 1,
            description: 'Consecutive decisions a challenger must win before it replaces the incumbent.',
        },
        exploration_share: {
            type: 'number', title: 'Exploration share', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_EXPLORE',
            minimum: 0, maximum: 1,
            description: 'The share of decisions that explore a challenger; 0 never leaves the incumbent.',
        },
        affinity_gain: {
            type: 'number', title: 'Affinity gain', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_AFFINITY',
            minimum: 0, maximum: 1,
            description: 'How much a deployment\'s familiarity with a prompt family adds to its measured score.',
        },
        min_gain: {
            type: 'number', title: 'Minimum gain', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_MIN_GAIN',
            minimum: 0, maximum: 1,
            description: 'A challenger replaces the incumbent only when it scores at least this much better.',
        },
        expected_output_tokens: {
            type: 'integer', title: 'Expected output tokens', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_OUTPUT_TOKENS',
            minimum: 1,
            description: 'The output-token estimate used to price a candidate before it answers.',
        },
    },
});

/** The store's effective values put into the live config object (undefined keys keep the code/env default). */
function applyExchange(config, values = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(values, k) && values[k] !== undefined;
    if (has('model_catalog')) config.modelCatalog.enabled = Boolean(values.model_catalog);
    if (has('credits')) config.credits.enabled = Boolean(values.credits);
    const re = config.routingEvidence;
    if (has('routing_evidence')) re.enabled = Boolean(values.routing_evidence);
    for (const key of ['alpha', 'min_samples', 'success_floor', 'hysteresis_decisions', 'exploration_share', 'affinity_gain', 'min_gain', 'expected_output_tokens']) {
        if (has(key)) re[key] = Number(values[key]);
    }
}

/** The origin a provider key is bound to ('' when the base URL is missing or not http(s)). */
function originOf(baseUrl) {
    if (!baseUrl) return '';
    try {
        const u = new URL(String(baseUrl).trim());
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
    } catch { return ''; }
}

/** The namespace for the providers there are today: <p>.origin (internal) and <p>.key (secret, bound to it). */
function providerKeysSchema(providers) {
    const properties = {};
    for (const key of providers) {
        properties[`${key}.origin`] = {
            type: 'string', title: `${key} origin`, 'x-group': PROVIDER_GROUP,
            description: `The origin of ${key}'s base URL. AI writes it; the key below is sealed to it.`,
        };
        properties[`${key}.key`] = {
            type: 'string', title: `${key} key`, 'x-group': PROVIDER_GROUP, 'x-bind': `${key}.origin`,
            description: `The owner's write-only API key for ${key}, sealed to its origin; changing the base URL locks it until it is entered again.`,
        };
    }
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'AI provider keys', type: 'object', additionalProperties: false, properties };
}

const classify = (key) => (String(key).endsWith('.key') ? 'secret' : 'internal');

/**
 * The ai.provider_keys store, with the schema rebuilt when a provider is added. `store` is a Proxy so the admin
 * routes, mounted once, keep using the current store; the vault cache is refreshed in onActivate.
 */
function createProviderKeys({ db, registry, env = process.env, log = console, onChange }) {
    const vault = require('./vault');
    let store = null;
    let names = [];
    let queue = Promise.resolve();
    const serialized = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

    /** onActivate: refresh the synchronous cache and rebuild the adapters of providers whose key changed. */
    async function activate(values, prev) {
        vault.refresh(values);
        const changed = new Set();
        for (const [k, v] of Object.entries(values || {})) {
            if (k.endsWith('.key') && (!prev || prev[k] !== v)) changed.add(k.slice(0, -4));
        }
        for (const k of Object.keys(prev || {})) if (k.endsWith('.key') && !(values && Object.prototype.hasOwnProperty.call(values, k))) changed.add(k.slice(0, -4));
        for (const key of changed) {
            if (!await registry.getProvider(key)) continue;
            // The pool's adapter cache stamps itself with updated_at: bumping it rebuilds the adapter with the new key.
            await registry.upsertProvider({ key }, { actor: `service:${SERVICE}`, origin: 'settings' }).catch((err) => log.warn(`[config] ${PROVIDER_KEYS_NAMESPACE}: ${key} adapter refresh failed: ${err.message}`));
        }
    }

    async function rebuild() {
        const providers = await registry.listProviders();
        const next = [...new Set(providers.map((p) => p.key))].sort();
        if (store && next.length === names.length && next.every((k, i) => k === names[i])) return store;
        store = await createConfigStore({
            db, service: SERVICE, namespace: PROVIDER_KEYS_NAMESPACE, schema: providerKeysSchema(next),
            classify, env, log, onChange, onActivate: activate,
        });
        names = next;
        vault.refresh(store.get());
        return store;
    }

    const proxy = new Proxy({}, {
        get(_target, prop) {
            if (prop === 'namespace') return PROVIDER_KEYS_NAMESPACE;
            if (prop === 'service') return SERVICE;
            if (prop === 'then') return undefined;
            if (prop === 'setSecret') return async (key, value, o) => {
                try { return await setKey(String(key).replace(/\.key$/, ''), value, o); }
                catch (err) { throw err instanceof ConfigError ? err : new ConfigError(err.code || 'config.secret_invalid', err.message, { status: err.status || 422 }); }
            };
            if (!store) throw new AiError(503, 'config.unavailable', 'the provider keys store is not ready');
            const value = store[prop];
            return typeof value === 'function' ? value.bind(store) : value;
        },
    });

    async function refresh() { return serialized(rebuild); }

    async function ensure(providerKey) {
        if (!names.includes(providerKey)) await rebuild();
        if (!names.includes(providerKey)) throw new AiError(422, 'ai.invalid', `add the provider ${providerKey} before its key`);
    }

    function setOrigin(providerKey, baseUrl, { actor = SELF, reason = 'provider origin' } = {}) {
        return serialized(async () => {
            await ensure(providerKey);
            const origin = originOf(baseUrl);
            if (!origin) return '';
            const key = `${providerKey}.origin`;
            const changes = await store.changes({ [key]: origin }, { merge: true });
            if (changes.length) await store.apply({ [key]: origin }, { merge: true, actor, reason });
            return origin;
        });
    }

    /** A provider key: write-only, sealed and bound to the provider's current origin. */
    function setKey(providerKey, value, { actor = SELF, reason = 'provider key' } = {}) {
        return serialized(async () => {
            const provider = await registry.getProvider(providerKey);
            if (!provider) throw new AiError(422, 'ai.invalid', `add the provider ${providerKey} before its key`);
            await ensure(providerKey);
            const origin = originOf(provider.base_url);
            if (!origin) throw new AiError(422, 'ai.invalid', `${providerKey} has no base URL to bind its key to`);
            const originKey = `${providerKey}.origin`;
            if ((await store.changes({ [originKey]: origin }, { merge: true })).length) {
                await store.apply({ [originKey]: origin }, { merge: true, actor: SELF, reason: 'provider origin' });
            }
            return await store.setSecret(`${providerKey}.key`, value, { actor, reason });
        });
    }

    function deleteKey(providerKey, o = {}) {
        return serialized(async () => {
            if (!names.includes(providerKey)) return null;
            return await store.deleteSecret(`${providerKey}.key`, o);
        });
    }

    /** Write every provider's current origin (boot, and a provider created or moved by the API). */
    function syncOrigins({ actor = SELF, reason = 'provider origin' } = {}) {
        return serialized(async () => {
            await rebuild();
            const values = {};
            for (const p of await registry.listProviders()) {
                const origin = originOf(p.base_url);
                if (origin) values[`${p.key}.origin`] = origin;
            }
            const changes = await store.changes(values, { merge: true });
            if (changes.length) await store.apply(values, { merge: true, actor, reason });
            return changes.length;
        });
    }

    return {
        proxy,
        refresh,
        setOrigin,
        setKey,
        deleteKey,
        syncOrigins,
        namespace: PROVIDER_KEYS_NAMESPACE,
        get sealed() { return Boolean(store && store.sealed); },
        get store() { return store; },
        get providers() { return [...names]; },
    };
}

/**
 * Create both namespaces (the DDL is migrations/0027_config.sql), apply ai.exchange to the live config object,
 * load the provider-key cache and reseal plaintext/old-KEK rows once when OV_CONFIG_KEKS is set.
 */
async function createSettings({ db, config, registry, clock = { now: () => Date.now() }, env = process.env, log = console, onExchange = null }) {
    const onChange = async ({ namespace, keys, actor, revision }) => {
        const who = actor ? `${actor.type}:${actor.id}` : 'system';
        await registry.audit(who, 'config.change', 'config', namespace, { metadata: { service: SERVICE, namespace, keys, actor: who, revision } });
    };
    const exchange = await createConfigStore({
        db, service: SERVICE, namespace: EXCHANGE_NAMESPACE, schema: EXCHANGE_SCHEMA, env, log, onChange,
        onActivate: (values) => {
            applyExchange(config, values);
            return onExchange ? onExchange(values) : undefined;
        },
    });
    applyExchange(config, exchange.get());
    const providerKeys = createProviderKeys({ db, registry, env, log, onChange });
    await providerKeys.refresh();
    if (exchange.sealed) await exchange.reseal().catch((err) => log.warn(`[config] ${EXCHANGE_NAMESPACE}: reseal failed: ${err.message}`));
    if (providerKeys.sealed) await providerKeys.store.reseal().catch((err) => log.warn(`[config] ${PROVIDER_KEYS_NAMESPACE}: reseal failed: ${err.message}`));
    return { exchange, providerKeys, onChange };
}

module.exports = {
    EXCHANGE_NAMESPACE, PROVIDER_KEYS_NAMESPACE, SERVICE, SELF, EXCHANGE_SCHEMA,
    applyExchange, originOf, providerKeysSchema, createSettings,
};
