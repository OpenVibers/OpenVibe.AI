'use strict';

/**
 * The abliteration tax: the same objective benchmark set run on a base model and on its abliterated
 * build, so the score difference (and its interval) shows what removing refusals cost in skill.
 *
 * The pairs are declared in server/willing/datasets/abliteration-pairs.json (base id, abliterated id, source
 * link). The objective set is server/willing/datasets/objective-set.json: every item has one answer a deterministic
 * matcher can check, so no LLM judge is involved.
 *
 * The run is default OFF and only happens inside the owner's budget. `plan()` is the dry run: it lists
 * every side of every pair and the estimated cost from the live rate cards, without calling a provider.
 * An abliterated build is an uncensored offer, so its side is asked under the adult tier and needs the
 * configured adult measurement account; without one the plan is blocked. The hard floor still applies.
 */
const os = require('os');
const {
    PAIRS, PAIRS_VERSION, OBJECTIVE, OBJECTIVE_VERSION, SYSTEM, promptTokens, costOf, money,
    scoreObjective, differenceInterval, wilson,
} = require('./index');
const { createJobState } = require('./state');
const { priceOf: readPrice } = require('./pricebook');
const { textsOfAnswer } = require('../policy/floor');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Score two answer lists over the same objective items. Only items both sides answered are compared,
 * so a provider error on one side lowers n rather than the other side's score.
 * → { n, base_passed, abliterated_passed, base_rate, abliterated_rate, difference, ci_lower, ci_upper }
 */
function scorePair(baseAnswers, abliteratedAnswers, items = OBJECTIVE) {
    let n = 0;
    let basePassed = 0;
    let abliteratedPassed = 0;
    for (let i = 0; i < items.length; i++) {
        const base = baseAnswers[i];
        const abl = abliteratedAnswers[i];
        if (base == null || abl == null) continue;
        n++;
        if (scoreObjective(items[i], base)) basePassed++;
        if (scoreObjective(items[i], abl)) abliteratedPassed++;
    }
    if (!n) return { n: 0, base_passed: 0, abliterated_passed: 0, base_rate: null, abliterated_rate: null, difference: null, ci_lower: null, ci_upper: null };
    const base = wilson(basePassed, n);
    const abl = wilson(abliteratedPassed, n);
    const diff = differenceInterval({ successes: basePassed, n }, { successes: abliteratedPassed, n });
    return {
        n,
        base_passed: basePassed,
        abliterated_passed: abliteratedPassed,
        base_rate: base.rate,
        abliterated_rate: abl.rate,
        difference: diff ? diff.difference : null,
        ci_lower: diff ? diff.lower : null,
        ci_upper: diff ? diff.upper : null,
    };
}

function createAbliterationTax({ db, pool, config = {}, clock = { now: () => Date.now() }, log = console, adultFor = null, ask = null }) {
    const settings = {
        enabled: false,
        budgetUsd: 0,
        intervalMs: WEEK_MS,
        tickMs: HOUR_MS,
        firstTickMs: 5 * 60 * 1000,
        claimTtlMs: 15 * 60 * 1000,
        outputTokens: 256,
        adultSubject: null,
        ...(config.abliterationTax || {}),
    };
    const state = createJobState({ db, id: 'abliteration_tax', clock });
    const who = `${os.hostname()}:${process.pid}`;
    let running = false;
    let timer = null;
    let first = null;
    let last = null;

    const iso = () => new Date(clock.now()).toISOString();
    const day = () => iso().slice(0, 10);

    /** The dry run: the sides, the objective set, and the estimated cost from the live rate cards. */
    async function plan() {
        const rows = [];
        let knownTotal = 0;
        let unpriced = 0;
        let needsAdult = 0;
        for (const pair of PAIRS) {
            for (const [side, offer] of [['base', pair.base], ['abliterated', pair.abliterated]]) {
                const p = await readPrice(pool, offer.provider, offer.model);
                const inputTokens = OBJECTIVE.reduce((n, item) => n + promptTokens(item.prompt), 0);
                const outputTokens = OBJECTIVE.length * Math.max(1, Number(settings.outputTokens) || 256);
                const estimated = p.price ? costOf(p.price, inputTokens, outputTokens) : null;
                if (estimated == null) unpriced++; else knownTotal += estimated;
                const uncensored = side === 'abliterated';
                if (uncensored) needsAdult++;
                rows.push({
                    pair_id: pair.id,
                    family: pair.family,
                    side,
                    provider: offer.provider,
                    model: offer.model,
                    source: pair.source,
                    uncensored,
                    n: OBJECTIVE.length,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    price: p.price,
                    price_source: p.source,
                    estimated_cost_usd: estimated,
                    requires_adult_subject: uncensored,
                    note: estimated == null ? 'no pricebook price, so the cost is unknown' : null,
                });
            }
        }
        const total = money(knownTotal);
        const adultSubject = settings.adultSubject ? String(settings.adultSubject) : null;
        let adultOk = true;
        if (needsAdult) {
            if (!adultSubject) adultOk = false;
            else if (typeof adultFor === 'function') {
                try { adultOk = Boolean(await adultFor(adultSubject)); } catch { adultOk = false; }
            }
        }
        const budget = Number(settings.budgetUsd) || 0;
        let reason = null;
        if (settings.enabled !== true) reason = 'disabled';
        else if (!(budget > 0)) reason = 'no_owner_budget';
        else if (unpriced) reason = 'unpriced_offers';
        else if (!adultOk) reason = 'adult_measurement_subject_required';
        else if (total == null || total > budget) reason = 'over_budget';
        return {
            adult: true,
            dry_run: true,
            kind: 'abliteration.tax',
            pairs: PAIRS.length,
            pairs_version: PAIRS_VERSION,
            objective_set: OBJECTIVE_VERSION,
            objective_items: OBJECTIVE.length,
            output_tokens: Math.max(1, Number(settings.outputTokens) || 256),
            runs: rows,
            budget_usd: money(budget),
            estimated_cost_usd: unpriced ? null : total,
            known_cost_usd: total,
            unpriced_offers: unpriced,
            adult_subject_configured: Boolean(adultSubject),
            adult_subject_ok: adultOk,
            enabled: settings.enabled === true,
            allowed: reason == null,
            reason,
            never_calls: true,
        };
    }

    /** One answer, under the policy its offer can serve. */
    async function askOffer(offer, uncensored, prompt, pairId) {
        if (uncensored) {
            if (!settings.adultSubject) throw new Error('abliteration.adult_subject_required');
            if (typeof adultFor !== 'function' || !(await adultFor(settings.adultSubject))) throw new Error('abliteration.adult_subject_not_adult');
        }
        const req = { system: [{ text: SYSTEM }], messages: [{ role: 'user', content: prompt }], maxTokens: Math.max(1, Number(settings.outputTokens) || 256), temperature: 0 };
        const route = { key: 'abliteration-tax', primary: { provider: offer.provider, model: offer.model }, fallbacks: [] };
        const out = await pool.execute(route, 'chat', req, {
            exact: { id: `${offer.provider}/${offer.model}`, offers: [{ provider: offer.provider, model: offer.model }] },
            creditsRequired: false,
            contentPolicy: uncensored ? 'uncensored' : 'standard',
            runId: `abliteration-tax:${pairId}:${offer.provider}/${offer.model}`,
        });
        return textsOfAnswer(out && out.result).join('\n');
    }

    async function answersFor(pair, side, offer) {
        const uncensored = side === 'abliterated';
        const answers = [];
        for (const item of OBJECTIVE) {
            let answer = null;
            try { answer = ask ? await ask({ pair, side, offer, item }) : await askOffer(offer, uncensored, item.prompt, pair.id); } catch { answer = null; }
            answers.push(answer && String(answer).trim() ? answer : null);
        }
        return answers;
    }

    async function store(pair, score) {
        if (!score || !score.n) return false;
        const at = iso();
        await db.prepare(`INSERT INTO abliteration_tax (pair_id, family, base_provider, base_model, abliterated_provider, abliterated_model,
                source, objective_set, n, base_passed, abliterated_passed, base_rate, abliterated_rate, difference, ci_lower, ci_upper,
                measured_at, measured_on, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (pair_id) DO UPDATE SET family = EXCLUDED.family, base_provider = EXCLUDED.base_provider, base_model = EXCLUDED.base_model,
                abliterated_provider = EXCLUDED.abliterated_provider, abliterated_model = EXCLUDED.abliterated_model, source = EXCLUDED.source,
                objective_set = EXCLUDED.objective_set, n = EXCLUDED.n, base_passed = EXCLUDED.base_passed,
                abliterated_passed = EXCLUDED.abliterated_passed, base_rate = EXCLUDED.base_rate, abliterated_rate = EXCLUDED.abliterated_rate,
                difference = EXCLUDED.difference, ci_lower = EXCLUDED.ci_lower, ci_upper = EXCLUDED.ci_upper,
                measured_at = EXCLUDED.measured_at, measured_on = EXCLUDED.measured_on, updated_at = EXCLUDED.updated_at`)
            .run(pair.id, pair.family, pair.base.provider, pair.base.model, pair.abliterated.provider, pair.abliterated.model,
                pair.source, OBJECTIVE_VERSION, score.n, score.base_passed, score.abliterated_passed,
                score.base_rate == null ? null : String(score.base_rate), score.abliterated_rate == null ? null : String(score.abliterated_rate),
                score.difference == null ? null : String(score.difference), score.ci_lower == null ? null : String(score.ci_lower),
                score.ci_upper == null ? null : String(score.ci_upper), at, day(), at);
        return true;
    }

    async function due() {
        const lastAt = await state.lastRunAt();
        if (lastAt === null) return true;
        return clock.now() - lastAt >= Number(settings.intervalMs);
    }

    async function runOnce({ force = false } = {}) {
        if (running) return { skipped: 'running' };
        running = true;
        const report = { kind: 'abliteration.tax', pairs_version: PAIRS_VERSION, objective_set: OBJECTIVE_VERSION, started_at: iso(), pairs: 0, measured: 0, unanswered: [], errors: [] };
        try {
            const p = await plan();
            if (!p.allowed) return { skipped: p.reason, plan: p };
            if (!force && !await due()) return { skipped: 'not due' };
            if (!await state.claim({ ttlMs: Number(settings.claimTtlMs), who })) return { skipped: 'claimed' };
            try {
                for (const pair of PAIRS) {
                    report.pairs++;
                    try {
                        const baseAnswers = await answersFor(pair, 'base', pair.base);
                        const ablAnswers = await answersFor(pair, 'abliterated', pair.abliterated);
                        const score = scorePair(baseAnswers, ablAnswers);
                        if (!score.n) { report.unanswered.push(pair.id); continue; }
                        await store(pair, score);
                        report.measured++;
                    } catch (err) {
                        report.errors.push({ pair: pair.id, error: String((err && err.message) || err).slice(0, 200) });
                    }
                }
            } finally { await state.release({ who }); }
            if (report.measured || !report.pairs) await state.markRun();
        } catch (err) {
            report.error = (err && err.code) || 'error';
            log.warn('[abliteration-tax] the run stopped early: ' + report.error);
        } finally { running = false; }
        last = report;
        log.log(`[abliteration-tax] measured ${report.measured}/${report.pairs} pairs${report.unanswered.length ? `; unanswered: ${report.unanswered.length}` : ''}`);
        return report;
    }

    async function tick() {
        if (running) return { skipped: 'running' };
        if (settings.enabled !== true) return { skipped: 'disabled' };
        if (!await due()) return { skipped: 'not due' };
        return runOnce();
    }

    function start() {
        if (timer) return timer;
        const every = Math.max(60000, Number(settings.tickMs) || HOUR_MS);
        timer = setInterval(() => { tick().catch(() => {}); }, every);
        timer.unref?.();
        first = setTimeout(() => { tick().catch(() => {}); }, Math.max(1000, Number(settings.firstTickMs) || 5 * 60 * 1000));
        first.unref?.();
        return timer;
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        if (first) { clearTimeout(first); first = null; }
    }

    return { runOnce, tick, due, start, stop, plan, answersFor, state, settings, get last() { return last; } };
}

module.exports = { createAbliterationTax, scorePair, PAIRS, OBJECTIVE, PAIRS_VERSION, OBJECTIVE_VERSION, WEEK_MS };
