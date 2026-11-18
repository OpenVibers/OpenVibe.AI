'use strict';
// Public Report evidence. Unknown stays unknown; a failed read never invents a ranking.
// Kept two minutes; past that the last rows answer at once and one read of Report runs behind them (11-18: a miss
// waited up to 3 s on Report in the middle of every model sheet). Only the very first read is waited for.
function createRatings({ fetchImpl = globalThis.fetch, clock = { now: () => Date.now() } } = {}) {
    let rows = [], at = 0, pending = null;
    const refresh = () => {
        if (!pending) {
            pending = (async () => {
                try {
                    const res = await fetchImpl('https://openvibe.report/api/v1/ai/leaderboard?limit=1000', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
                    if (res.ok) { const body = await res.json(); rows = Array.isArray(body.rows) ? body.rows : []; at = clock.now(); }
                } catch { /* measurements are optional */ }
                return rows;
            })().finally(() => { pending = null; });
        }
        return pending;
    };
    return async () => {
        if (clock.now() - at < 120000) return rows;
        if (at) { refresh().catch(() => {}); return rows; }
        return refresh();
    };
}
module.exports = { createRatings };
