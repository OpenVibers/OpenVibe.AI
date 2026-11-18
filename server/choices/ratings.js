'use strict';
// Public Report evidence. Unknown stays unknown; a failed read never invents a ranking.
// The ratings are optional, so they never hold the model sheet up (11-18: Report's leaderboard took longer than the
// 3 s timeout from AI and was never kept, so every sheet waited the full 3 s). A read is kept two minutes, a failed one
// too; past that the last rows answer at once while one read runs behind them; even the very first read is waited for
// 300 ms at most, and a sheet without ratings is shown without them.
const FIRST_WAIT_MS = 300;
function createRatings({ fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, firstWaitMs = FIRST_WAIT_MS } = {}) {
    let rows = [], at = 0, pending = null;
    const refresh = () => {
        if (!pending) {
            pending = (async () => {
                try {
                    const res = await fetchImpl('https://openvibe.report/api/v1/ai/leaderboard?limit=1000', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
                    if (res.ok) { const body = await res.json(); rows = Array.isArray(body.rows) ? body.rows : rows; }
                } catch { /* measurements are optional */ }
                at = clock.now();
                return rows;
            })().finally(() => { pending = null; });
        }
        return pending;
    };
    return async () => {
        if (at && clock.now() - at < 120000) return rows;
        const p = refresh();
        if (at) { p.catch(() => {}); return rows; }
        let timer;
        const soon = new Promise((resolve) => { timer = setTimeout(() => resolve(rows), firstWaitMs); });
        try { return await Promise.race([p, soon]); } finally { clearTimeout(timer); }
    };
}
module.exports = { createRatings };
