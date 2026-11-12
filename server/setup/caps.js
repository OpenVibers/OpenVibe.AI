'use strict';
/**
 * The monthly cap per task kind, set on the Setup page (/admin/ai/setup → ai.task-kind-cap@1).
 *
 * A cap is 0 (no cap) or a USD amount. Before a run starts, what this month's completed runs on
 * the same task kind have cost is read and compared with the cap; at or above it the run is refused
 * with 429 cap.reached and a Retry-After to the first day of next month (UTC). The spend is the
 * runs' own cost_usd, so a cached run (cost 0) never uses the cap and a failed run that still cost
 * the provider is counted. Nothing here changes a provider or a price.
 *
 * The kind is the route's own job, one table: the same routes the Setup page walks.
 */
const { AiError } = require('../util');

const KIND_BY_ROUTE = Object.freeze({
    'default.chat': 'chat', 'default.json': 'vision', 'default.image': 'image', 'live.stt': 'stt',
    'default.speech': 'speech', 'default.embedding': 'embedding', 'space.build': 'code',
});
// Routes that are aliases of a step's route (food.vision → default.json, chat.member → default.chat).
// The direct map wins; the alias map is for a run whose recorded route is the alias itself.
const KIND_BY_ALIAS = Object.freeze({
    'food.vision': 'vision', 'pics.vision': 'vision', 'space.ask': 'chat', 'chat.member': 'chat',
    'default.messages': 'chat', 'background.vision': 'vision',
});

function kindOfRoute(routeKey) {
    return KIND_BY_ROUTE[routeKey] || KIND_BY_ALIAS[routeKey] || null;
}

function firstOfNextMonth(nowMs) {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Refuse a run when its task kind has spent its monthly cap. `routeKey` is the route the run will
 * use (after aliases), `db` the AI database, `now` the clock.
 */
async function check({ db, routeKey, now = Date.now() }) {
    const kind = kindOfRoute(routeKey);
    if (!kind) return { kind: null, capped: false };
    const row = await db.prepare('SELECT monthly_cap_usd FROM task_kind_caps WHERE task_kind = ?').get(kind).catch(() => null);
    const cap = row ? Number(row.monthly_cap_usd) : 0;
    if (!(cap > 0)) return { kind, capped: false };
    const start = new Date(now);
    start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const spent = await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM runs
        WHERE created_at >= ? AND status IN ('succeeded', 'cached')
          AND (route_key = ? OR route_key IN (SELECT key FROM routes WHERE alias_of = ?))`).get(start.toISOString(), routeKey, routeKey);
    const cost = Number(spent && spent.cost) || 0;
    if (cost >= cap) {
        const retry = Math.max(60, Math.ceil((firstOfNextMonth(now) - now) / 1000));
        throw new AiError(429, 'cap.reached', `the ${kind} monthly cap of $${cap} is used ($${cost.toFixed(2)} this month); it resets on the first of next month`, { retry_after_seconds: retry });
    }
    return { kind, capped: false, cap, cost };
}

module.exports = { check, kindOfRoute, KIND_BY_ROUTE, KIND_BY_ALIAS, firstOfNextMonth };
