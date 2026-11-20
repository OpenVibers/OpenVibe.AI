'use strict';
/**
 * What each search v2 depth really costs and takes (plan AD.34 item 5; Linkup prices its depths, we show ours as
 * measured): the last 200 searches of each depth and output, as their receipts said, and their medians and 90th
 * percentiles.
 *
 *   record(depth, output, receipt)   after a search answered: its cost_usd and time_ms (never the query or the person)
 *   summary()                        { depths: [{ depth, output, n, cost_usd: { p50, p90 }, time_ms: { p50, p90 } }] }
 *
 * The rows live in PostgreSQL when the service has a database (search_depth_samples, migration 0093: production starts
 * without a Valkey client, and the process's own lists emptied on every deploy, 11-20); else in Valkey when given one;
 * else a Map in this process (tests). Only numbers are kept.
 */
const KEEP = 200;
const DEPTHS = ['instant', 'fast', 'standard', 'deep'];
const OUTPUTS = ['results', 'answer'];

function createDepthStats({ db = null, valkey = null, now = () => Date.now(), log = console } = {}) {
    const local = new Map();
    const keyOf = (k) => (valkey ? valkey.key('search', 'depth', k) : `search:depth:${k}`);
    const outOf = (output) => (output === 'results' ? 'results' : 'answer');
    const slot = (depth, output) => `${depth}:${outOf(output)}`;

    async function record(depth, output, receipt) {
        if (!DEPTHS.includes(depth) || !receipt) return;
        const cost = Number(receipt.cost_usd), ms = Number(receipt.time_ms);
        if (!Number.isFinite(cost) || !Number.isFinite(ms) || cost < 0 || ms < 0) return;
        const at = now();
        if (db) {
            try {
                await db.prepare('INSERT INTO search_depth_samples (depth, output, cost_nano, time_ms, at) VALUES (?, ?, ?, ?, ?)')
                    .run(depth, outOf(output), Math.round(cost * 1e9), Math.round(ms), at);
                // Only the newest KEEP of this depth and output stay.
                await db.prepare(`DELETE FROM search_depth_samples WHERE depth = ? AND output = ? AND id NOT IN
                    (SELECT id FROM search_depth_samples WHERE depth = ? AND output = ? ORDER BY at DESC, id DESC LIMIT ${KEEP})`)
                    .run(depth, outOf(output), depth, outOf(output));
                return;
            } catch (err) { log.warn(`[search] depth stats: ${(err && err.message) || err}`); }
        }
        const k = slot(depth, output);
        const row = JSON.stringify([Math.round(cost * 1e6) / 1e6, Math.round(ms), at]);
        if (valkey) {
            try { await valkey.client.lpush(keyOf(k), row); await valkey.client.ltrim(keyOf(k), 0, KEEP - 1); return; } catch (err) { log.warn(`[search] depth stats: ${(err && err.message) || err}`); }
        }
        const list = local.get(k) || [];
        list.unshift(row);
        if (list.length > KEEP) list.length = KEEP;
        local.set(k, list);
    }

    /** The rows of one depth and output as [cost_usd, time_ms, at]. */
    async function rows(depth, output) {
        if (db) {
            try {
                const got = await db.prepare(`SELECT cost_nano, time_ms, at FROM search_depth_samples WHERE depth = ? AND output = ? ORDER BY at DESC, id DESC LIMIT ${KEEP}`).all(depth, output);
                return got.map((r) => [Number(r.cost_nano) / 1e9, Number(r.time_ms), Number(r.at)]);
            } catch { /* the lists below */ }
        }
        const k = slot(depth, output);
        let list = local.get(k) || [];
        if (valkey) { try { list = await valkey.client.lrange(keyOf(k), 0, KEEP - 1); } catch { /* the process's own */ } }
        return list.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Array.isArray);
    }

    const pick = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

    async function summary() {
        const depths = [];
        for (const depth of DEPTHS) {
            for (const output of OUTPUTS) {
                const parsed = await rows(depth, output);
                if (!parsed.length) { depths.push({ depth, output, n: 0, cost_usd: null, time_ms: null }); continue; }
                const costs = parsed.map((r) => r[0]).sort((a, b) => a - b), times = parsed.map((r) => r[1]).sort((a, b) => a - b);
                depths.push({
                    depth, output, n: parsed.length,
                    cost_usd: { p50: Math.round(pick(costs, 0.5) * 1e6) / 1e6, p90: Math.round(pick(costs, 0.9) * 1e6) / 1e6 },
                    time_ms: { p50: pick(times, 0.5), p90: pick(times, 0.9) },
                    since: new Date(Math.min(...parsed.map((r) => r[2]))).toISOString(),
                });
            }
        }
        return { depths, kept: KEEP };
    }

    return { record, summary };
}

module.exports = { createDepthStats, KEEP };
