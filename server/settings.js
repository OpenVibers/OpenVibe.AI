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
const { keyPage } = require('./owner-inputs');

const EXCHANGE_NAMESPACE = 'ai.exchange';
const PROVIDER_KEYS_NAMESPACE = 'ai.provider_keys';
const GPU_NAMESPACE = 'ai.gpus';
const SERVICE = 'ai';
const SELF = Object.freeze({ type: 'service', id: SERVICE });
const GROUP = 'AI Exchange';
const PROVIDER_GROUP = 'Provider keys';
const GPU_GROUP = 'OpenVibe GPUs';
// The marketplaces the GPU provisioner rents from. AI owns these origins and writes them into the
// namespace, so the owner's key is sealed to the marketplace it was entered for.
const GPU_ORIGINS = Object.freeze({ vast: 'https://console.vast.ai', runpod: 'https://api.runpod.io' });

/**
 * Bounds from server/config.js (load()), so the schema and the code agree. Every field has a title in plain words and
 * a description that says what it does, what happens at the default and what more or less means (the owner-setup
 * design's clarity rules); the routing-evidence tuning is x-advanced, folded under "Advanced settings".
 */
const EXCHANGE_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'What the Exchange offers',
    description: 'Which models people can pick on openvibe.exchange, whether paid AI spends Credits, and how AI chooses between the models of a route. Change these when you open the Exchange, start charging, or want AI to learn which model works best.',
    type: 'object',
    additionalProperties: false,
    properties: {
        model_catalog: {
            type: 'boolean', title: 'List every model by name', 'x-group': GROUP, 'x-env': 'AI_MODEL_CATALOG',
            description: 'When on, the Exchange and the API list every model by its exact name, with the providers that can serve it. Off (the default) shows a single model called "openvibe" that picks one for the person.',
        },
        credits: {
            type: 'boolean', title: 'Charge Credits for paid AI', 'x-group': GROUP, 'x-env': 'AI_CREDITS', 'x-danger': true,
            description: 'When on, a paid AI request first holds Credits from the person\'s balance and then spends what it used. Off (the default) charges nothing. Turn it on only after Billing\'s Credits are open; turning it off again stops charging at once.',
        },
        routing_evidence: {
            type: 'boolean', title: 'Pick models by measured results', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE',
            description: 'When on, AI orders the models of a route by what each one really cost per good answer, measured from recent requests. Off (the default) keeps the order the route was written in.',
        },
        alpha: {
            type: 'number', title: 'How fast results change the order', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_ALPHA', 'x-advanced': true,
            minimum: 0.01, maximum: 1, 'x-example': 0.2,
            description: 'How much one new request moves a model\'s measured score, from 0.01 to 1 (default 0.2). Higher follows the last few requests; lower remembers a longer history.',
        },
        min_samples: {
            type: 'integer', title: 'Requests before results count', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_MIN_SAMPLES', 'x-advanced': true,
            minimum: 1, 'x-example': 20,
            description: 'A model needs at least this many measured requests before its results may change the order (default 20). Higher waits for more proof; lower trusts results sooner.',
        },
        success_floor: {
            type: 'number', title: 'Lowest success rate to move up', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_SUCCESS_FLOOR', 'x-advanced': true,
            minimum: 0.01, maximum: 1, 'x-example': 0.1,
            description: 'A model that answers well less often than this share of the time (0.1 is one in ten, the default) is never moved up, however cheap it is.',
        },
        hysteresis_decisions: {
            type: 'integer', title: 'Wins needed to take first place', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_DECISIONS', 'x-advanced': true,
            minimum: 1, 'x-example': 3,
            description: 'How many choices in a row a challenger must win before it replaces the model in first place (default 3). Higher keeps the order steady; lower switches sooner.',
        },
        exploration_share: {
            type: 'number', title: 'Share of requests that try another model', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_EXPLORE', 'x-advanced': true,
            minimum: 0, maximum: 1, 'x-example': 0.05,
            description: 'The share of requests sent to a challenger to measure it, from 0 to 1 (default 0: never). 0.05 tries another model on one request in twenty.',
        },
        affinity_gain: {
            type: 'number', title: 'Bonus for a model that knows the task', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_AFFINITY', 'x-advanced': true,
            minimum: 0, maximum: 1, 'x-example': 0.05,
            description: 'How much a model\'s past success on the same kind of prompt adds to its score, from 0 to 1 (default 0.05). Higher keeps a task on the model that did it well.',
        },
        min_gain: {
            type: 'number', title: 'How much better a challenger must be', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_MIN_GAIN', 'x-advanced': true,
            minimum: 0, maximum: 1, 'x-example': 0.15,
            description: 'A challenger replaces the first model only when it scores at least this much better, from 0 to 1 (default 0.15, fifteen percent). Higher switches less often.',
        },
        expected_output_tokens: {
            type: 'integer', title: 'Expected answer length (tokens)', 'x-group': GROUP, 'x-env': 'AI_ROUTING_EVIDENCE_OUTPUT_TOKENS', 'x-advanced': true,
            minimum: 1, 'x-example': 512,
            description: 'The answer length, in tokens (about three quarters of a word each), used to price a model before it answers (default 512). Raise it when most answers are long.',
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
    description: 'The GPUs AI rents by the second to run open models, the key of the marketplace it rents from and the most it may spend in a month. Change these to start renting, to move to another marketplace or to raise or lower the cap.',
    type: 'object',
    additionalProperties: false,
    properties: {
        'vast.origin': {
            type: 'string', title: 'Address the Vast.ai key is locked to', 'x-group': GPU_GROUP, 'x-advanced': true,
            description: 'The Vast.ai address AI sends the key to. AI writes it itself; the key below only opens for this address, so it can never be sent anywhere else.',
        },
        'vast.key': {
            type: 'string', title: 'Vast.ai API key', 'x-group': GPU_GROUP, 'x-bind': 'vast.origin',
            description: 'The key AI rents Vast.ai GPUs with. Without it (and without a RunPod key) no GPU is rented. It is locked after saving and never shown again, only its last four characters.',
            'x-example': 'a1b2c3…',
            'x-owner-input': {
                group: 'gpus',
                unlocks: 'Lets AI rent Vast.ai GPUs to run open models when they are needed. Without a GPU key and a monthly cap nothing is rented.',
                get_it_at: 'https://cloud.vast.ai/manage-keys/',
                get_it_how: 'Create an API key with the Instance read and write permissions, for the account whose credit pays for the GPUs.',
                test: true,
            },
        },
        'runpod.origin': {
            type: 'string', title: 'Address the RunPod key is locked to', 'x-group': GPU_GROUP, 'x-advanced': true,
            description: 'The RunPod address AI sends the key to. AI writes it itself; the key below only opens for this address, so it can never be sent anywhere else.',
        },
        'runpod.key': {
            type: 'string', title: 'RunPod API key', 'x-group': GPU_GROUP, 'x-bind': 'runpod.origin',
            description: 'The key AI rents RunPod GPUs with. Without it (and without a Vast.ai key) no GPU is rented. It is locked after saving and never shown again, only its last four characters.',
            'x-example': 'rpa_…',
            'x-owner-input': {
                group: 'gpus',
                unlocks: 'Lets AI rent RunPod GPUs to run open models when they are needed. Without a GPU key and a monthly cap nothing is rented.',
                get_it_at: 'https://www.runpod.io/console/user/settings',
                get_it_how: 'Under API Keys create a key with Read/Write access, for the account whose balance pays for the GPUs.',
                test: true,
            },
        },
        monthly_cap: {
            type: 'integer', title: 'Most the GPUs may cost in a month', 'x-group': GPU_GROUP, 'x-unit': 'nano_usd', 'x-danger': true,
            minimum: 0, 'x-example': 50000000000,
            description: 'The most the rented GPUs may cost in one calendar month (in billionths of a dollar: 50000000000 is $50). AI never passes it: it refuses to start a GPU and says why. Unset, nothing is rented.',
            'x-owner-input': {
                group: 'gpus',
                unlocks: 'Lets AI rent GPUs up to this amount each month. Without a cap nothing is rented, even with a key.',
                get_it_at: 'https://ai.openvibe.services/console/gpus',
                get_it_how: 'Pick the most you are happy to spend on GPUs in a month; the GPU page shows what this month has cost so far.',
                test: false,
            },
            'x-required-for': 'Renting GPUs',
        },
        idle_minutes: {
            type: 'integer', title: 'Minutes a GPU may sit unused (minutes)', 'x-group': GPU_GROUP,
            minimum: 1, maximum: 1440, 'x-example': 10,
            description: 'How many minutes a rented GPU may serve nobody before it is given back (default 10). Higher answers the next request faster; lower costs less.',
        },
        max_runtime_minutes: {
            type: 'integer', title: 'Longest one GPU may run (minutes)', 'x-group': GPU_GROUP,
            minimum: 1, maximum: 10080, 'x-example': 720,
            description: 'How many minutes one rented GPU may run at most before it is given back, busy or not (default 720, twelve hours). Lower limits what one GPU can cost.',
        },
        warm_window: {
            type: 'string', title: 'Hours to keep GPUs ready (UTC)', 'x-group': GPU_GROUP,
            pattern: '^([0-2][0-9]):[0-5][0-9]-([0-2][0-9]):[0-5][0-9]$', 'x-example': '19:00-23:00',
            description: 'A daily window, in UTC, when an unused GPU stays rented so the first answer is fast, written like 19:00-23:00. Empty (the default) gives every unused GPU back after the idle minutes.',
        },
        region: {
            type: 'string', title: 'Region the GPUs must be in', 'x-group': GPU_GROUP, 'x-example': 'US',
            description: 'The region a rented GPU must be in, as the marketplace names it (default US). Another region may be cheaper but answers people here more slowly.',
        },
    },
});

/** Providers that never take a key: the stub, whisper.cpp and the local model servers (auth_mode none). */
const keyless = (p) => p.kind === 'stub' || p.kind === 'whisper' || p.auth_mode === 'none';

/**
 * The namespace for the providers there are today: <p>.origin (internal, advanced) and <p>.key (secret, bound to it).
 * `providers` are registry records (a bare key is accepted too). A provider that takes a key is an owner input in the
 * Setup tab's "AI providers" group, with its key page and a test (its model list); the shared provider's key is also
 * the image model's key, because images run on the shared provider's Images API (AI_IMAGE_MODEL).
 */
function providerKeysSchema(providers, { imageModel = '' } = {}) {
    const properties = {};
    for (const raw of providers) {
        const p = typeof raw === 'string' ? { key: raw } : raw;
        const key = p.key;
        const name = p.display_name || key;
        properties[`${key}.origin`] = {
            type: 'string', title: `Address the ${name} key is locked to`, 'x-group': PROVIDER_GROUP, 'x-advanced': true,
            description: `The address of ${name}'s API that its key is sent to. AI writes it from the provider's base URL; the key only opens for this address, so it can never be sent anywhere else.`,
        };
        const field = {
            type: 'string', title: `${name} API key`, 'x-group': PROVIDER_GROUP, 'x-bind': `${key}.origin`,
            description: `The key AI uses to call ${name}. It is locked after saving and never shown again, only its last four characters; changing the provider's base URL locks it until it is entered again.`,
        };
        if (keyless(p)) {
            field.title = `${name} key (not used)`;
            field.description = `${name} runs without a key, so nothing needs to be entered here. A key saved here would be sent only to the address above.`;
            field['x-advanced'] = true;
        } else {
            const page = keyPage(p);
            const images = key === 'shared' && imageModel;
            field['x-owner-input'] = {
                group: 'ai-providers',
                unlocks: images
                    ? `Lets AI answer with ${name}'s models and make pictures with ${imageModel}. Without a working key ${name} is skipped and image generation stays off.`
                    : key === 'shared' && p.kind !== 'anthropic'
                        ? `Lets AI answer with ${name}'s models; it is also the image model's key once an image model is chosen (AI_IMAGE_MODEL). Without a working key ${name} is skipped.`
                        : `Lets AI answer with ${name}'s models. Without a working key ${name} is skipped and its requests go to the next provider.`,
                ...(page.get_it_at ? { get_it_at: page.get_it_at } : {}),
                get_it_how: page.get_it_how,
                test: true,
            };
            if (images) field['x-required-for'] = 'Image generation';
        }
        properties[`${key}.key`] = field;
    }
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'AI providers',
        description: 'The companies whose models OpenVibe can use, and the key for each. Add or replace a key when you sign up with a provider or rotate a key; a provider with no working key is skipped.',
        type: 'object', additionalProperties: false, properties,
    };
}

const classify = (key) => (String(key).endsWith('.key') ? 'secret' : 'internal');

/**
 * The ai.provider_keys store, with the schema rebuilt when a provider is added. `store` is a Proxy so the admin
 * routes, mounted once, keep using the current store; the vault cache is refreshed in onActivate.
 */
function createProviderKeys({ db, registry, env = process.env, log = console, onChange, imageModel = '' }) {
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
        const records = next.map((k) => providers.find((p) => p.key === k));
        store = await createConfigStore({
            db, service: SERVICE, namespace: PROVIDER_KEYS_NAMESPACE, schema: providerKeysSchema(records, { imageModel }),
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
    const providerKeys = createProviderKeys({ db, registry, env, log, onChange, imageModel: (config.image && config.image.model) || '' });
    await providerKeys.refresh();
    const gpus = await createGpuSettings({ db, env, log, onChange });
    if (exchange.sealed) await exchange.reseal().catch((err) => log.warn(`[config] ${EXCHANGE_NAMESPACE}: reseal failed: ${err.message}`));
    if (providerKeys.sealed) await providerKeys.store.reseal().catch((err) => log.warn(`[config] ${PROVIDER_KEYS_NAMESPACE}: reseal failed: ${err.message}`));
    return { exchange, providerKeys, gpus, onChange };
}

module.exports = {
    EXCHANGE_NAMESPACE, PROVIDER_KEYS_NAMESPACE, GPU_NAMESPACE, SERVICE, SELF, EXCHANGE_SCHEMA, GPU_SCHEMA, GPU_ORIGINS,
    applyExchange, originOf, providerKeysSchema, createGpuSettings, createSettings,
};
