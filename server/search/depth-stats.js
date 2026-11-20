'use strict';
/**
 * What each search v2 depth really costs and takes (plan AD.34 item 5; Linkup prices its depths, we show ours as
 * measured): the last 200 searches of each depth and output, as their receipts said, and their medians and 90th
 * percentiles.
 *
 *   record(depth, output, receipt)   after a search answered: its cost_usd and time_ms (never the query or the person)
 *   summary()                        { depths: [{ depth, output, n, cost_usd: { p50, p90 }, time_ms: { p50, p90 } }] }
 *
 * The rows live in Valkey when the service has one (every process adds to the same list, and a deploy keeps them);
 * without it, a Map in this process. Only numbers are kept.
 */
const KEEP = 200;
const DEPTHS = ['instant', 'fast', 'standard', 'deep'];
const OUTPUTS = ['results', 'answer'];

function createDepthStats({ valkey = null, now = () => Date.now(), log = console } = {}) {
    const local = new Map();
    const keyOf = (k) => (valkey ? valkey.key('search', 'depth', k) : `search:depth:${k}`);
    const slot = (depth, output) => `${depth}:${output === 'results' ? 'results' : 'answer'}`;

    async function record(depth, output, receipt) {
        if (!DEPTHS.includes(depth) || !receipt) return;
        const cost = Number(receipt.cost_usd), ms = Number(receipt.time_ms);
        if (!Number.isFinite(cost) || !Number.isFinite(ms) || cost < 0 || ms < 0) return;
        const k = slot(depth, output);
        const row = JSON.stringify([Math.round(cost * 1e6) / 1e6, Math.round(ms), now()]);
        if (valkey) {
            try { await valkey.client.lpush(keyOf(k), row); await valkey.client.ltrim(keyOf(k), 0, KEEP - 1); return; } catch (err) { log.warn(`[search] depth stats: ${(err && err.message) || err}`); }
        }
        const list = local.get(k) || [];
        list.unshift(row);
        if (list.length > KEEP) list.length = KEEP;
        local.set(k, list);
    }

    async function rows(k) {
        if (valkey) { try { return await valkey.client.lrange(keyOf(k), 0, KEEP - 1); } catch { /* the process's own below */ } }
        return local.get(k) || [];
    }

    const pick = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

    async function summary() {
        const depths = [];
        for (const depth of DEPTHS) {
            for (const output of OUTPUTS) {
                const parsed = (await rows(slot(depth, output))).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Array.isArray);
                if (!parsed.length) { depths.push({ depth, output, n: 0, cost_usd: null, time_ms: null }); continue; }
                const costs = parsed.map((r) => r[0]).sort((a, b) => a - b), times = parsed.map((r) => r[1]).sort((a, b) => a - b);
                depths.push({
                    depth, output, n: parsed.length,
                    cost_usd: { p50: pick(costs, 0.5), p90: pick(costs, 0.9) },
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
