'use strict';

/**
 * The one place a plan reads a price: the live rate cards, never a guess.
 *
 * A card whose source is the unverified marker is not a pricebook price, so the cost stays unknown
 * (null) and the plan says so. A free provider has no card; its cost is unknown to this function too,
 * because "no card" is not the same claim as "zero dollars". Tests pass a small stub pool.
 */
async function priceOf(pool, providerKey, modelKey) {
    if (!pool || typeof pool.rateCardsFor !== 'function') return { price: null, source: null };
    let cards = null;
    try { cards = await pool.rateCardsFor(providerKey, modelKey); } catch { cards = null; }
    if (!cards || !cards.in || !cards.out) return { price: null, source: null };
    const source = cards.in.source || null;
    const known = source && !String(source).startsWith('urn:openvibe:ai:unverified:');
    if (!known) return { price: null, source };
    const inRate = Number(cards.in.unit_price_usd);
    const outRate = Number(cards.out.unit_price_usd);
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return { price: null, source };
    return { price: { in: inRate, out: outRate }, source };
}

module.exports = { priceOf };
