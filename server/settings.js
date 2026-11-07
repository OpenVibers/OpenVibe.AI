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
const GPU_NAMESPACE = 'ai.gpus';
const SERVICE = 'ai';
const SELF = Object.freeze({ type: 'service', id: SERVICE });
const GROUP = 'AI Exchange';
const BATCHES_NAMESPACE = 'ai.batches';
const PROVIDER_GROUP = 'Provider keys';
const GPU_GROUP = 'OpenVibe GPUs';
// The marketplaces the GPU provisioner rents from. AI owns these origins and writes them into the
// namespace, so the owner's key is sealed to the marketplace it was entered for.
const GPU_ORIGINS = Object.freeze({ vast: 'https://console.vast.ai', runpod: 'https://api.runpod.io' });

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

/**
 * The ai.batches store: the owner's batch settings.
 *
 *   loss_budget_usd_per_day  how much the network may lose per UTC day by answering a batch on ordinary
 *                            capacity after its deadline. Zero (the default) means it never does: a batch
 *                            that finds no spare low-cost capacity expires, and the customer is charged
 *                            nothing.
 */
const BATCH_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AI batches',
    type: 'object',
    additionalProperties: false,
    properties: {
        loss_budget_usd_per_day: {
            type: 'number', title: 'Batch loss budget (per day)', 'x-group': 'money', 'x-owner-input': true,
            'x-env': 'AI_BATCH_LOSS_BUDGET_USD_PER_DAY', minimum: 0,
            description: 'How much the network may lose per day by answering a batch on ordinary capacity after its deadline. Zero means a batch that finds no spare low-cost capacity expires and the customer is charged nothing.',
        },
    },
});

/** The store's effective values put into the live config object (undefined keys keep the code/env default). */
function applyBatches(config, values = {}) {
    if (!config.batches) return;
    if (Object.prototype.hasOwnProperty.call(values, 'loss_budget_usd_per_day') && values.loss_budget_usd_per_day !== undefined) {
        config.batches.lossBudgetUsdPerDay = Math.max(0, Number(values.loss_budget_usd_per_day) || 0);
    }
}

/** The ai.batches store: the owner's batch settings. */
async function createBatchesSettings({ db, env, log, onChange }) {
    const store = await createConfigStore({
        db, service: SERVICE, namespace: BATCHES_NAMESPACE, schema: BATCH_SCHEMA, env, log, onChange,
    });
    return { store, proxy: store, namespace: BATCHES_NAMESPACE, values: () => store.get() || {} };
}

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

/**
 * The ai.gpus namespace: the owner's GPU settings.
 *
 *   vast.origin / vast.key      Vast.ai: the origin AI owns and the owner's write-only API key, sealed
 *                                to that origin (a key can never be sent to another host).
 *   runpod.origin / runpod.key  the same for RunPod.
 *   monthly_cap                 the hard monthly cap in nano-USD. The provisioner never passes it: it
 *                                refuses to start an instance and says why. It is a money key, so it
 *                                needs a fresh sign-in to change.
 *   idle_minutes                how long an unused instance stays up before it scales to zero.
 *   max_runtime_minutes         how long one instance may run at most (its reservation).
 *   warm_window                 an optional window (UTC, "19:00-23:00") in which idle instances stay up.
 *   region                      the region the marketplace offers must be in.
 */
const GPU_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'OpenVibe GPUs',
    type: 'object',
    additionalProperties: false,
    properties: {
        'vast.origin': {
            type: 'string', title: 'Vast.ai origin', 'x-group': GPU_GROUP,
            description: 'The origin of the Vast.ai API. AI writes it; the key below is sealed to it.',
        },
        'vast.key': {
            type: 'string', title: 'Vast.ai API key', 'x-group': GPU_GROUP, 'x-bind': 'vast.origin',
            description: "The owner's write-only Vast.ai API key, sealed to the origin above.",
            'x-owner-input': {
                group: 'GPUs',
                unlocks: 'Lets OpenVibe rent a GPU on Vast.ai for OpenVibe GPUs and for a person’s own endpoint. Without it Vast.ai is never searched and nothing is rented there.',
                get_it_at: 'https://console.vast.ai/account/',
                get_it_how: 'Open Account → API Keys, create a key, and paste it here. It is stored locked and never shown again.',
                test: false,
            },
            'x-required-for': 'own endpoints',
        },
        'runpod.origin': {
            type: 'string', title: 'RunPod origin', 'x-group': GPU_GROUP,
            description: 'The origin of the RunPod API. AI writes it; the key below is sealed to it.',
        },
        'runpod.key': {
            type: 'string', title: 'RunPod API key', 'x-group': GPU_GROUP, 'x-bind': 'runpod.origin',
            description: "The owner's write-only RunPod API key, sealed to the origin above.",
            'x-owner-input': {
                group: 'GPUs',
                unlocks: 'Lets OpenVibe rent a GPU on RunPod when RunPod is cheaper or Vast.ai has no fit. Without it RunPod is never searched and nothing is rented there.',
                get_it_at: 'https://www.runpod.io/console/user/settings',
                get_it_how: 'Open Settings → API Keys, create a key, and paste it here. It is stored locked and never shown again.',
                test: false,
            },
            'x-required-for': 'own endpoints',
        },
        monthly_cap: {
            type: 'integer', title: 'Monthly GPU cap', 'x-group': GPU_GROUP, 'x-unit': 'nano_usd', 'x-danger': true,
            minimum: 0,
            description: 'The hard monthly cap for the rented GPUs, in nano-USD. The provisioner never spends past it: it refuses to start an instance and says why. Without a cap the provisioner stays off.',
            'x-owner-input': {
                group: 'GPUs',
                unlocks: 'Sets the most the rented GPUs may cost you in a month. A new instance (including a person’s own endpoint) is refused before it starts when its time would pass this cap. Without it nothing is rented.',
                get_it_at: 'https://openvibe.network/admin#ai',
                get_it_how: 'Decide the most you are willing to spend on rented GPUs in a month, and enter it here. Lower is safer; higher lets more models and endpoints run.',
                test: false,
            },
            'x-required-for': 'own endpoints',
        },
        idle_minutes: {
            type: 'integer', title: 'Idle minutes', 'x-group': GPU_GROUP,
            minimum: 1, maximum: 1440,
            description: 'How long an instance serves nobody before it scales to zero (the default is 10).',
        },
        max_runtime_minutes: {
            type: 'integer', title: 'Max runtime (minutes)', 'x-group': GPU_GROUP,
            minimum: 1, maximum: 10080,
            description: 'How long one instance may run at most. When the time is up the instance is given back, so the money never runs past the cap (the default is 720).',
        },
        warm_window: {
            type: 'string', title: 'Warm window (UTC)', 'x-group': GPU_GROUP,
            pattern: '^([0-2][0-9]):[0-5][0-9]-([0-2][0-9]):[0-5][0-9]$',
            description: 'An optional window in which idle instances stay up, as "19:00-23:00" (UTC). Empty means no warm window.',
        },
        region: {
            type: 'string', title: 'Region', 'x-group': GPU_GROUP,
            description: 'The region the marketplace offers must be in (the default is US).',
        },
    },
});

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
 * The ai.gpus store: the owner's GPU settings. The marketplace origins are written once (AI owns them),
 * the keys and the cap are the owner's.
 */
async function createGpuSettings({ db, env = process.env, log = console, onChange }) {
    const store = await createConfigStore({
        db, service: SERVICE, namespace: GPU_NAMESPACE, schema: GPU_SCHEMA, classify, env, log, onChange,
    });
    const origins = {};
    for (const [name, origin] of Object.entries(GPU_ORIGINS)) origins[name + '.origin'] = origin;
    const changes = await store.changes(origins, { merge: true });
    if (changes.length) await store.apply(origins, { merge: true, actor: SELF, reason: 'the GPU marketplace origins' });
    if (store.sealed) await store.reseal().catch((err) => log.warn('[config] ' + GPU_NAMESPACE + ': reseal failed: ' + err.message));

    /** The owner's GPU settings. The keys are the secrets; they never leave this process. */
    function values() {
        const v = store.get() || {};
        return {
            vast_origin: String(v['vast.origin'] || ''),
            vast_key: String(v['vast.key'] || ''),
            runpod_origin: String(v['runpod.origin'] || ''),
            runpod_key: String(v['runpod.key'] || ''),
            monthly_cap: v.monthly_cap == null ? null : String(v.monthly_cap),
            idle_minutes: v.idle_minutes == null ? null : Number(v.idle_minutes),
            max_runtime_minutes: v.max_runtime_minutes == null ? null : Number(v.max_runtime_minutes),
            warm_window: String(v.warm_window || ''),
            region: String(v.region || ''),
        };
    }

    return {
        store,
        proxy: store,
        namespace: GPU_NAMESPACE,
        values,
        get sealed() { return Boolean(store.sealed); },
    };
}

/**
 * Create both namespaces (the DDL is migrations/0028_config.sql), apply ai.exchange to the live config object,
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
    const batches = await createBatchesSettings({ db, env, log, onChange });
    applyBatches(config, batches.values());
    const gpus = await createGpuSettings({ db, env, log, onChange });
    if (exchange.sealed) await exchange.reseal().catch((err) => log.warn(`[config] ${EXCHANGE_NAMESPACE}: reseal failed: ${err.message}`));
    if (providerKeys.sealed) await providerKeys.store.reseal().catch((err) => log.warn(`[config] ${PROVIDER_KEYS_NAMESPACE}: reseal failed: ${err.message}`));
    return { exchange, providerKeys, gpus, batches, onChange };
}

module.exports = {
    EXCHANGE_NAMESPACE, PROVIDER_KEYS_NAMESPACE, GPU_NAMESPACE, BATCHES_NAMESPACE, SERVICE, SELF, EXCHANGE_SCHEMA, GPU_SCHEMA, GPU_ORIGINS, BATCH_SCHEMA,
    applyExchange, applyBatches, originOf, providerKeysSchema, createGpuSettings, createBatchesSettings, createSettings,
};
