'use strict';
/**
 * The truthful model catalog (AI Exchange P4, CHECKPOINT D3/D4), behind AI_MODEL_CATALOG.
 *
 * A registry model row becomes an `ai.model@1` catalog entry: its legacy provider/model fields, plus an exact id
 * `<org>/<model>[:<quant>]@<revision>` and the artifact facts (family, variant, quant, revision, sha256, license,
 * capabilities, modalities, retail rate, availability) when the row's metadata names them. Nothing is invented: a
 * row without an artifact revision has no exact id and can only be reached through an alias or the legacy model.
 *
 *   aliases                   the dynamic policies (openvibe/auto, economy, balanced, fast, private; legacy openvibe)
 *   entries({ registry })     the registry's real (non-synthetic) models in the ai.model@1 shape
 *   exactOffers({ registry, id })  the provider offers of one exact artifact (never another model)
 *   select({ registry, model, route })
 *                             a request's `model`: an alias turns into the same route with the alias policy's
 *                             placement constraints; an exact id returns only its own deployments (never a substitute)
 *   facts({ registry, providerRecord, model, policy, fallbackReason })
 *                             one `openvibe` disclosure: resolved_model, revision, deployment, provider_access,
 *                             rate_version, policy, fallback_reason
 *
 * Commercial access is the provider offer's `provider_access` (migrations/0024), defaulting to UNVERIFIED. Paid
 * managed routing (the network's providers, never a person's own key) accepts only OWN_DEPLOYMENT and
 * AUTHORIZED_WHOLESALE; RESTRICTED, CUSTOMER_BYOK and UNVERIFIED offers are never resold as managed capacity.
 *
 * The ai.model@1 catalog shape is CHECKPOINT D4 (Contracts 0.284.0); apps call with ai.app.run (D8'), and the
 * route disclosure joins x_openvibe (D3').
 */
const { AiError } = require('../util');

const ACCESS = ['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED'];
const MANAGED_ACCESS = ['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE'];
const EXACT_ID = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(:[a-zA-Z0-9._-]+)?@[a-zA-Z0-9._-]+$/;

/** The dynamic policy aliases (D3). Legacy `openvibe` is `openvibe/auto` under its old name. */
const ALIASES = [
    { id: 'openvibe', legacy: 'openvibe', policy: 'auto', name: 'OpenVibe AI', description: 'The legacy name of openvibe/auto: the balanced router picks the model per request and says which one answered.' },
    { id: 'openvibe/auto', policy: 'auto', name: 'Auto', description: 'Picks among the eligible models per request; the response says which model answered and why.' },
    { id: 'openvibe/economy', policy: 'cheapest', name: 'Economy', description: 'The lowest cost per successful answer among the eligible models.' },
    { id: 'openvibe/balanced', policy: 'balanced', name: 'Balanced', description: 'Cost, health and measured latency weighed together.' },
    { id: 'openvibe/fast', policy: 'fastest', name: 'Fast', description: 'The quickest measured offer among the eligible models.' },
    { id: 'openvibe/private', policy: 'private', name: 'Private', description: 'Only OpenVibe-run or local capacity; never an external provider.' },
].map((a) => ({
    ...a,
    object: 'model',
    type: 'chat',
    dynamic: true,
    capabilities: ['chat', 'json', 'stream'],
    modalities: ['text'],
    availability: 'available',
}));

const accessOf = (provider) => (provider && ACCESS.includes(provider.provider_access) ? provider.provider_access : 'UNVERIFIED');
const managedAccessAllowed = (provider) => MANAGED_ACCESS.includes(accessOf(provider));

/** The artifact an exact id names, from a model row's metadata (or its own metadata.id). Null when unknown. */
function artifactOf(row, provider) {
    const meta = (row && row.metadata) || {};
    if (typeof meta.id === 'string' && EXACT_ID.test(meta.id)) {
        const m = /^([^/]+)\/([^:@]+)(?::([^@]+))?@(.+)$/.exec(meta.id);
        return { id: meta.id, org: m[1], model: m[2], quant: m[3] || null, revision: m[4] };
    }
    if (!meta.revision) return null;
    const key = String((row && row.model_key) || '');
    const at = key.lastIndexOf('@');
    const base = at > 0 ? key.slice(0, at) : key;
    const slash = base.indexOf('/');
    const org = meta.org || (slash > 0 ? base.slice(0, slash) : (provider && provider.key));
    const model = meta.model || (slash > 0 ? base.slice(slash + 1) : base);
    if (!org || !model) return null;
    const quant = meta.quant || null;
    const id = `${org}/${model}${quant ? `:${quant}` : ''}@${meta.revision}`;
    return EXACT_ID.test(id) ? { id, org, model, quant, revision: String(meta.revision) } : null;
}

/** Integer nano-USD per million tokens from a USD-per-million price (D1); null when unpriced. */
function nanoPerMtok(usd) {
    if (usd == null || usd === '' || !Number.isFinite(Number(usd)) || Number(usd) < 0) return null;
    const n = Math.round(Number(usd) * 1e9);
    return Number.isSafeInteger(n) ? String(n) : null;
}

function retailRate(row) {
    const cost = (row && row.cost) || {};
    const rate = {};
    const put = (key, value) => { if (value != null) rate[key] = value; };
    put('input_nano_usd_per_m', nanoPerMtok(cost.in_per_mtok));
    put('cached_read_nano_usd_per_m', nanoPerMtok(cost.cached_per_mtok));
    put('cache_write_nano_usd_per_m', nanoPerMtok(cost.cache_write_per_mtok));
    put('output_nano_usd_per_m', nanoPerMtok(cost.out_per_mtok));
    if (!Object.keys(rate).length) return null;
    rate.per_request_nano_usd = '0';
    const version = row.metadata && row.metadata.rate_version;
    if (typeof version === 'string' && version) rate.version = version;
    return rate;
}

function modalitiesOf(row) {
    const type = (row && row.type) || 'chat';
    const vision = Boolean(row && row.supports && row.supports.vision) || type === 'vision';
    const seen = new Set(['text']);
    if (vision || type === 'image') seen.add('image');
    if (type === 'stt' || type === 'speech') { seen.add('audio'); }
    return [...seen];
}

function availabilityOf(row, provider) {
    if (row && row.metadata && row.metadata.missing_since) return 'deprecated';
    if (!row || row.status !== 'active' || !provider || provider.status !== 'active') return 'unavailable';
    return 'available';
}

/** One registry model as an ai.model@1 catalog entry. Legacy fields stay for readers of the old shape. */
function entryOf(row, provider) {
    const meta = (row && row.metadata) || {};
    const artifact = artifactOf(row, provider);
    const out = {
        provider_key: row.provider_key,
        model_key: row.model_key,
        display_name: row.display_name || row.model_key,
        type: row.type,
        status: row.status,
        context_window: row.context_window == null ? null : Number(row.context_window),
        max_output: row.max_output == null ? null : Number(row.max_output),
        cost: {
            in_per_mtok: row.cost.in_per_mtok == null ? null : Number(row.cost.in_per_mtok),
            out_per_mtok: row.cost.out_per_mtok == null ? null : Number(row.cost.out_per_mtok),
            cached_per_mtok: row.cost.cached_per_mtok == null ? null : Number(row.cost.cached_per_mtok),
            ...(row.cost.cache_write_per_mtok == null ? {} : { cache_write_per_mtok: Number(row.cost.cache_write_per_mtok) }),
        },
        supports: { ...row.supports },
        metadata: meta,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        availability: availabilityOf(row, provider),
        capabilities: { tools: Boolean(row.supports.tools), json: Boolean(row.supports.json), vision: Boolean(row.supports.vision), stream: Boolean(row.supports.streaming) },
        modalities: modalitiesOf(row),
    };
    if (artifact) {
        out.id = artifact.id;
        out.revision = artifact.revision;
        if (artifact.quant) out.quant = artifact.quant;
        if (meta.family) out.family = meta.family;
        if (meta.variant) out.variant = meta.variant;
        if (typeof meta.sha256 === 'string' && /^[a-f0-9]{64}$/.test(meta.sha256)) out.sha256 = meta.sha256;
        if (meta.license) out.license = meta.license;
    }
    if (Number(row.context_window) > 0) out.context = Number(row.context_window);
    const retail = retailRate(row);
    if (retail) out.retail_rate = retail;
    return out;
}

/** Every non-synthetic registry model as a catalog entry, with its provider record. */
async function entries({ registry }) {
    const providers = new Map((await registry.listProviders()).map((p) => [p.key, p]));
    const out = [];
    for (const row of await registry.listModels()) {
        const provider = providers.get(row.provider_key);
        if (!provider || provider.kind === 'stub' || (provider.metadata && provider.metadata.synthetic)) continue;
        out.push({ row, provider, entry: entryOf(row, provider) });
    }
    return out;
}

/** Model ids an exact-id request may run: one entry per provider offer of that artifact. */
async function exactOffers({ registry, id }) {
    return (await entries({ registry })).filter((x) => x.entry.id === id);
}

/**
 * Resolve a request's model:
 *   an alias  → { kind:'alias', alias, policy, route } with the route's placement constraints adjusted in a copy
 *   an exact  → { kind:'exact', id, offers:[{provider, model, row, providerRecord}] } (active deployments only)
 *   anything else → ai.model_not_found; an id that exists but has no usable deployment → ai.model_unavailable.
 */
async function select({ registry, model, route }) {
    const requested = String(model == null ? '' : model).trim();
    const alias = ALIASES.find((a) => a.id === requested);
    if (alias) {
        const constraints = { ...((route && route.constraints) || {}) };
        if (alias.policy === 'cheapest') { constraints.objective = 'cheapest'; delete constraints.authority; }
        else if (alias.policy === 'fastest') { constraints.objective = 'lowest-latency'; delete constraints.authority; }
        else if (alias.policy === 'balanced') { constraints.objective = 'balanced'; delete constraints.authority; }
        else if (alias.policy === 'private') { constraints.objective = 'private'; constraints.provider_scope = 'local'; delete constraints.authority; }
        return { kind: 'alias', requested, alias, policy: alias.policy, route: { ...route, constraints } };
    }
    if (!EXACT_ID.test(requested)) {
        throw new AiError(404, 'ai.model_not_found', `no model ${requested || '(none)'}: send an exact id <org>/<model>[:<quant>]@<revision> or one of ${ALIASES.map((a) => a.id).join(', ')}`);
    }
    const found = await exactOffers({ registry, id: requested });
    if (!found.length) throw new AiError(404, 'ai.model_not_found', `no artifact ${requested}`);
    const usable = found.filter((x) => x.row.status === 'active' && x.provider.status === 'active');
    if (!usable.length) throw new AiError(400, 'ai.model_unavailable', `the artifact ${requested} has no active deployment`);
    return {
        kind: 'exact', requested, id: requested, policy: 'exact', route,
        offers: usable.map((x) => ({ provider: x.provider.key, model: x.row.model_key, row: x.row, providerRecord: x.provider })),
    };
}

/** One `openvibe` disclosure object (D3). Unknown facts stay null, never invented. */
async function facts({ registry, providerRecord, model, policy = null, fallbackReason = null }) {
    const provider = providerRecord || null;
    const row = provider && model ? await registry.getModel(provider.key, model) : null;
    const artifact = row ? artifactOf(row, provider) : null;
    const meta = (row && row.metadata) || {};
    return {
        resolved_model: artifact ? artifact.id : (provider && model ? `${provider.key}/${model}` : (model || null)),
        revision: artifact ? artifact.revision : (meta.revision ? String(meta.revision) : null),
        deployment: provider ? provider.key : null,
        provider_access: accessOf(provider),
        rate_version: meta.rate_version ? String(meta.rate_version) : null,
        policy: policy || null,
        fallback_reason: fallbackReason || null,
    };
}

/** The `openvibe` object of a finished run (a run's own facts when the pool recorded them; otherwise from provenance). */
async function disclosureOf({ registry, run }) {
    const explain = (run && run.explain) || null;
    if (explain && explain.openvibe && typeof explain.openvibe === 'object') return explain.openvibe;
    const provenance = (run && run.provenance) || {};
    const provider = provenance.provider && !String(provenance.provider).startsWith('byo:') && !String(provenance.provider).startsWith('project:')
        ? await registry.getProvider(provenance.provider) : null;
    const base = await facts({ registry, providerRecord: provider, model: provenance.model || null, policy: explain && (explain.policy || explain.objective) || null });
    if (!base.deployment && provenance.provider) base.deployment = provenance.provider;
    if (provenance.cached_from) base.fallback_reason = `the answer was reused from run ${provenance.cached_from}; no provider was called`;
    else if (provenance.fallback_used) base.fallback_reason = 'the first eligible offer did not answer; a later offer on the same route answered';
    return base;
}

module.exports = {
    ACCESS, MANAGED_ACCESS, ALIASES, EXACT_ID,
    accessOf, managedAccessAllowed, artifactOf, entryOf, entries, exactOffers, select, facts, disclosureOf,
};
