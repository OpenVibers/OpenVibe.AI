'use strict';
/**
 * Aggregate usage for OpenVibe.Exchange: requests, tokens and spend by day, by model and by product.
 *
 * It reads the finished runs themselves — the request its requester row names, and the provider and
 * model that actually answered it — never a second roll-up that could carry the route's model instead
 * of the answer's. Cached answers are not usage: no provider was called and nothing was spent, so they
 * are not counted here (the catalog counts them apart). A requester is named only when it is a service
 * or an app, so Exchange can show which products and public apps use which models; a run that is
 * neither is counted in the totals but never attributed. No prompt, no answer and no person's id is
 * selected.
 */
const DAY_MS = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const NUM_COLUMNS = 'COUNT(*)::bigint AS requests, SUM(tokens_in)::bigint AS tokens_in, SUM(tokens_out)::bigint AS tokens_out, SUM(cost_usd)::double precision AS cost_usd';
const DAY = "to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')";
// A real answer: a provider was called and answered. A cached run called nobody, a failed one
// answered nothing, and a workflow that finished without an AI call (provider_key null: zero tokens,
// zero cost) has no model to attribute.
const REAL = "status = 'succeeded' AND synthetic = 0 AND provider_key IS NOT NULL";

const shape = (r) => ({
    requests: Number(r.requests) || 0,
    tokens_in: Number(r.tokens_in) || 0,
    tokens_out: Number(r.tokens_out) || 0,
    cost_usd: Math.round((Number(r.cost_usd) || 0) * 1e6) / 1e6,
});

function createUsage({ db, clock = { now: () => Date.now() } }) {
    const byDay = db.prepare(`SELECT ${DAY} AS day, ${NUM_COLUMNS} FROM runs
        WHERE ${REAL} AND created_at::timestamptz >= ?::timestamptz AND created_at::timestamptz < ?::timestamptz
        GROUP BY 1 ORDER BY 1`);
    const byModel = db.prepare(`SELECT provider_key, model_key, ${NUM_COLUMNS} FROM runs
        WHERE ${REAL} AND created_at::timestamptz >= ?::timestamptz AND created_at::timestamptz < ?::timestamptz
        GROUP BY provider_key, model_key ORDER BY COUNT(*) DESC LIMIT 100`);
    const byProduct = db.prepare(`SELECT requester_id, requester_type, ${NUM_COLUMNS} FROM runs
        WHERE ${REAL} AND requester_type IN ('service', 'app') AND created_at::timestamptz >= ?::timestamptz AND created_at::timestamptz < ?::timestamptz
        GROUP BY requester_id, requester_type ORDER BY COUNT(*) DESC LIMIT 100`);
    const productModels = db.prepare(`SELECT requester_id, requester_type, provider_key, model_key, ${NUM_COLUMNS} FROM runs
        WHERE ${REAL} AND requester_type IN ('service', 'app') AND created_at::timestamptz >= ?::timestamptz AND created_at::timestamptz < ?::timestamptz
        GROUP BY requester_id, requester_type, provider_key, model_key ORDER BY COUNT(*) DESC`);
    const today = db.prepare(`SELECT ${NUM_COLUMNS} FROM runs WHERE ${REAL} AND ${DAY} = ?`);
    const totals = db.prepare(`SELECT ${NUM_COLUMNS} FROM runs
        WHERE ${REAL} AND created_at::timestamptz >= ?::timestamptz AND created_at::timestamptz < ?::timestamptz`);

    /** days: the window (1–366). Costs are the network's own provider spend, in USD. */
    async function read({ days = 30 } = {}) {
        const now = clock.now();
        const span = Math.max(1, Math.min(366, Number(days) || 30));
        const from = dayOf(now - span * DAY_MS);
        const todayKey = dayOf(now);
        const fromAt = `${from}T00:00:00.000Z`;
        const toAt = new Date(now).toISOString();
        const [dayRows, modelRows, productRows, productModelRows, todayRow, totalRow] = await Promise.all([
            byDay.all(fromAt, toAt), byModel.all(fromAt, toAt), byProduct.all(fromAt, toAt),
            productModels.all(fromAt, toAt), today.all(todayKey), totals.all(fromAt, toAt),
        ]);
        const products = new Map();
        const keyOf = (r) => `${String(r.requester_type)}:${String(r.requester_id)}`;
        for (const r of productRows) {
            products.set(keyOf(r), {
                product: String(r.requester_id), type: String(r.requester_type) === 'app' ? 'app' : 'service',
                ...shape(r), models: [],
            });
        }
        for (const r of productModelRows) {
            const product = products.get(keyOf(r));
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
