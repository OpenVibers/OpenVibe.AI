'use strict';
/**
 * The routing constraints of a preset, applied to the offers a route may use (server/exchange/presets.js).
 *
 * Every knob excludes an offer with a reason, and the reasons are written into the run's explain, so a
 * refusal or a downgrade says which rule removed which offer. Nothing here invents a price or a policy:
 * the facts come from the catalogue, the rate cards and the provider's declared data policy.
 *
 *   floor          the catalogue's strength tier of the offer's model (fast | balanced | strong | frontier)
 *   ceiling        the price per million tokens (output) above which the offer may not answer
 *   max_price      the same measure, but hard: when no offer fits, the request is refused before the call
 *   quantization   the quantization of the offer's model
 *   region         the region the offer runs in
 *   data_policy    the privacy class the answer must have (private | anonymized | community)
 *   community      whether a community machine (which sees the prompt) may answer
 */
const { TIER_RANK } = require('../providers/task');
const privacy = require('./privacy');

const tierRank = (tier) => (TIER_RANK[tier] === undefined ? TIER_RANK.balanced : TIER_RANK[tier]);

/** Does the offer's region answer a requirement? 'eu' answers 'eu' and every eu region (eu-west, eu-north). */
function regionOk(offerRegion, required) {
    if (!required || !required.length) return true;
    const region = String(offerRegion || '').trim().toLowerCase();
    if (!region) return false;
    return required.some((r) => (r === 'eu' ? region === 'eu' || region.startsWith('eu-') : region === r));
}

/**
 * The offers that may answer, and the ones that may not, with the rule that removed each of them.
 *
 *   list     the candidates the router ranked
 *   policy   the preset's policy (already normalised)
 *   facts    (candidate) => { priceIn, priceOut, tier, quant, region, privacy } (may be async)
 */
async function applyConstraints({ list = [], policy = null, facts = null } = {}) {
    if (!policy || !Object.keys(policy).length) return { order: [...list], excluded: [] };
    const kept = [];
    const excluded = [];
    for (const c of list) {
        if (!c || !c.provider) continue;
        const f = (facts ? (await facts(c)) : {}) || {};
        const reason = reasonFor(f, policy);
        if (reason) excluded.push({ provider: c.provider, model: c.model || null, reason });
        else kept.push(c);
    }
    return { order: kept, excluded };
}

/** The rule that keeps this offer out, or null when it may answer. */
function reasonFor(facts, policy) {
    if (policy.floor) {
        const rank = tierRank(facts.tier);
        if (rank < tierRank(policy.floor)) return `below_floor (${facts.tier || 'balanced'} < ${policy.floor})`;
    }
    const priceOut = Number(facts.priceOut);
    if (policy.ceiling != null && Number.isFinite(priceOut) && priceOut > Number(policy.ceiling)) {
        return `over_ceiling (${priceOut} > ${policy.ceiling} USD/Mtok)`;
    }
    if (policy.max_price != null && Number.isFinite(priceOut) && priceOut > Number(policy.max_price)) {
        return `over_max_price (${priceOut} > ${policy.max_price} USD/Mtok)`;
    }
    if (policy.quantization && policy.quantization.length) {
        const quant = String(facts.quant || '').trim().toLowerCase();
        if (!quant) return 'quantization_unknown';
        if (!policy.quantization.includes(quant)) return `quantization_not_allowed (${quant})`;
    }
    if (policy.region && policy.region.length && !regionOk(facts.region, policy.region)) {
        return `region_not_allowed (${facts.region || 'unknown'})`;
    }
    if (policy.data_policy) {
        const label = (facts.privacy && facts.privacy.label) || 'anonymized';
        if (!privacy.satisfies(label, policy.data_policy)) return `data_policy (${label} < ${policy.data_policy})`;
    }
    if (policy.community === false) {
        const label = (facts.privacy && facts.privacy.label) || 'anonymized';
        if (label === 'community') return 'community_not_allowed';
    }
    return null;
}

/**
 * The refusal of a hard max_price: no offer fits it, so the request is refused before any provider is
 * called. The message names the cap and the cheapest offer that was refused, so the caller knows what to
 * raise.
 */
function refusal({ policy, excluded = [], cheapest = null }) {
    const cap = Number(policy.max_price);
    const priced = excluded.filter((e) => /over_max_price/.test(e.reason || ''));
    const cheapestPrice = priced.map((e) => {
        const m = /over_max_price \(([-0-9.eE+]+) >/.exec(e.reason || '');
        return m ? Number(m[1]) : null;
    }).filter((n) => Number.isFinite(n));
    const lowest = cheapestPrice.length ? Math.min(...cheapestPrice) : null;
    const detail = `no offer fits the max_price of ${cap} USD per million tokens`
        + (lowest != null ? `: the cheapest offer is ${lowest} USD/Mtok` : '')
        + (cheapest ? ` (${cheapest.provider}${cheapest.model ? `/${cheapest.model}` : ''})` : '');
    return { code: 'ai.max_price_exceeded', detail, max_price: cap, lowest_price: lowest, excluded };
}

module.exports = { applyConstraints, reasonFor, refusal, regionOk, tierRank };
