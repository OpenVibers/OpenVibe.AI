'use strict';
/**
 * The one front door for AI calls made outside OpenVibe.AI (ai-metrics.md, Contracts 0.421.0).
 *
 *   POST /api/v1/usage/calls        ai.usage.report, up to 100 calls in ai.call-report@1
 *
 * Actor's own model calls, a Codes harness turn, a local model on a person's machine through Bot and every
 * other product send their calls here instead of writing their own ledger. AI stays the one owner of
 * ai.call.recorded@1: it validates the report, keeps the subject only when the token is a service acting for
 * that person, dedupes by system + run_id or turn_id, prices a call that brought no charged amount from its
 * own rate cards (charged first, then list; 'unknown' with zeros when there is no card) and publishes each
 * accepted call through server/events.js. The dedupe table keeps 30 days.
 */
const express = require('express');
const { validate } = require('openvibe-contracts');
const { AiError, sendError, iso } = require('../util');
const usageRecord = require('../usage-record');
const events = require('../events');
const { CAPS } = require('../auth');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

function usageCallsRouter({ db, pool, config, auth, clock = { now: () => Date.now() }, log = console }) {
    const r = express.Router();
    const report = auth.requireCap(CAPS.usageReport);

    /** The subject the caller may name: only the person named by a service's own on_behalf_of claim. */
    function allowedSubject(req, subject) {
        const principal = req.principal || {};
        if (!subject || !principal.onBehalfOf) return null;
        return String(subject) === String(principal.onBehalfOf) ? String(subject) : null;
    }

    /**
     * A call's money: what it brought wins; otherwise AI's rate cards price it (the same pricesOf/moneyOf a run
     * uses). No card means 'unknown' and zeros, never an invented price.
     */
    async function moneyFor(call) {
        const brought = {
            list_cost_usd: call.list_cost_usd == null ? 0 : call.list_cost_usd,
            charged_usd: call.charged_usd == null ? 0 : call.charged_usd,
            fee_usd: call.fee_usd == null ? 0 : call.fee_usd,
            cache_saved_usd: call.cache_saved_usd == null ? 0 : call.cache_saved_usd,
            price_source: call.price_source || '',
            price_date: call.price_date || null,
        };
        if (call.charged_usd != null) return brought;
        const cards = pool && call.provider ? await pool.rateCardsFor(call.provider, call.model || null) : null;
        if (!cards) return { ...brought, list_cost_usd: 0, charged_usd: 0, fee_usd: 0, cache_saved_usd: 0, price_source: 'unknown', price_date: null };
        const prices = usageRecord.pricesOf(cards);
        const money = usageRecord.moneyOf({
            prices,
            tokens: { input: call.input || 0, output: call.output || 0, cache_read: call.cache_read || 0, cache_write: call.cache_write || 0 },
            paidBy: call.paid_by || 'openvibe_key',
            feeRate: (config.usage && config.usage.feeRate) || 0,
        });
        return { ...money, price_source: 'catalog', price_date: prices.date };
    }

    /** One accepted report -> the record AI publishes, with every field ai.call.recorded@1 1.1.0 carries. */
    async function recordFor(req, call) {
        const money = await moneyFor(call);
        return usageRecord.recordOf({
            system: call.system,
            run_id: call.run_id || null, turn_id: call.turn_id || null,
            subject: allowedSubject(req, call.subject),
            attribution: call.attribution || '', surface: call.surface || '',
            provider: call.provider || null, model: call.model || null, effort: call.effort || null,
            paid_by: call.paid_by || 'openvibe_key', paid_by_detail: call.paid_by_detail || null,
            input: call.input || 0, output: call.output || 0, reasoning: call.reasoning || 0,
            cache_read: call.cache_read || 0, cache_write: call.cache_write || 0, cache_write_ttl: call.cache_write_ttl || null,
            images: call.images || 0, audio_seconds: call.audio_seconds || 0, video_seconds: call.video_seconds || 0,
            list_cost_usd: money.list_cost_usd, charged_usd: money.charged_usd, fee_usd: money.fee_usd, cache_saved_usd: money.cache_saved_usd,
            price_source: money.price_source, price_date: money.price_date,
            latency_ms: call.latency_ms == null ? null : call.latency_ms,
            ttft_ms: call.ttft_ms == null ? null : call.ttft_ms,
            attempts: call.attempts == null ? 0 : call.attempts, outcome: call.outcome, at: call.at,
            operation: call.operation || null, streamed: call.streamed == null ? null : call.streamed,
            tps: call.tps == null ? null : call.tps, queue_ms: call.queue_ms == null ? null : call.queue_ms,
            task: call.task || null, task_id: call.task_id || call.run_id || call.turn_id || null,
            task_ms: call.task_ms == null ? null : call.task_ms, harness: call.harness || null, place: call.place || null,
            error_class: call.error_class || null, fallbacks: call.fallbacks == null ? null : call.fallbacks,
            cache_hit: call.cache_hit == null ? (call.outcome === 'cached') : call.cache_hit,
            tool_calls: call.tool_calls == null ? null : call.tool_calls, region: call.region || null,
        });
    }

    r.post('/api/v1/usage/calls', report, async (req, res) => {
        try {
            const body = req.body || {};
            // Validate the whole report first. An error inside one call is that call's rejection (with its
            // index); an error outside the calls array (too many, a missing array, an unknown field) refuses
            // the report itself.
            const whole = validate('ai.call-report@1', body);
            if (!whole.valid) {
                const outside = whole.errors.find(e => !/^\/calls\/\d+/.test(String(e.path || '')));
                if (outside) throw new AiError(422, 'input.invalid', `body does not match ai.call-report@1: ${outside.path} ${outside.message}`, { errors: whole.errors });
            }
            const calls = body.calls;
            if (!Array.isArray(calls)) throw new AiError(422, 'input.invalid', 'body does not match ai.call-report@1: calls must be an array');

            // The dedupe rows are small and only needed for a sender's retries: keep them 30 days.
            await db.prepare('DELETE FROM ai_usage_reported_calls WHERE received_at < ?')
                .run(iso(clock.now() - KEEP_MS)).catch((err) => log.warn(`[usage] reported calls prune failed: ${err && err.message}`));

            let accepted = 0;
            let duplicates = 0;
            const rejected = [];
            for (const [index, call] of calls.entries()) {
                const one = validate('ai.call-report@1', { calls: [call] });
                if (!one.valid) {
                    rejected.push({ index, error: one.errors.map(e => `${e.path} ${e.message}`).join('; ') });
                    continue;
                }
                if (!call.run_id && !call.turn_id) {
                    rejected.push({ index, error: 'run_id or turn_id is required' });
                    continue;
                }
                // The key names the calling service too, so one product's ids can never block another's report.
                const caller = String((req.principal && req.principal.sub) || 'unknown');
                const key = `${caller}|${call.run_id ? `run:${call.run_id}` : `turn:${call.turn_id}`}`;
                const rec = await recordFor(req, call);
                let duplicate = false;
                await db.tx(async () => {
                    const inserted = await db.prepare(`INSERT INTO ai_usage_reported_calls (system, call_key, run_id, turn_id, received_at)
                        VALUES (?, ?, ?, ?, ?) ON CONFLICT (system, call_key) DO NOTHING`)
                        .run(String(call.system), key, call.run_id || null, call.turn_id || null, iso(clock.now()));
                    if (!Number(inserted.changes)) { duplicate = true; return; }
                    await events.callRecorded(rec);
                });
                if (duplicate) duplicates++;
                else accepted++;
            }
            // 202: the calls are recorded and each event is queued; the sender may forget them.
            res.status(202).json({ accepted, duplicates, rejected });
        } catch (err) { sendError(res, err, req.ov, log); }
    });

    return r;
}

module.exports = { usageCallsRouter };
