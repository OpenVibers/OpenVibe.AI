'use strict';
/**
 * The budget of a Codes run token, and what that run has spent (Codes C3).
 *
 *   PUT /api/v1/run-budgets/:jti    register the budget of one run token (Codes, when it mints the token)
 *   GET /api/v1/run-budgets/:jti    what the run may spend and what it has spent
 *
 * The jti is the run token's own id, signed inside the token by Network: the service that mints the token
 * is the one that registers its budget (only `svc:codes`, never a token acting for a person), once: a second
 * registration with other numbers is refused (409), so the holder of the token can neither change the budget nor name
 * another run's budget. A budget that arrives in the request body of a model call is ignored: there is
 * nothing there to forge.
 */
const express = require('express');
const { AiError } = require('../util');

const JTI_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

function runBudgetsRouter({ runBudgets, auth, log = console, sendError }) {
    const r = express.Router();
    const guard = auth.requireCap('ai.run.create');

    const jtiOf = (req) => {
        const jti = String(req.params.jti || '');
        if (!JTI_RE.test(jti)) throw new AiError(422, 'input.invalid', 'the jti is not a run token id');
        return jti;
    };

    // Only the service that mints run tokens writes a budget, with its own token: a run token (on_behalf_of a
    // person, held by the agent the budget limits) passes ai.run.create too, and must never reach this write, or the
    // agent could raise its own cap (10-30 review of #204).
    const WRITERS = new Set(String(process.env.AI_RUN_BUDGET_WRITERS || 'svc:codes').split(',').map((x) => x.trim()).filter(Boolean));
    const writer = (req, res, next) => {
        const c = (req.principal && req.principal.claims) || {};
        if (c.on_behalf_of || !WRITERS.has(String(c.sub || ''))) {
            return sendError(res, new AiError(403, 'capability.denied', 'only the service that mints run tokens registers their budgets'), req.ov, log);
        }
        return next();
    };

    r.put('/api/v1/run-budgets/:jti', guard, writer, async (req, res) => {
        try {
            const jti = jtiOf(req);
            const body = req.body || {};
            const row = await runBudgets.register({
                jti,
                budgetUsd: body.budget_usd == null ? null : Number(body.budget_usd),
                budgetTokens: body.budget_tokens == null ? null : Number(body.budget_tokens),
                expiresAt: body.expires_at == null ? null : Number(body.expires_at),
            });
            if (!row) throw new AiError(422, 'input.invalid', 'a budget needs dollars or tokens');
            if (row.conflict) throw new AiError(409, 'ai.run_budget.exists', 'this run token already has a different budget; a budget is set once, when the token is minted');
            res.set('Cache-Control', 'no-store').json({
                jti: row.jti,
                budget_usd: row.budget_usd == null ? null : Number(row.budget_usd),
                budget_tokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
                expires_at: Number(row.expires_at),
            });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    r.get('/api/v1/run-budgets/:jti', guard, async (req, res) => {
        try {
            const jti = jtiOf(req);
            const row = await runBudgets.spent(jti);
            if (!row) { res.set('Cache-Control', 'no-store').json({ jti, budget_usd: null, budget_tokens: null, spent_usd: 0, spent_tokens: 0, reached: false, expires_at: null }); return; }
            res.set('Cache-Control', 'no-store').json(row);
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    return r;
}

module.exports = { runBudgetsRouter };
