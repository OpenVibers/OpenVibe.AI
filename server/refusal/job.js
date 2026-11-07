'use strict';
/**
 * The measured refusal rates: the weekly job that asks every offer the same published questions and
 * publishes how often the offer refused them.
 *
 * The rules it lives by:
 *
 *   - The questions are fixed and published (server/refusal/prompts.js): harmless ones, no person's
 *     data, and the same set for every offer. A rate measured with another set is a different number,
 *     so the set's version is written next to every rate.
 *   - A refusal is a refusal the house can name: the published phrase list decides it, not a feeling.
 *   - A rate nobody measured stays unknown. An offer the job could not ask is left with its old rate,
 *     and a rate of zero attempts is never written as zero.
 *   - The rate is stored with the day it was measured, so the catalog can show how fresh it is.
 *
 * The job is due-based rather than timer-based: the last finished run is a row in the database
 * (server/refusal/state.js), because AI is deployed several times a day and a timer in the process
 * would be reset every time. The service ticks once an hour and measures only when the interval has
 * passed. Several workers run this service, so a run is claimed before it starts: only one of them
 * measures the offers at a time, and the claim expires on its own if a worker dies.
 *
 * The measurement is the network's own traffic on a fixed, small set: it is not a customer's request,
 * so no Balance hold is made for it (the pool's payer guard does not apply to the network's own probes).
 */
const os = require('os');
const { PROBES, PROMPT_SET_VERSION, PROBE_SYSTEM, isRefusal } = require('./prompts');
const { rateOf } = require('./rate');
const { createRefusalState } = require('./state');
const { textsOfAnswer } = require('../policy/floor');
const upstream = require('../providers/upstream');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function createRefusalJob({ db, registry, pool, config = {}, env = process.env, clock = { now: () => Date.now() }, log = console, measure = null }) {
    const settings = {
        enabled: true,
        intervalMs: WEEK_MS,
        tickMs: HOUR_MS,
        firstTickMs: 5 * 60 * 1000,
        claimTtlMs: 15 * 60 * 1000,
        // How many of the published probes one offer is asked. The set is fixed; the number asked is
        // recorded as the attempts, so a rate always says how much it was based on.
        probesPerOffer: 4,
        maxOffers: 500,
        ...(config.refusal || {}),
    };
    const state = createRefusalState({ db, clock });
    // Who this instance is: the claim says which one holds the run.
    const who = `${os.hostname()}:${process.pid}`;
    let running = false;
    let timer = null;
    let first = null;
    let last = null;

    const iso = () => new Date(clock.now()).toISOString();
    const day = () => iso().slice(0, 10);

    /**
     * The offers to measure: the registry's live chat models, on providers that can actually answer and
     * that the network may sell. A person's own key (CUSTOMER_BYOK) and a restricted provider are not
     * offers, so they are not measured.
     */
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
            });
            if (out.length >= Math.max(1, Number(settings.maxOffers) || 1)) break;
        }
        return out;
    }

    /** Ask one probe of one offer, and return the answer's text (null when the provider did not answer). */
    async function ask({ providerKey, modelKey, probe }) {
        const req = { system: [{ text: PROBE_SYSTEM }], messages: [{ role: 'user', content: probe.prompt }], maxTokens: 256, temperature: 0 };
        const route = { key: 'refusal', primary: { provider: providerKey, model: modelKey }, fallbacks: [] };
        const out = await pool.execute(route, 'chat', req, {
            // Only this offer may answer: the measurement is about this offer and no other.
            exact: { id: `${providerKey}/${modelKey}`, offers: [{ provider: providerKey, model: modelKey }] },
            // The network's own probe: nobody's Balance pays for it, so the payer guard does not apply.
            creditsRequired: false,
            contentPolicy: 'standard',
            runId: `refusal:${providerKey}/${modelKey}`,
        });
        return textsOfAnswer(out && out.result).join('\n');
    }

    /**
     * Measure one offer: ask the probes, count the refusals. A probe the provider never answered is not
     * an attempt and not a refusal: an offer that failed to answer is unknown, not compliant.
     */
    async function measureOffer({ providerKey, modelKey, probes }) {
        let refusals = 0;
        let attempts = 0;
        for (const probe of probes) {
            let answer = null;
            try {
                answer = await ask({ providerKey, modelKey, probe });
            } catch (err) {
                answer = null;
            }
            if (answer === null) continue;
            attempts++;
            if (isRefusal(answer)) refusals++;
        }
        return { refusals, attempts };
    }

    /** Write the rate with the day it was measured; null when nothing was asked (the old rate stands). */
    async function store({ providerKey, modelKey, offerId, refusals, attempts }) {
        const rate = rateOf(refusals, attempts);
        if (rate === null) return null;
        await db.prepare(`INSERT INTO refusal_rates (provider_key, model_key, offer_id, refusals, attempts, refusal_rate, prompt_set, measured_at, measured_on, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (provider_key, model_key) DO UPDATE SET offer_id = EXCLUDED.offer_id, refusals = EXCLUDED.refusals,
                attempts = EXCLUDED.attempts, refusal_rate = EXCLUDED.refusal_rate, prompt_set = EXCLUDED.prompt_set,
                measured_at = EXCLUDED.measured_at, measured_on = EXCLUDED.measured_on, updated_at = EXCLUDED.updated_at`)
            .run(providerKey, modelKey, offerId, refusals, attempts, String(rate), PROMPT_SET_VERSION, iso(), day(), iso());
        return rate;
    }

    /**
     * Is the job due? A run that finished less than an interval ago is not: the service is deployed
     * several times a day, and the week must not restart with every restart.
     */
    async function due() {
        const last = await state.lastRunAt();
        if (last === null) return true;                       // the job has never run: it is due at once
        return clock.now() - last >= Number(settings.intervalMs);
    }

    /** One run of the job: measure every offer, record the rate and the day. */
    async function runOnce({ force = false } = {}) {
        if (running) return { skipped: 'running' };
        if (!force && settings.enabled === false) return { skipped: 'disabled' };
        running = true;
        const report = {
            checked_at: day(),
            started_at: iso(),
            prompt_set: PROMPT_SET_VERSION,
            offers: 0,
            measured: 0,
            refusals: 0,
            attempts: 0,
            unanswered: [],
            errors: [],
        };
        try {
            // Only one worker measures the offers at a time (the service runs several).
            if (!await state.claim({ ttlMs: Number(settings.claimTtlMs), who })) return { skipped: 'claimed' };
            try {
                const list = await offers();
                const probes = PROBES.slice(0, Math.max(1, Math.min(PROBES.length, Number(settings.probesPerOffer) || PROBES.length)));
                for (const offer of list) {
                    report.offers++;
                    const name = `${offer.providerKey}/${offer.modelKey}`;
                    let res = null;
                    try {
                        res = measure ? await measure({ ...offer, probes }) : await measureOffer({ ...offer, probes });
                    } catch (err) {
                        report.errors.push({ offer: name, error: String((err && err.message) || err).slice(0, 200) });
                        continue;
                    }
                    if (!res || !res.attempts) {
                        // Nothing was answered: the offer keeps the rate it had, and says so.
                        report.unanswered.push(name);
                        continue;
                    }
                    const rate = await store({ ...offer, refusals: res.refusals, attempts: res.attempts });
                    if (rate !== null) {
                        report.measured++;
                        report.refusals += res.refusals;
                        report.attempts += res.attempts;
                    }
                }
            } finally {
                // The claim goes back whatever happened, so the next worker may run.
                await state.release({ who });
            }
            // The run is over: the next one is due when the interval has passed. A run that measured
            // nothing did not check anything, so the job stays due and the next tick tries again.
            if (report.measured || !report.offers) await state.markRun();
        } catch (err) {
            report.error = err && err.code ? err.code : 'error';
            log.warn('[refusal] the run stopped early: ' + report.error);
        } finally {
            running = false;
        }
        last = report;
        log.log(`[refusal] measured ${report.measured}/${report.offers} offers, ${report.refusals} refusals of ${report.attempts} probes${report.unanswered.length ? `; unanswered: ${report.unanswered.length}` : ''}`);
        return report;
    }

    /**
     * One tick: run the job when it is due. The due check reads the last finished run from the
     * database, so a restart in the middle of the week does not run it again, and a restart after it does.
     */
    async function tick() {
        if (running) return { skipped: 'running' };
        if (settings.enabled === false) return { skipped: 'disabled' };
        if (!await due()) return { skipped: 'not due' };
        return await runOnce();
    }

    /**
     * The service ticks once an hour and measures only when the interval has passed. The first tick
     * after a boot is a few minutes in, so the boot path stays free and a restart does not restart the week.
     */
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

    return { runOnce, tick, due, start, stop, offers, measureOffer, state, settings, get last() { return last; } };
}

module.exports = { createRefusalJob, PROMPT_SET_VERSION, PROBES, WEEK_MS };
