'use strict';
/**
 * Aggregate usage for OpenVibe.Exchange: requests, tokens and spend by day, by model and by product.
 *
 * It reads usage_daily (the daily rollup every finished run writes) and never the runs or requests
 * tables: no prompt, no answer, no person's id. Attribution is left out on purpose — a product is
 * `service:<name>` (usage_daily.requester), and rows that are not a service are counted in the totals
 * but never named.
 */
const DAY_MS = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const NUM_COLUMNS = 'SUM(requests)::bigint AS requests, SUM(tokens_in)::bigint AS tokens_in, SUM(tokens_out)::bigint AS tokens_out, SUM(cost_usd) AS cost_usd';

const shape = (r) => ({
    requests: Number(r.requests) || 0,
    tokens_in: Number(r.tokens_in) || 0,
    tokens_out: Number(r.tokens_out) || 0,
    cost_usd: Math.round((Number(r.cost_usd) || 0) * 1e6) / 1e6,
});

function createUsage({ db, clock = { now: () => Date.now() } }) {
    const byDay = db.prepare(`SELECT day, ${NUM_COLUMNS} FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day`);
    const byModel = db.prepare(`SELECT provider_key, model_key, ${NUM_COLUMNS} FROM usage_daily WHERE day >= ?
        GROUP BY provider_key, model_key ORDER BY SUM(requests) DESC LIMIT 100`);
    const byProduct = db.prepare(`SELECT requester, ${NUM_COLUMNS} FROM usage_daily WHERE day >= ? AND requester LIKE 'service:%'
        GROUP BY requester ORDER BY SUM(requests) DESC LIMIT 100`);
    const productModels = db.prepare(`SELECT requester, provider_key, model_key, ${NUM_COLUMNS} FROM usage_daily WHERE day >= ? AND requester LIKE 'service:%'
        GROUP BY requester, provider_key, model_key ORDER BY SUM(requests) DESC`);
    const today = db.prepare(`SELECT ${NUM_COLUMNS} FROM usage_daily WHERE day = ?`);
    const totals = db.prepare(`SELECT ${NUM_COLUMNS} FROM usage_daily WHERE day >= ?`);

    /** days: the window (1–366). Costs are the network's own provider spend, in USD. */
    async function read({ days = 30 } = {}) {
        const now = clock.now();
        const span = Math.max(1, Math.min(366, Number(days) || 30));
        const from = dayOf(now - span * DAY_MS);
        const todayKey = dayOf(now);
        const [dayRows, modelRows, productRows, productModelRows, todayRow, totalRow] = await Promise.all([
            byDay.all(from), byModel.all(from), byProduct.all(from), productModels.all(from), today.all(todayKey), totals.all(from),
        ]);
        const products = new Map();
        for (const r of productRows) {
            const product = String(r.requester).slice('service:'.length);
            products.set(product, { product, ...shape(r), models: [] });
        }
        for (const r of productModelRows) {
            const product = products.get(String(r.requester).slice('service:'.length));
            if (!product) continue;
            product.models.push({ provider: r.provider_key, model: r.model_key || null, ...shape(r) });
        }
        for (const p of products.values()) p.models = p.models.slice(0, 8);
        return {
            generated_at: new Date(now).toISOString(),
            days: span,
            from,
            to: todayKey,
            today: shape(todayRow[0] || {}),
            totals: shape(totalRow[0] || {}),
            by_day: dayRows.map((r) => ({ day: String(r.day).slice(0, 10), ...shape(r) })),
            by_model: modelRows.map((r) => ({ provider: r.provider_key, model: r.model_key || null, ...shape(r) })),
            by_product: [...products.values()],
        };
    }

    return { read };
}

module.exports = { createUsage };
