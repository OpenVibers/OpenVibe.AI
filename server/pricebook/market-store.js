'use strict';
// Persist every parsed own-page offer, including ids that are not in the routing registry.
// This does not approve a routing price or enable a provider.
async function recordMarketPrices(db, source, prices, checkedAt) {
    if (source.role !== 'own') return;
    for (const [model, price] of Object.entries(prices)) {
        const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
        const publicPrice = { in: number(price.in), out: number(price.out), cached: number(price.cached) };
        await db.prepare(`INSERT INTO exchange_market_prices (provider_key, model_key, price, source, checked_at)
            VALUES (?, ?, ?::jsonb, ?, ?) ON CONFLICT (provider_key, model_key)
            DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source, checked_at = EXCLUDED.checked_at`)
            .run(source.provider, model, JSON.stringify(publicPrice), source.url, checkedAt);
    }
}
module.exports = { recordMarketPrices };
