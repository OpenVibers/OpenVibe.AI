'use strict';
/**
 * §2.1.8 bounded free allowance (T6 step 2). Each platform.rate-card@1's free_allowance/reset_period
 * (server/providers/rate-cards.js) is provider capacity a subject uses free before its spend is priced. The
 * counter is per subject + provider + metric + reset period (free_allowance_usage, migrations/0006). account()
 * claims from it inside its own transaction; the free tokens are reported as free_allowance_used on the run's
 * platform.usage-sample@1 and their list price is left out of its cost_estimate.
 *
 * Pricing only, never admission: reserve() and the request counters are untouched and no call is refused here.
 * A claim is atomic: the period's row is created if missing, then locked (SELECT … FOR UPDATE) before the free
 * share is computed, so concurrent claims for one subject, provider, metric and period never exceed the card's
 * free_allowance in total.
 *
 * With AI_GOVERN_TIERS on, `store` (server/govern.js freeStore) holds the counter in Valkey instead, claimed in one
 * atomic step; free_allowance_usage then keeps the store's total (never lower), which is the store's floor when
 * a key was lost and what the console reads. The numbers are the same either way.
 *
 *   const free = createFreeAllowance(db, { cardsFor: pool.rateCardsFor });
 *   const { tokens, usd, byKind } = await free.claim(subject, provider, model, { in, cached, out });   // inside db.tx
 *
 * `byKind[kind]` is { tokens, usd, cost }: that kind's free tokens, their list price, and the list price of its
 * whole quantity — account() turns each into one reading with its own free_allowance_used and cost_estimate.
 */
const rates = require('./providers/rate-cards');

const KINDS = ['in', 'cached', 'out'];
const NEVER = 8.64e15;   // the last instant a Date can hold: the end of a 'none' period with no effective_until

/** Who an allowance belongs to: the attribution, else the actor, else the requester; null → nothing is free. */
function subjectOf(ctx = {}) {
    if (ctx.attributionKey) return String(ctx.attributionKey);
    if (ctx.actorKey) return String(ctx.actorKey);
    return ctx.requesterType && ctx.requesterId ? `${ctx.requesterType}:${ctx.requesterId}` : null;
}

/**
 * The card's allowance period holding `now`: periodOf's UTC day or month. 'none' never resets, so it is one
 * period for the card's terms, from effective_from (unknown: the epoch) to effective_until (else never), not
 * periodOf's rolling usage lookback, whose start moves every day.
 */
function periodFor(card, now) {
    const p = rates.periodOf(card.reset_period, now, card.effective_from);
    if (card.reset_period !== 'none') return p;
    const from = Date.parse(card.effective_from);
    const until = card.effective_until ? Date.parse(card.effective_until) : NaN;
    return { start: Number.isFinite(from) ? from : 0, end: Number.isFinite(until) ? until : NEVER };
}

function createFreeAllowance(db, { cardsFor, clock = { now: () => Date.now() }, store = null }) {
    const open = db.prepare(`INSERT INTO free_allowance_usage (subject, provider, metric, period_start, period_end, free_used, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT (subject, provider, metric, period_start) DO NOTHING`);
    const lock = db.prepare('SELECT free_used FROM free_allowance_usage WHERE subject = ? AND provider = ? AND metric = ? AND period_start = ? FOR UPDATE');
    const take = db.prepare('UPDATE free_allowance_usage SET free_used = free_used + ?, updated_at = ? WHERE subject = ? AND provider = ? AND metric = ? AND period_start = ?');
    const floor = db.prepare('SELECT free_used FROM free_allowance_usage WHERE subject = ? AND provider = ? AND metric = ? AND period_start = ?');
    const mirror = db.prepare(`INSERT INTO free_allowance_usage (subject, provider, metric, period_start, period_end, free_used, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (subject, provider, metric, period_start)
        DO UPDATE SET free_used = GREATEST(free_allowance_usage.free_used, excluded.free_used), updated_at = excluded.updated_at`);

    /** The free share of q on the store: one atomic claim, then its total is kept in free_allowance_usage. */
    async function claimOnStore(subject, provider, c, p, q, cap, at, now) {
        const row = await floor.get(subject, provider, c.metric, p.start);
        const r = await store.claim(`${subject}|${provider}|${c.metric}|${p.start}`, q, cap, row ? Number(row.free_used) : 0, p.end >= NEVER ? 0 : p.end + 86400000, now);
        if (r.used != null) await mirror.run(subject, provider, c.metric, p.start, p.end, r.used, at);
        return r.free;
    }

    /**
     * Claim this attempt's free tokens: usage { in (excluding cached), cached, out } on `provider`/`model`.
     * Returns { tokens, usd, byKind }: the free tokens and their list price in total, and, per kind
     * (`in` | `cached` | `out`), { tokens, usd, cost } — the free tokens, their list price, and the list
     * price of the whole requested quantity. account() writes one platform.usage-sample@1 per kind from
     * this, so each reading's free_allowance_used and cost_estimate are its own (server/usage-samples.js).
     * A provider with no cards (never billed) claims nothing: byKind is all zeros. A card with
     * free_allowance 0 claims nothing but still reports its list cost (the reading is fully priced).
     */
    async function claim(subject, provider, model, usage = {}, now = clock.now()) {
        const byKind = Object.fromEntries(KINDS.map((kind) => [kind, { tokens: 0, usd: 0, cost: 0 }]));
        const out = { tokens: 0, usd: 0, byKind };
        if (!subject || !provider) return out;
        const cards = await cardsFor(provider, model || null);
        if (!cards) return out;
        const at = new Date(now).toISOString();
        await db.tx(async () => {
            for (const kind of KINDS) {   // one fixed order, so two claims lock rows in the same order
                const c = cards[kind];
                const cap = Math.floor(Number(c && c.free_allowance) || 0);
                const q = Math.max(0, Math.floor(Number(usage[kind]) || 0));
                const k = byKind[kind];
                if (c) k.cost = (q / c.unit_size) * c.unit_price_usd;   // the whole quantity's list price, free or not
                if (cap <= 0 || q <= 0) continue;
                const p = periodFor(c, now);
                if (store) {
                    k.tokens = await claimOnStore(subject, provider, c, p, q, cap, at, now);
                } else {
                    await open.run(subject, provider, c.metric, p.start, p.end, at);
                    const row = await lock.get(subject, provider, c.metric, p.start);
                    const free = Math.min(q, Math.max(0, cap - Number(row.free_used)));
                    if (free) { await take.run(free, at, subject, provider, c.metric, p.start); k.tokens = free; }
                }
                k.usd = (k.tokens / c.unit_size) * c.unit_price_usd;
                out.tokens += k.tokens;
                out.usd += k.usd;
            }
        });
        return out;
    }

    /**
     * Free used and remaining in the current periods, for the staff console (never a public page: rows are per
     * subject). Rows: { subject, provider, metric, period_start, period_end, free_used, free_allowance, remaining }.
     */
    async function current({ now = clock.now(), limit = 200 } = {}) {
        const rows = await db.prepare(`SELECT subject, provider, metric, period_start, period_end, free_used FROM free_allowance_usage
            WHERE period_start <= ? AND period_end > ? ORDER BY provider, metric, subject LIMIT ?`).all(now, now, limit);
        const byKind = { 'input-tokens': 'in', 'cached-input-tokens': 'cached', 'output-tokens': 'out' };
        const out = [];
        for (const r of rows) {
            const i = r.metric.indexOf(':');
            const cards = await cardsFor(r.provider, i < 0 ? null : r.metric.slice(i + 1));
            const c = cards && cards[byKind[i < 0 ? r.metric : r.metric.slice(0, i)]];
            const cap = c ? Number(c.free_allowance) || 0 : 0;
            out.push({ ...r, period_start: Number(r.period_start), period_end: Number(r.period_end), free_used: Number(r.free_used), free_allowance: cap, remaining: Math.max(0, cap - Number(r.free_used)) });
        }
        return out;
    }

    return { claim, current };
}

module.exports = { createFreeAllowance, subjectOf, periodFor };
