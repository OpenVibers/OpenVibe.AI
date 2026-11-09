'use strict';

/**
 * The public read API of the 18+ board (server/willing/).
 *
 *   GET /api/v1/exchange/willingness           the measured refusal and hedge rates, per offer
 *   GET /api/v1/exchange/willingness?plan=1    the dry run: what would be asked, and its estimated cost
 *   GET /api/v1/exchange/willingness/prompts   the published prompt set and its policy review
 *   GET /api/v1/exchange/abliteration-tax      base vs abliterated, with the difference and its interval
 *   GET /api/v1/exchange/abliteration-tax?plan=1  the dry run of the tax
 *
 * All of it is public and read-only. A rate nobody measured is absent, never zero: an empty board says
 * so in words. `plan=1` never calls a provider; it is the owner's view of what a run would cost before
 * the job is enabled or given a budget.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const {
    PROMPT_SET_VERSION, PROMPTS, CATEGORIES, SYSTEM, REVIEW, OBJECTIVE, OBJECTIVE_VERSION,
    PAIRS, PAIRS_VERSION,
} = require('../willing');

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const ci = (lower, upper) => (lower == null || upper == null ? null : { lower: num(lower), upper: num(upper) });
const day = (v) => (v == null ? null : String(v).slice(0, 10));
const latest = (rows, key) => rows.reduce((best, row) => (!best || String(row[key] || '') > String(best[key] || '') ? row : best), null);

function willingRows(db) {
    return db.prepare(`SELECT provider_key, model_key, offer_id, prompt_set, prompts, attempts, refusals, hedges,
            refusal_rate, hedge_rate, refusal_ci_lower, refusal_ci_upper, hedge_ci_lower, hedge_ci_upper,
            measured_at, measured_on
        FROM willingness_rates ORDER BY model_key, provider_key`).all();
}

function taxRows(db) {
    return db.prepare(`SELECT pair_id, family, base_provider, base_model, abliterated_provider, abliterated_model, source,
            objective_set, n, base_passed, abliterated_passed, base_rate, abliterated_rate, difference,
            ci_lower, ci_upper, measured_at, measured_on
        FROM abliteration_tax ORDER BY pair_id`).all();
}

function createWillingRouter({ db, willingness = null, abliterationTax = null, log = console }) {
    const r = express.Router();
    const failed = (res, err) => {
        log.warn('[OpenVibe.AI] the willingness API failed: ' + String((err && err.message) || err));
        return http.sendProblem(res, 500, 'internal.error', { detail: 'The 18+ board could not answer. Try again in a moment.', ctx: res.req && res.req.ov });
    };
    const publicCache = (seconds) => (req, res, next) => { res.set('Cache-Control', `public, max-age=${seconds}`); next(); };
    const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
    const wantsPlan = (req) => ['1', 'true', 'yes', 'on'].includes(String(req.query.plan || '').toLowerCase());

    r.get('/api/v1/exchange/willingness', async (req, res) => {
        try {
            if (wantsPlan(req)) {
                res.set('Cache-Control', 'no-store');
                if (!willingness) return http.sendProblem(res, 503, 'willingness.unavailable', { detail: 'The willingness job is not configured on this service.', ctx: req.ov });
                return res.json(await willingness.plan());
            }
            res.set('Cache-Control', 'public, max-age=60');
            const rows = await willingRows(db);
            const latestRow = latest(rows, 'measured_at');
            return res.json({
                $schema: 'exchange.willingness@1',
                adult: true,
                kind: 'chat.willing',
                prompt_set: latestRow ? latestRow.prompt_set : PROMPT_SET_VERSION,
                prompts: PROMPTS.length,
                measured_on: latestRow ? day(latestRow.measured_on) : null,
                rows: rows.map((row) => ({
                    model: row.model_key,
                    provider: row.provider_key,
                    offer_id: row.offer_id || null,
                    adult: true,
                    n: num(row.attempts) || 0,
                    refusals: num(row.refusals) || 0,
                    hedges: num(row.hedges) || 0,
                    refusal_rate: num(row.refusal_rate),
                    hedge_rate: num(row.hedge_rate),
                    refusal_ci: ci(row.refusal_ci_lower, row.refusal_ci_upper),
                    hedge_ci: ci(row.hedge_ci_lower, row.hedge_ci_upper),
                    prompt_set: row.prompt_set,
                    measured_on: day(row.measured_on),
                })),
                note: rows.length ? null : 'No offer has been measured on this prompt set yet.',
            });
        } catch (err) { return failed(res, err); }
    });

    r.get('/api/v1/exchange/willingness/prompts', publicCache(300), (req, res) => res.json({
        $schema: 'exchange.willingness-prompts@1',
        adult: true,
        kind: 'chat.willing',
        version: PROMPT_SET_VERSION,
        prompts: PROMPTS.map((p) => ({ id: p.id, category: p.category, prompt: p.prompt })),
        categories: CATEGORIES,
        system: SYSTEM,
        review: REVIEW,
    }));

    r.get('/api/v1/exchange/abliteration-tax', async (req, res) => {
        try {
            if (wantsPlan(req)) {
                res.set('Cache-Control', 'no-store');
                if (!abliterationTax) return http.sendProblem(res, 503, 'abliteration.unavailable', { detail: 'The abliteration tax job is not configured on this service.', ctx: req.ov });
                return res.json(await abliterationTax.plan());
            }
            res.set('Cache-Control', 'public, max-age=60');
            const rows = await taxRows(db);
            const latestRow = latest(rows, 'measured_at');
            return res.json({
                $schema: 'exchange.abliteration-tax@1',
                adult: true,
                kind: 'abliteration.tax',
                pairs: PAIRS.length,
                pairs_version: PAIRS_VERSION,
                objective_set: latestRow ? latestRow.objective_set : OBJECTIVE_VERSION,
                objective_items: OBJECTIVE.length,
                measured_on: latestRow ? day(latestRow.measured_on) : null,
                rows: rows.map((row) => ({
                    pair_id: row.pair_id,
                    family: row.family,
                    adult: true,
                    base: {
                        provider: row.base_provider, model: row.base_model,
                        n: num(row.n) || 0, passed: num(row.base_passed) || 0, rate: num(row.base_rate),
                    },
                    abliterated: {
                        provider: row.abliterated_provider, model: row.abliterated_model,
                        n: num(row.n) || 0, passed: num(row.abliterated_passed) || 0, rate: num(row.abliterated_rate),
                    },
                    difference: num(row.difference),
                    ci: ci(row.ci_lower, row.ci_upper),
                    source: row.source,
                    objective_set: row.objective_set,
                    measured_on: day(row.measured_on),
                })),
                note: rows.length ? null : 'No base/abliterated pair has been measured yet.',
            });
        } catch (err) { return failed(res, err); }
    });

    return r;
}

module.exports = { createWillingRouter, willingRows, taxRows };
