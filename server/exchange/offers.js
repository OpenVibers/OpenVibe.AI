'use strict';
/**
 * One offer's route, and the owner's one action that opens it.
 *
 * The Exchange catalogue lists a model only when every gate passes (server/exchange/catalog.js):
 * the provider is on, its key is present, the model is on and still listed, its commercial access may
 * be resold, and a price is known. The router additionally skips a model that is missing from the
 * provider's own list and an offer whose circuit is open. This module reads those registry facts
 * (never a second list) and answers, per provider/model: is this offer on the route now, and if not
 * which gate stops it.
 *
 * `open` is the owner's decision, made once and written once:
 *   - the pending price-book changes of that model are approved (or the owner's fixed per-token price
 *     is written), because a route is never served at a price nobody agreed to;
 *   - the provider is switched on and the model is switched on;
 *   - the same audit log records who opened it, with the price and the gates that were closed.
 * A provider with no key is refused before anything is written: the key is the owner's to add, and
 * this module never touches a secret. Nothing here rents, spends or calls a provider.
 */
const { AiError } = require('../util');
const upstream = require('../providers/upstream');

const ACCESS_UNSELLABLE = new Set(['CUSTOMER_BYOK', 'RESTRICTED']);
const KINDS = ['chat', 'vision', 'embedding', 'stt', 'image'];

const number = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
};
const day = (iso) => String(iso || '').slice(0, 10);

/**
 * The price the router would charge, after the owner's override. `source` says where it came from:
 * the accepted provider price, the owner's fixed price, or null when nobody priced it.
 */
function priceOf(model) {
    const override = model && model.metadata && model.metadata.owner_override && model.metadata.owner_override.cost;
    const base = (model && model.cost) || {};
    const cost = { ...base, ...(override || {}) };
    const fixed = Boolean(model && model.metadata && (model.metadata.owner_fixed_price === true || override));
    return {
        in: number(cost.in_per_mtok),
        out: number(cost.out_per_mtok),
        cached: number(cost.cached_per_mtok),
        source: fixed ? 'owner' : (cost.source ? (String(cost.source).startsWith('urn:openvibe:ai:unverified:') ? null : cost.source) : null),
        verified_at: cost.verified_at || null,
        owner: Boolean(override) ? 'override' : fixed ? 'fixed' : null,
    };
}

/**
 * The route of one provider/model. `pending` is how many of its price changes wait for a decision.
 * The reasons are ordered the way the catalog tests them, so the first one is the first thing to fix.
 */
function routeOf({ provider = null, model = null, pending = 0, env = process.env } = {}) {
    const reasons = [];
    if (!provider) reasons.push('no_provider');
    if (!model) reasons.push('no_model');
    if (provider && provider.status !== 'active') reasons.push('provider_off');
    if (provider && !upstream.credentialPresent(provider, env)) reasons.push('no_key');
    if (provider && ACCESS_UNSELLABLE.has(provider.provider_access || 'UNVERIFIED')) reasons.push('access_restricted');
    if (model && model.status !== 'active') reasons.push('model_off');
    if (model && model.metadata && model.metadata.missing_since) reasons.push('model_gone');
    if (model && !KINDS.includes(model.type || 'chat')) reasons.push('kind_not_offered');
    const price = model ? priceOf(model) : null;
    if (model && (price.in === null || price.out === null)) reasons.push('price_unknown');
    const live = Boolean(provider && model) && reasons.length === 0;
    return {
        provider: provider ? provider.key : null,
        model: model ? model.model_key : null,
        live,
        reasons,
        provider_status: provider ? provider.status : null,
        key_present: Boolean(provider && upstream.credentialPresent(provider, env)),
        provider_access: provider ? provider.provider_access || 'UNVERIFIED' : null,
        model_status: model ? model.status : null,
        missing_since: model && model.metadata ? model.metadata.missing_since || null : null,
        price,
        pending_prices: Number(pending) || 0,
    };
}

function createOfferRoutes({ registry, priceBook = null, env = process.env, clock = { now: () => Date.now() }, log = console } = {}) {
    const now = () => new Date(clock.now()).toISOString();

    /** The pending change counts of a set of models, read once. */
    async function pendingByModel() {
        const counts = new Map();
        if (!priceBook) return counts;
        const rows = await priceBook.pending(500).catch(() => []);
        for (const row of rows || []) {
            const key = `${row.provider_key}\u0000${row.model_key}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        return counts;
    }

    function pendingOf(counts, providerKey, modelKey) {
        return counts.get(`${providerKey}\u0000${modelKey}`) || 0;
    }

    /** One model's route, with its waiting price changes. */
    async function read(providerKey, modelKey) {
        const [provider, model] = await Promise.all([registry.getProvider(providerKey), registry.getModel(providerKey, modelKey)]);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        if (!model) throw new AiError(404, 'ai.not_found', 'no such model');
        const pending = priceBook
            ? (await priceBook.pending(500).catch(() => [])).filter((c) => c.provider_key === providerKey && c.model_key === modelKey).length
            : 0;
        return routeOf({ provider, model, pending, env });
    }

    /** A fixed price the owner typed for this offer, in USD per million tokens. */
    function fixedCost(input) {
        if (!input || typeof input !== 'object') throw new AiError(422, 'ai.invalid', 'price must be an object');
        const reason = String(input.reason || '').trim();
        if (!reason) throw new AiError(422, 'ai.invalid', 'a fixed price needs a reason');
        if (reason.length > 500) throw new AiError(422, 'ai.invalid', 'the reason is at most 500 characters');
        const cost = {};
        for (const field of ['in_per_mtok', 'out_per_mtok', 'cached_per_mtok']) {
            if (input[field] === undefined || input[field] === null || input[field] === '') continue;
            const n = number(input[field]);
            if (n === null) throw new AiError(422, 'ai.invalid', `price.${field} must be a non-negative number`);
            cost[field] = n;
        }
        if (cost.in_per_mtok === undefined || cost.out_per_mtok === undefined) {
            throw new AiError(422, 'ai.invalid', 'a fixed price needs both input and output per million tokens');
        }
        return { reason, cost };
    }

    /**
     * Open the offer: approve its waiting prices (or write the owner's fixed price), switch the provider
     * and the model on, and answer the route as it now stands.
     */
    async function open(providerKey, modelKey, { price = null, actor = 'owner', trace = null } = {}) {
        const [provider, model] = await Promise.all([registry.getProvider(providerKey), registry.getModel(providerKey, modelKey)]);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        if (!model) throw new AiError(404, 'ai.not_found', 'no such model');
        // Every refusal comes before any write: a half-opened offer is not a state the owner asked for.
        if (!upstream.credentialPresent(provider, env)) {
            throw new AiError(409, 'offer.no_key', `Add the ${provider.display_name || provider.key} key first; nothing was changed.`);
        }
        if (ACCESS_UNSELLABLE.has(provider.provider_access || 'UNVERIFIED')) {
            throw new AiError(409, 'offer.access_restricted', `${provider.display_name || provider.key} may not be resold on the Exchange; its commercial access is ${provider.provider_access}.`);
        }
        if (model.metadata && model.metadata.missing_since) {
            throw new AiError(409, 'offer.model_gone', 'The provider no longer lists this model; sync its models before opening the route.');
        }
        const fixed = price ? fixedCost(price) : null;
        let approved = 0;
        let fixedWritten = false;
        if (fixed) {
            const metadata = { ...(model.metadata || {}), owner_fixed_price: true, owner_fixed_price_reason: fixed.reason, owner_fixed_price_at: now() };
            delete metadata.owner_override;
            await registry.upsertModel({
                ...model,
                status: model.status,
                cost: { ...fixed.cost, source: 'urn:openvibe:owner-fixed-price', verified_at: day(now()) },
                metadata,
            }, { actor, trace });
            fixedWritten = true;
        } else if (priceBook) {
            const waiting = (await priceBook.pending(500)).filter((c) => c.provider_key === providerKey && c.model_key === modelKey);
            const failed = [];
            // One by one, never in parallel: each approval rewrites the model's cost from its own field.
            for (const change of waiting) {
                const out = await priceBook.decide(change.id, { decision: 'approve', actor });
                if (!out.ok) failed.push({ id: change.id, error: out.error });
                else approved += 1;
            }
            if (failed.length) {
                throw new AiError(409, 'offer.price_approval_failed', `${failed.length} waiting price(s) could not be approved; the rest were approved and can be seen in the price book.`);
            }
        }
        const priced = priceOf(await registry.getModel(providerKey, modelKey));
        if (priced.in === null || priced.out === null) {
            throw new AiError(409, 'offer.no_price', 'Approve a price in the price book (or save a fixed price) before opening the route.');
        }
        const enabled = { provider: false, model: false };
        if (provider.status !== 'active') {
            await registry.upsertProvider({ key: provider.key, status: 'active' }, { actor, trace, origin: 'console' });
            enabled.provider = true;
        }
        const fresh = await registry.getModel(providerKey, modelKey);
        if (fresh.status !== 'active') {
            await registry.upsertModel({ ...fresh, status: 'active' }, { actor, trace });
            enabled.model = true;
        }
        const route = await read(providerKey, modelKey);
        await registry.audit(actor, 'offer.opened', 'model', `${providerKey}/${modelKey}`, {
            trace,
            metadata: {
                approved_prices: approved, fixed_price: fixedWritten,
                fixed_in_per_mtok: fixedWritten ? priced.in : null, fixed_out_per_mtok: fixedWritten ? priced.out : null,
                provider_enabled: enabled.provider, model_enabled: enabled.model, live: route.live,
            },
        });
        log.log(`[exchange] offer ${providerKey}/${modelKey} opened${fixedWritten ? ' at a fixed price' : ''}: ${approved} price(s) approved, provider ${enabled.provider ? 'on' : 'already on'}, model ${enabled.model ? 'on' : 'already on'}`);
        return { ok: true, opened: true, already_live: route.live && !enabled.provider && !enabled.model && !fixedWritten && approved === 0, route };
    }

    return { read, open, routeOf, priceOf, pendingByModel, pendingOf };
}

module.exports = { createOfferRoutes, routeOf, priceOf };
