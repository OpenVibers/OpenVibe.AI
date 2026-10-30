'use strict';
/**
 * The budget one Codes run token carries, and what that run has spent (Codes C3).
 *
 * A run token is minted by Network for one attempt and names the person whose key it spends. The budget is
 * a row here, keyed by the token's jti, and not a claim inside the token:
 *   - only Codes writes the row (with its own service token), so the holder of a run token cannot raise it;
 *   - the jti is signed inside the token by Network, so a holder cannot name another run's budget;
 *   - a budget that arrives in a request (a header, a body field) is ignored: there is nothing to forge.
 * The row dies with the token: it expires at the token's expiry, and an expired row is no budget at all.
 *
 * The counter is what the runs add to: each finished run adds its tokens and its cost (the same numbers
 * the quota accounting uses, server/quota.js). The cap is checked BEFORE every request, so the request that
 * crosses the line still completes and the next one is refused.
 */
const { AiError } = require('./util');

/** The problem a run over its budget gets: 402, with the budget that ran out and what was spent. */
function budgetReached(budget, spent, limit) {
    const which = budget === 'tokens' ? 'tokens' : 'dollars';
    const spentText = budget === 'tokens' ? `${spent.tokens} tokens` : `$${Number(spent.usd).toFixed(4)}`;
    const limitText = budget === 'tokens' ? `${limit} tokens` : `$${Number(limit).toFixed(2)}`;
    return new AiError(402, 'ai.run_budget_reached',
        `this run reached its ${which} budget: ${spentText} of ${limitText} spent. It may not spend more.`,
        { budget, limit, spent_usd: spent.usd, spent_tokens: spent.tokens });
}

function createRunBudgets(db, { clock = { now: () => Date.now() } } = {}) {
    const nowSec = () => Math.floor(clock.now() / 1000);
    const nowIso = () => new Date(clock.now()).toISOString();

    const getRow = db.prepare('SELECT * FROM run_budgets WHERE jti = ?');
    const put = db.prepare(`INSERT INTO run_budgets (jti, budget_usd, budget_tokens, spent_usd, spent_tokens, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?, ?)
        ON CONFLICT (jti) DO NOTHING`);
    const bump = db.prepare('UPDATE run_budgets SET spent_usd = spent_usd + ?, spent_tokens = spent_tokens + ?, updated_at = ? WHERE jti = ?');
    const drop = db.prepare('DELETE FROM run_budgets WHERE jti = ?');

    /** The budget a number is: null, or a finite number above zero. */
    function asLimit(value) {
        if (value == null || value === '') return null;
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n;
    }

    /** The row for a token, if it is still alive: a budget that expired with its token is no budget. */
    async function forToken(jti) {
        if (!jti) return null;
        const row = await getRow.get(jti);
        if (!row) return null;
        if (Number(row.expires_at) <= nowSec()) return null;
        return row;
    }

    /**
     * Register the budget of a run token (Codes, when it mints the token). A token without a budget is not
     * capped: nothing is written and nothing is returned.
     *
     * @param {object} what
     * @param {string} what.jti the token's jti
     * @param {number|null} [what.budgetUsd] the dollars the run may spend
     * @param {number|null} [what.budgetTokens] the tokens the run may spend
     * @param {number|null} [what.expiresAt] epoch seconds: the token's expiry
     */
    async function register({ jti, budgetUsd = null, budgetTokens = null, expiresAt = null }) {
        if (!jti) return null;
        const usd = asLimit(budgetUsd);
        const tokens = asLimit(budgetTokens);
        if (usd == null && tokens == null) return null;
        const exp = Math.round(Number(expiresAt)) || (nowSec() + 7200);
        // Set once: the first registration wins. The same numbers again are an idempotent retry; other numbers are a
        // conflict the caller is told about, never an update.
        await put.run(jti, usd, tokens == null ? null : Math.round(tokens), exp, nowIso(), nowIso());
        const row = await getRow.get(jti);   // the row as it is stored: a budget that expired already is still a budget
        const same = row && Number(row.budget_usd == null ? -1 : row.budget_usd) === (usd == null ? -1 : usd)
            && Number(row.budget_tokens == null ? -1 : row.budget_tokens) === (tokens == null ? -1 : Math.round(tokens));
        return same ? row : { ...row, conflict: true };
    }

    /**
     * Whether the run may spend: what it has spent against what it may spend. A run with no budget is never
     * refused, and the request that crosses the line still completes (the check is before the next one).
     */
    async function check(jti) {
        const row = await forToken(jti);
        if (!row) return { ok: true, capped: false };
        const spent = { usd: Number(row.spent_usd) || 0, tokens: Number(row.spent_tokens) || 0 };
        const budgetUsd = row.budget_usd == null ? null : Number(row.budget_usd);
        const budgetTokens = row.budget_tokens == null ? null : Number(row.budget_tokens);
        if (budgetUsd != null && spent.usd >= budgetUsd) return { ok: false, capped: true, budget: 'usd', limit: budgetUsd, spent };
        if (budgetTokens != null && spent.tokens >= budgetTokens) return { ok: false, capped: true, budget: 'tokens', limit: budgetTokens, spent };
        return { ok: true, capped: true, budget: null, limit: null, spent };
    }

    /** The refusal a run over its budget gets (402, ai.run_budget_reached). */
    async function refuse(jti) {
        const state = await check(jti);
        if (state.ok) return null;
        return budgetReached(state.budget, state.spent, state.limit);
    }

    /** What a finished run spent, added to the counter (the numbers the quota accounting uses). */
    async function add(jti, { tokens = 0, cost = 0 } = {}) {
        if (!jti) return null;
        const t = Math.max(0, Math.round(Number(tokens) || 0));
        const c = Math.max(0, Number(cost) || 0);
        if (!t && !c) return null;
        await bump.run(c, t, nowIso(), jti);
        return forToken(jti);
    }

    /** What a run has spent, for the service that registered the budget. */
    async function spent(jti) {
        const row = await getRow.get(jti);
        if (!row) return null;
        return {
            jti: row.jti,
            budget_usd: row.budget_usd == null ? null : Number(row.budget_usd),
            budget_tokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
            spent_usd: Number(row.spent_usd) || 0,
            spent_tokens: Number(row.spent_tokens) || 0,
            expires_at: Number(row.expires_at),
            reached: (row.budget_usd != null && (Number(row.spent_usd) || 0) >= Number(row.budget_usd))
                || (row.budget_tokens != null && (Number(row.spent_tokens) || 0) >= Number(row.budget_tokens)),
        };
    }

    /** Forget the budgets whose token has expired. */
    async function prune() {
        const gone = await db.prepare('DELETE FROM run_budgets WHERE expires_at <= ?').run(nowSec());
        return Number(gone && gone.changes) || 0;
    }

    return { register, check, refuse, add, spent, forToken, prune, budgetReached };
}

module.exports = { createRunBudgets, budgetReached };
