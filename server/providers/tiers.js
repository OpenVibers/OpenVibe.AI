'use strict';
/**
 * The tiers a run can be priced on.
 *
 * A tier is what the provider really charged for the work:
 *
 *   standard  the list price on the model's card (the price every run is compared against);
 *   flex      a slower service tier some providers sell at a lower price (OpenAI, DeepInfra);
 *   batch     the provider's own batch API (BA2), at its own price;
 *   offpeak   the hours a provider's own price is lower (DeepSeek's off-peak rule);
 *   local     capacity the network already pays for (the host's own models): nothing.
 *
 * A provider's own row carries the multipliers its own page publishes, in metadata.tier_rates:
 *
 *   { "flex": 0.5, "batch": 0.5 }
 *
 * The price of a tier is the list price times its multiplier. A tier nobody published a multiplier for is
 * not offered: the network never claims a saving it cannot price, and never prices a run on a tier the
 * provider did not answer on.
 *
 * The tier a run really ran on is read from the answer itself where the provider says it (OpenAI's
 * response carries its own service_tier). When the provider does not say, the run is priced at the
 * standard rate: a saving that cannot be seen is not a saving.
 */
const TIERS = ['standard', 'flex', 'batch', 'offpeak', 'local'];
/** The tiers a run may be priced on that are not the standard one. */
const DISCOUNT_TIERS = ['flex', 'batch', 'offpeak'];

/** The operations that carry a service tier (a chat completion does; an embedding does not). */
const TIERED_OPS = new Set(['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages']);

/** The multipliers a provider's row carries, as numbers. A row without them has no tier but the standard. */
function ratesOf(record) {
    const raw = record && record.metadata && record.metadata.tier_rates;
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [tier, value] of Object.entries(raw)) {
        if (!DISCOUNT_TIERS.includes(tier)) continue;
        const n = Number(value);
        if (Number.isFinite(n) && n > 0 && n <= 1) out[tier] = n;
    }
    return out;
}

/** The multiplier of one tier, or null when the provider does not publish one. */
function multiplierOf(record, tier) {
    const rates = ratesOf(record);
    return Object.prototype.hasOwnProperty.call(rates, tier) ? rates[tier] : null;
}

/** Does this provider sell this tier at all? */
function supports(record, tier) { return multiplierOf(record, tier) != null; }

/**
 * Did the provider refuse the tier we asked for?
 *
 * A Flex tier answers in minutes, and the provider may refuse it: OpenAI answers 429 with
 * `resource_unavailable` when the tier has no capacity, and 400 when the model does not serve that tier.
 * A refusal is not a failure of the run: the same run is retried once on the standard tier (counted,
 * logged, and never billed twice, because the refused attempt produced no tokens).
 */
function isTierRefusal(err, tier) {
    if (!err || tier !== 'flex') return false;
    const status = Number(err.status) || 0;
    const body = err.body && typeof err.body === 'object' ? err.body : {};
    const inner = (body.error && typeof body.error === 'object') ? body.error : body;
    const code = String((inner && (inner.code || inner.type)) || '');
    const message = String((inner && inner.message) || body.message || err.message || '');
    const text = `${code} ${message}`.toLowerCase();
    const namesTheTier = /flex|service[_ -]?tier|tier/.test(text);
    if (status === 429) return namesTheTier || /resource[_ -]?unavailable/.test(text);
    if (status === 400) return namesTheTier || /not (supported|available|offered)|unsupported|does not (support|offer)|invalid.*tier/.test(text);
    return false;
}

/**
 * The tier the answer says it ran on. OpenAI's response carries its own `service_tier`; a provider that
 * says nothing is priced at the standard rate, because a saving nobody confirmed is not a saving.
 */
function tierOfAnswer(result, asked) {
    const said = result && (result.serviceTier || result.service_tier);
    if (typeof said !== 'string' || !said) return asked === 'flex' ? 'standard' : (asked || 'standard');
    const t = said.toLowerCase();
    if (t === 'flex') return 'flex';
    if (t === 'batch') return 'batch';
    if (t === 'default' || t === 'standard' || t === 'auto') return 'standard';
    return t;
}

module.exports = { TIERS, DISCOUNT_TIERS, TIERED_OPS, ratesOf, multiplierOf, supports, isTierRefusal, tierOfAnswer };
