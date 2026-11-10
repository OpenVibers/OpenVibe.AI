'use strict';

/**
 * The willingness job: asks every offer the same published set of lawful adult prompts and records
 * how often it refused or hedged them.
 *
 *   - The prompt set is fixed and published (server/willing/datasets/prompts.json): 60 prompts, each with a
 *     category, reviewed against the hard floor. The version is written next to every rate.
 *   - Refusal and hedge are decided by the published pattern lists (server/willing/classify.js), not
 *     by a person or an LLM. The same answer always gets the same label.
 *   - A rate nobody measured is absent, never zero. An offer that answered none of the prompts keeps
 *     the rate it had, and the report names it as unanswered.
 *   - The job is default OFF and runs only inside the owner's budget. `plan()` is the dry run: it
 *     lists every offer, the prompts and the estimated cost from the live rate cards, and says why it
 *     would not run. Nothing is spent until an owner sets a budget above zero.
 *   - An offer marked uncensored is asked under the adult tier, which needs a real adult measurement
 *     account (`AI_WILLINGNESS_SUBJECT`); without one the plan is blocked rather than quietly asking an
 *     uncensored offer under a policy it cannot serve. The hard floor still applies to both tiers.
 */
const os = require('os');
const {
    PROMPT_SET_VERSION, PROMPTS, SYSTEM, promptTokens, costOf, money,
    classifyRefusal, classifyHedge, wilson,
} = require('./index');
const { createJobState } = require('./state');
const { priceOf: readPrice } = require('./pricebook');
const { textsOfAnswer } = require('../policy/floor');
const tier = require('../policy/tier');
const upstream = require('../providers/upstream');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function createWillingnessJob({ db, registry, pool, config = {}, clock = { now: () => Date.now() }, log = console, env = process.env, measure = null, adultFor = null }) {
    const settings = {
        enabled: false,
        budgetUsd: 0,
        intervalMs: WEEK_MS,
        tickMs: HOUR_MS,
        firstTickMs: 5 * 60 * 1000,
        claimTtlMs: 15 * 60 * 1000,
        maxOffers: 500,
        outputTokens: 256,
        adultSubject: null,
        ...(config.willingness || {}),
    };
    const state = createJobState({ db, id: 'willingness', clock });
    const who = `${os.hostname()}:${process.pid}`;
    let running = false;
    let timer = null;
    let first = null;
    let last = null;

    const iso = () => new Date(clock.now()).toISOString();
    const day = () => iso().slice(0, 10);
    /** The offers this job would ask: live text offers the network may sell. */
    async function offers() {
        const rows = await registry.listModels();
        const out = [];
        for (const row of rows || []) {
            if (row.status !== 'active') continue;
            if (!['chat', 'vision'].includes(row.type)) continue;
            const provider = await registry.getProvider(row.provider_key);
            if (!provider || provider.status !== 'active') continue;
            if (provider.provider_access === 'CUSTOMER_BYOK' || provider.provider_access === 'RESTRICTED') continue;
            if (!upstream.configured(provider, env)) continue;
            out.push({
                providerKey: row.provider_key,
                modelKey: row.model_key,
                offerId: (row.metadata && typeof row.metadata.id === 'string') ? row.metadata.id : null,
                uncensored: tier.offerIsUncensored(provider, row),
            });
            if (out.length >= Math.max(1, Number(settings.maxOffers) || 1)) break;
        }
        return out;
    }

    /**
     * The dry run: every offer, what would be asked, and the estimated cost from the live rate cards.
     * It never calls a provider. `allowed` is the only thing runOnce reads.
     */
    async function plan() {
        const list = await offers();
        const rows = [];
        let knownTotal = 0;
        let unpriced = 0;
        let needsAdult = 0;
        for (const offer of list) {
            const p = await readPrice(pool, offer.providerKey, offer.modelKey);
            const set = PROMPTS.reduce((acc, prompt) => {
                acc.input_tokens += promptTokens(prompt.prompt);
                acc.output_tokens += Math.max(1, Number(settings.outputTokens) || 256);
                return acc;
            }, { input_tokens: 0, output_tokens: 0 });
            const estimated = p.price ? costOf(p.price, set.input_tokens, set.output_tokens) : null;
            if (estimated == null) unpriced++; else knownTotal += estimated;
            if (offer.uncensored) needsAdult++;
            rows.push({
                provider: offer.providerKey,
                model: offer.modelKey,
                offer_id: offer.offerId,
                uncensored: offer.uncensored,
                prompts: PROMPTS.length,
                input_tokens: set.input_tokens,
                output_tokens: set.output_tokens,
                price: p.price,
                price_source: p.source,
                estimated_cost_usd: estimated,
                requires_adult_subject: offer.uncensored,
                note: estimated == null ? 'no pricebook price, so the cost is unknown' : null,
            });
        }
        const total = money(knownTotal);
        const adultSubject = settings.adultSubject ? String(settings.adultSubject) : null;
        let adultOk = true;
        if (needsAdult) {
            if (!adultSubject) { adultOk = false; }
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
            kind: 'chat.willing',
            prompt_set: PROMPT_SET_VERSION,
            prompts: PROMPTS.length,
            output_tokens: Math.max(1, Number(settings.outputTokens) || 256),
            offers: rows.length,
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

    async function ask(offer, prompt) {
        if (offer.uncensored) {
            if (!settings.adultSubject) throw new Error('willingness.adult_subject_required');
            if (typeof adultFor !== 'function' || !(await adultFor(settings.adultSubject))) throw new Error('willingness.adult_subject_not_adult');
        }
        const req = { system: [{ text: SYSTEM }], messages: [{ role: 'user', content: prompt.prompt }], maxTokens: Math.max(1, Number(settings.outputTokens) || 256), temperature: 0 };
        const route = { key: 'willingness', primary: { provider: offer.providerKey, model: offer.modelKey }, fallbacks: [] };
        const out = await pool.execute(route, 'chat', req, {
            exact: { id: `${offer.providerKey}/${offer.modelKey}`, offers: [{ provider: offer.providerKey, model: offer.modelKey }] },
            creditsRequired: false,
            contentPolicy: offer.uncensored ? 'uncensored' : 'standard',
            runId: `willingness:${offer.providerKey}/${offer.modelKey}`,
        });
        return textsOfAnswer(out && out.result).join('\n');
    }

    /** Ask one offer every prompt; an unanswered prompt is not an attempt and not a refusal. */
    async function measureOffer({ offer, probes }) {
        const answers = [];
        for (const probe of probes) {
            let answer = null;
            try { answer = await ask(offer, probe); } catch { answer = null; }
            if (answer != null && String(answer).trim()) answers.push({ probe, answer });
        }
        let refusals = 0;
        let hedges = 0;
        for (const { answer } of answers) {
            if (classifyRefusal(answer).refused) refusals++;
            if (classifyHedge(answer).hedged) hedges++;
        }
        return { attempts: answers.length, refusals, hedges };
    }

    async function store({ offer, attempts, refusals, hedges }) {
        const refusal = wilson(refusals, attempts);
        const hedge = wilson(hedges, attempts);
        const at = iso();
        await db.prepare(`INSERT INTO willingness_rates (provider_key, model_key, offer_id, prompt_set, prompts, attempts, refusals, hedges,
                refusal_rate, hedge_rate, refusal_ci_lower, refusal_ci_upper, hedge_ci_lower, hedge_ci_upper, measured_at, measured_on, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (provider_key, model_key) DO UPDATE SET offer_id = EXCLUDED.offer_id, prompt_set = EXCLUDED.prompt_set,
                prompts = EXCLUDED.prompts, attempts = EXCLUDED.attempts, refusals = EXCLUDED.refusals, hedges = EXCLUDED.hedges,
                refusal_rate = EXCLUDED.refusal_rate, hedge_rate = EXCLUDED.hedge_rate,
                refusal_ci_lower = EXCLUDED.refusal_ci_lower, refusal_ci_upper = EXCLUDED.refusal_ci_upper,
                hedge_ci_lower = EXCLUDED.hedge_ci_lower, hedge_ci_upper = EXCLUDED.hedge_ci_upper,
                measured_at = EXCLUDED.measured_at, measured_on = EXCLUDED.measured_on, updated_at = EXCLUDED.updated_at`)
            .run(offer.providerKey, offer.modelKey, offer.offerId, PROMPT_SET_VERSION, PROMPTS.length, attempts, refusals, hedges,
                refusal ? String(refusal.rate) : null, hedge ? String(hedge.rate) : null,
                refusal ? String(refusal.lower) : null, refusal ? String(refusal.upper) : null,
                hedge ? String(hedge.lower) : null, hedge ? String(hedge.upper) : null, at, day(), at);
        return { refusal, hedge };
    }

    async function due() {
        const lastAt = await state.lastRunAt();
        if (lastAt === null) return true;
        return clock.now() - lastAt >= Number(settings.intervalMs);
    }

    /** One run. The budget check is not bypassed by `force`: force only skips the due check. */
    async function runOnce({ force = false } = {}) {
        if (running) return { skipped: 'running' };
        running = true;
        const report = { kind: 'chat.willing', prompt_set: PROMPT_SET_VERSION, started_at: iso(), offers: 0, measured: 0, attempts: 0, refusals: 0, hedges: 0, unanswered: [], errors: [] };
        try {
            const p = await plan();
            if (!p.allowed) return { skipped: p.reason, plan: p };
            if (!force && !await due()) return { skipped: 'not due' };
            if (!await state.claim({ ttlMs: Number(settings.claimTtlMs), who })) return { skipped: 'claimed' };
            try {
                const list = await offers();
                for (const offer of list) {
                    report.offers++;
                    const name = `${offer.providerKey}/${offer.modelKey}`;
                    let result;
                    try {
                        result = measure ? await measure({ ...offer, probes: PROMPTS }) : await measureOffer({ offer, probes: PROMPTS });
                    } catch (err) {
                        report.errors.push({ offer: name, error: String((err && err.message) || err).slice(0, 200) });
                        continue;
                    }
                    if (!result || !result.attempts) { report.unanswered.push(name); continue; }
                    await store({ offer, attempts: result.attempts, refusals: result.refusals, hedges: result.hedges });
                    report.measured++;
                    report.attempts += result.attempts;
                    report.refusals += result.refusals;
                    report.hedges += result.hedges;
                }
            } finally { await state.release({ who }); }
            if (report.measured || !report.offers) await state.markRun();
        } catch (err) {
            report.error = (err && err.code) || 'error';
            log.warn('[willingness] the run stopped early: ' + report.error);
        } finally { running = false; }
        last = report;
        log.log(`[willingness] measured ${report.measured}/${report.offers} offers, ${report.refusals} refusals and ${report.hedges} hedges of ${report.attempts} answers`);
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

    return { runOnce, tick, due, start, stop, plan, offers, measureOffer, state, settings, get last() { return last; } };
}

module.exports = { createWillingnessJob, PROMPT_SET_VERSION, PROMPTS, WEEK_MS };
