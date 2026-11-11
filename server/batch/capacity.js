'use strict';
/**
 * The capacity a batch may run on: batchCapacity(model, at).
 *
 * A batch is half price for the customer, so every token of it must cost the network at most half of the
 * card the customer is charged. The retail card IS the provider's own list price (server/providers/
 * model-catalog.js copies the model row's cost; there is no mark-up on it), so a batch that ran on an
 * ordinary paid route would cost the network the full price while the customer was charged half: the
 * network would lose money on every token of it.
 *
 * So a batch runs only where the money works out. Three kinds of route are eligible:
 *
 *   (a) capacity that costs the network nothing: OpenVibe's own GPU and local deployments (idle capacity
 *       the network already pays for) and any free provider;
 *   (b) a community machine offer whose credit price for the model is at most half the requested model's
 *       retail: the seller is paid their price and the network keeps the rest, which is never negative.
 *       A community credit is the same unit the Balance ledger counts (the nano), so the two prices are
 *       compared as they are;
 *   (c) a paid provider inside a window where the provider's own price, read from the price book, is at
 *       least 50% lower than the retail card. DeepSeek's off-peak window is the case today. A provider the
 *       price book has no window for is not eligible: the network cannot tell what that route costs, and
 *       a batch is never run on a price nobody knows.
 *
 * The function returns the eligible routes with their real cost, and the card the customer is charged.
 * Every route's cost is per million tokens in nano-USD, the same unit the retail card uses.
 */
const { retailRate } = require('../providers/model-catalog');
const { insideWindow } = require('../pricebook/offpeak');
const { PROVIDERS, batchProviderFor } = require('./providers');
const { scaleCard, toCard } = require('./batcher');

/** Half of a nano price, rounded down: the customer is never charged more than half. */
const halfOf = (v) => (v == null ? null : (BigInt(v) / 2n).toString());

/**
 * The card a batch is charged: the retail card with every component halved. It is the same card the
 * Balance session charges (server/credits.js applyDiscount), so the ledger records the price charged.
 */
function chargeOf(model) {
    const retail = retailRate(model);
    if (!retail) return null;
    // The retail card of the model row, in the shape the Balance ledger counts (per component).
    const perM = {
        input: retail.input_nano_usd_per_m == null ? null : String(retail.input_nano_usd_per_m),
        cached_read: retail.cached_read_nano_usd_per_m == null ? null : String(retail.cached_read_nano_usd_per_m),
        cache_write: retail.cache_write_nano_usd_per_m == null ? null : String(retail.cache_write_nano_usd_per_m),
        output: retail.output_nano_usd_per_m == null ? null : String(retail.output_nano_usd_per_m),
    };
    return {
        version: `${retail.version || 'retail'}:batch-half`,
        nano_usd_per_m: {
            input: halfOf(perM.input),
            cached_read: halfOf(perM.cached_read),
            cache_write: halfOf(perM.cache_write),
            output: halfOf(perM.output),
        },
        per_request_nano_usd: halfOf(retail.per_request_nano_usd),
        retail_version: retail.version || null,
    };
}

/** Does a route's cost fit inside the charge? Every component the charge names, component by component. */
function within(cost, charge) {
    const perM = charge.nano_usd_per_m || {};
    for (const key of ['input', 'cached_read', 'cache_write', 'output']) {
        const paid = perM[key] == null ? 0n : BigInt(perM[key]);
        const spent = cost[key] == null ? 0n : BigInt(cost[key]);
        if (spent > paid) return false;
    }
    return true;
}

/** Is `at` inside a UTC window? A window that wraps the midnight (23-02) is handled. */
function insideWindowLegacy(window, at) {
    if (!window) return false;
    const hour = new Date(at).getUTCHours();
    const start = Number(window.start_hour);
    const end = Number(window.end_hour);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * The eligible routes for one model at one moment, with their real cost.
 *
 *   model   the registry row of the model the batch asked for
 *   at      the moment the capacity is looked for (a Date or an ISO string)
 *
 * → { charge, routes: [{ provider, model, source, cost, offer_id?, window? }] }
 */
async function batchCapacity(model, at, { registry = null, community = null, priceBook = null } = {}) {
    const charge = chargeOf(model);
    const routes = [];
    if (!charge || !model) return { charge, routes };

    // (a) OpenVibe's own GPU and local deployments, and any free provider: they cost the network nothing.
    if (registry) {
        const rows = await registry.listModels();
        for (const row of rows || []) {
            if (row.status !== 'active') continue;
            if (String(row.model_key) !== String(model.model_key)) continue;
            const provider = await registry.getProvider(row.provider_key);
            if (!provider || provider.status !== 'active') continue;
            const cost = row.cost || {};
            const free = ['in_per_mtok', 'out_per_mtok'].every((f) => Number(cost[f] || 0) === 0);
            const own = Boolean(provider.metadata && (provider.metadata.gpu || provider.metadata.local));
            if (!free && !own) continue;
            routes.push({
                provider: row.provider_key,
                model: row.model_key,
                source: own ? 'own' : 'free',
                cost: { input: '0', cached_read: '0', cache_write: '0', output: '0' },
            });
        }
    }

    // (b) A community machine offer that asks at most half the retail price for the model.
    if (community && typeof community.offers === 'function') {
        let offers = [];
        try { offers = await community.offers(); } catch { offers = []; }
        for (const offer of offers || []) {
            const models = offer.models || [];
            const serves = models.some((m) => String(m) === String(model.model_key));
            if (!serves) continue;
            const price = offer.price || {};
            // The offer's price is in credits per million tokens, and a credit is the same money the
            // Balance ledger counts (the nano), so the price converts like any other per-million price.
            const cost = {
                input: String(Math.round(Number(price.in_per_million || 0) * 1e9)),
                cached_read: '0',
                cache_write: '0',
                output: String(Math.round(Number(price.out_per_million || 0) * 1e9)),
            };
            if (!within(cost, charge)) continue;
            routes.push({
                provider: 'community',
                model: model.model_key,
                offer_id: offer.offer_id || null,
                source: 'community',
                cost,
            });
        }
    }

    // (c) A paid provider inside a window where its own price is at least half lower than the retail card.
    // The windows are the price book's: the old single daily window and the weekday blocks (BA1), so a
    // rule like DeepSeek's (peak 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday) is read as it is.
    if (priceBook && typeof priceBook.offPeakRows === 'function') {
        const rows = typeof priceBook.windows === 'function' ? await priceBook.windows() : await priceBook.offPeakRows();
        for (const row of rows || []) {
            if (String(row.model_key) !== String(model.model_key)) continue;
            if (!insideWindow(row, at)) continue;
            const cost = {
                input: row.input == null ? null : String(row.input),
                cached_read: '0',
                cache_write: '0',
                output: row.output == null ? null : String(row.output),
            };
            if (!within(cost, charge)) continue;
            routes.push({
                provider: row.provider_key,
                model: row.model_key,
                source: 'discount-window',
                cost,
                window: { start_hour: Number(row.start_hour), end_hour: Number(row.end_hour), weekdays: row.weekdays || [] },
            });
        }
    }

    // (d) A provider's own batch API, when its real batch price is at most half the retail card. The
    // customer is charged half the card, so the provider's own batch price has to fit inside that half:
    // OpenAI and DashScope are the providers whose batch tier is half their list price today. A customer
    // batch on a paid model then runs at any hour, instead of waiting for an off-peak window.
    if (registry) {
        const rows = await registry.listModels();
        for (const [key, base] of Object.entries(PROVIDERS)) {
            if (Number(base.discount) > 0.5) continue;                // the real price would not fit inside the charge
            const provider = await registry.getProvider(key);
            const cfg = batchProviderFor(key, provider);
            if (!cfg) continue;
            const row = (rows || []).find((r) => String(r.provider_key) === key && String(r.model_key) === String(model.model_key) && r.status === 'active');
            if (!row) continue;
            const retail = toCard(retailRate(row));
            if (!retail) continue;
            const cost = scaleCard(retail, cfg.discount);
            if (!cost || !within(cost.nano_usd_per_m, charge)) continue;
            routes.push({
                provider: key,
                model: model.model_key,
                source: 'native-batch',
                cost: cost.nano_usd_per_m,
                batch_discount: cfg.discount,
                window: cfg.window,
                window_hours: Number(String(cfg.window).replace(/[^0-9.]/g, '')) || 24,
            });
        }
    }

    return { charge, routes };
}

/**
 * May this route meet a deadline? A provider's own batch API promises a completion window (24h for
 * every adapter here); a deadline sooner than that cannot use it. Every other route answers now.
 */
function meetsDeadline(route, deadlineAt, now = Date.now()) {
    const hours = Number(route && route.window_hours);
    if (!Number.isFinite(hours) || hours <= 0) return true;
    const deadline = new Date(deadlineAt).getTime();
    // A minute of grace: a 24-hour window against a deadline set 24 hours from the same moment does
    // meet it; only a deadline genuinely sooner than the window is refused.
    return Number.isFinite(deadline) && now + hours * 3600 * 1000 <= deadline + 60_000;
}

/** The total per-million cost of a route, for the cheapest-route comparison (input + output). */
function totalCost(route) {
    const cost = (route && route.cost) || {};
    const add = (a, b) => BigInt(a == null ? 0 : String(a)) + BigInt(b == null ? 0 : String(b));
    return add(cost.input, cost.output);
}

/** The plain sentence the run receipt carries: which route answered and why it was the one. */
function routeReason(route) {
    if (!route) return 'the ordinary route (the deadline passed and the loss budget covered it)';
    if (route.source === 'native-batch') {
        return `${route.provider} batch API at ${Math.round((Number(route.batch_discount) || 0.5) * 100)}% of the list price, ${route.window || '24h'} window`;
    }
    if (route.source === 'discount-window') {
        const w = route.window || {};
        return `${route.provider} off-peak price inside ${w.start_hour}:00-${w.end_hour}:00 UTC`;
    }
    if (route.source === 'community') return 'a community machine offer inside half the retail card';
    if (route.source === 'own') return 'OpenVibe\'s own GPU capacity, already paid for';
    if (route.source === 'free') return 'a free provider route';
    return String(route.source || 'low-cost capacity');
}

module.exports = { batchCapacity, chargeOf, within, insideWindow: insideWindowLegacy, halfOf, meetsDeadline, totalCost, routeReason };
