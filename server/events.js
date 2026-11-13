'use strict';
/**
 * AI → OpenVibe.Events: ai.run.queued | cached | succeeded | failed (openvibe-contracts payloads
 * ai.run.*@1), so products and the operator console learn a run's outcome without polling.
 *
 * Each event is written to AI's own outbox in the SAME transaction as the run's state change (the SDK
 * outbox refuses anything else) and a relay publishes it with AI's service token (audience
 * openvibe.events, capability events.event.publish). Events down: rows wait and are retried; a run
 * never waits on Events. Payloads carry ids, the workflow, the requester, usage and counts, never
 * the input, the output or a prompt. Every ai.run.* event is internal (runs are private).
 *
 * Off unless EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set (EVENTS_PUBLISH=off disables it).
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

let svc = null;     // openvibe-sdk/events createServiceOutbox (event_outbox) while publishing is on
let dbRef = null;   // the handle a run change commits through (its afterCommit kicks the relay)
let pruneTimer = null;
let queued = 0;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

/** Starts the relay and returns the PostgreSQL outbox under it (null while publishing is off). */
function init(db, { eventsUrl = process.env.EVENTS_URL, clientSecret = process.env.OV_OAUTH_CLIENT_SECRET, clientId = process.env.OV_OAUTH_CLIENT_ID || 'ai',
    networkUrl = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000', fetchImpl, intervalMs, log = console } = {}) {
    if (svc) return svc.outbox;
    dbRef = db;
    if (process.env.EVENTS_PUBLISH === 'off' || !eventsUrl || !clientSecret) return null;
    // The PostgreSQL outbox (ADR-035): emit joins the change's own transaction.
    svc = createServiceOutbox({
        db, source: 'ai', eventsUrl: String(eventsUrl).replace(/\/+$/, ''), networkInternalUrl: networkUrl, clientId, clientSecret,
        intervalMs: intervalMs || 2000, fetch: fetchImpl, log,
    });
    svc.start();
    pruneTimer = setInterval(() => { if (svc) svc.outbox.prune().catch((err) => log.warn('[Events] outbox prune failed:', err && err.message)); }, PRUNE_EVERY_MS);
    if (pruneTimer.unref) pruneTimer.unref();
    log.log(`[Events] ai → ${eventsUrl} (${svc.outbox.pending()} pending)`);
    return svc.outbox;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** A runs row → the ai.run.<status>@1 payload. */
function payloadOf(row) {
    const status = row.status;
    const failed = status === 'failed';
    const done = status === 'succeeded' || status === 'failed' || status === 'cached';
    return {
        run_id: row.id,
        status,
        workflow: { key: row.workflow_key, version: Number(row.workflow_version) },
        requester: { type: row.requester_type, id: row.requester_id },
        on_behalf_of: parse(row.on_behalf_of),
        target: parse(row.target),
        attribution: parse(row.attribution),
        provider: status === 'succeeded' ? row.provider_key || null : null,
        model: status === 'succeeded' || status === 'cached' ? row.model_key || null : null,
        fallback_used: Boolean(row.fallback_used),
        synthetic: Boolean(row.synthetic),
        cached_from: status === 'cached' ? row.cached_from || null : null,
        usage: { tokens_in: Number(row.tokens_in) || 0, tokens_out: Number(row.tokens_out) || 0, cost_usd: Number(row.cost_usd) || 0, attempts: Number(row.attempts) || 0 },
        error: failed ? { code: row.error_code || 'run.internal', detail: String(row.error_detail || '').slice(0, 500) } : null,
        citations_count: Number(row.citations_count) || 0,
        retry_of: row.retry_of || null,
        created_at: iso(row.created_at),
        finished_at: done ? iso(row.finished_at || row.created_at) : null,
    };
}

/**
 * Queue the event for a run's new status. MUST be awaited inside the transaction that changed it; a no-op
 * while publishing is off, and for states without an event (running, cancelled).
 */
async function runChanged(row) {
    if (!svc || !row || !['queued', 'cached', 'succeeded', 'failed'].includes(row.status)) return null;
    const requester = { type: row.requester_type, id: row.requester_id };
    const env = await svc.emitIn(dbRef, {
        event_type: `ai.run.${row.status}`,
        actor: requester.type === 'user' || requester.type === 'service' ? requester : { type: 'service', id: 'ai' },
        subject: { type: 'run', id: row.id },
        visibility: 'internal',
        priority: row.status === 'failed' ? 'important' : 'low',
        payload: payloadOf(row),
    });
    queued++;
    // Relay once the change (and its event) committed.
    dbRef.afterCommit(() => svc && svc.kick());
    return env;
}

/**
 * L36 Y8: a provider refused one of a person's own keys (401/403) during a run. The key's status is already
 * `failing` (server/credentials.js markFailed); this tells the products that may show it. The payload never carries
 * the key, only a redacted reason. No-op while publishing is off, like every other event.
 */
async function credentialFailed({ subject, provider, error, owner = null }) {
    if (!svc || !dbRef || !subject || !provider) return null;
    const env = await svc.emitIn(dbRef, {
        event_type: 'ai.credential.failed',
        actor: { type: 'service', id: 'ai' },
        on_behalf_of: { type: 'user', id: subject },
        subject: { type: 'credential', id: `${subject}:${provider}` },
        visibility: 'internal',
        priority: 'important',
        payload: { subject, provider, status: 'failing', checked_at: iso(Date.now()), error: String(error || 'the provider refused the key').slice(0, 500) },
    });
    dbRef.afterCommit(() => svc && svc.kick());
    return env;
}

/**
 * Queue the ledger's record of one AI call (ai.call.recorded@1). MUST be awaited inside the transaction that
 * wrote the record, so the event and the row commit together. The payload carries the tokens, the money and the
 * ids: never a prompt, never an answer.
 */
function callPayload(rec) {
    return {
        subject: rec.subject || null, attribution: rec.attribution || '', surface: rec.surface || '', system: rec.system,
        provider: rec.provider || null, model: rec.model || null, effort: rec.effort || null,
        paid_by: rec.paid_by, paid_by_detail: rec.paid_by_detail || null,
        input: rec.tokens_input, output: rec.tokens_output, reasoning: rec.tokens_reasoning,
        cache_read: rec.tokens_cache_read, cache_write: rec.tokens_cache_write, cache_write_ttl: rec.cache_write_ttl || null,
        images: rec.images, audio_seconds: rec.audio_seconds, video_seconds: rec.video_seconds,
        list_cost_usd: rec.list_cost_usd, charged_usd: rec.charged_usd, fee_usd: rec.fee_usd, cache_saved_usd: rec.cache_saved_usd,
        price_source: rec.price_source, price_date: rec.price_date || null,
        latency_ms: rec.latency_ms, ttft_ms: rec.ttft_ms, attempts: rec.attempts, outcome: rec.outcome,
        run_id: rec.run_id || null, turn_id: rec.turn_id || null, at: rec.at,
        // ai.call.recorded@1 1.1.0 (ai-metrics.md): what, how fast, for which task, where and what went wrong.
        operation: rec.operation || null, streamed: rec.streamed == null ? null : Boolean(rec.streamed),
        tps: rec.tps == null ? null : Number(rec.tps), queue_ms: rec.queue_ms == null ? null : Number(rec.queue_ms),
        task: rec.task || null, task_id: rec.task_id || null, task_ms: rec.task_ms == null ? null : Number(rec.task_ms),
        harness: rec.harness || null, place: rec.place || null, error_class: rec.error_class || null,
        fallbacks: rec.fallbacks == null ? null : Number(rec.fallbacks),
        cache_hit: rec.cache_hit == null ? null : Boolean(rec.cache_hit),
        tool_calls: rec.tool_calls == null ? null : Number(rec.tool_calls), region: rec.region || null,
    };
}

/**
 * Queue the record of one AI call (ai.call.recorded@1). MUST be awaited inside a transaction, like every other
 * event here: a no-op while publishing is off.
 */
async function callRecorded(rec) {
    if (!svc || !rec) return null;
    const payload = callPayload(rec);
    const env = await svc.emitIn(dbRef, {
        event_type: 'ai.call.recorded',
        actor: { type: 'service', id: 'ai' },
        subject: rec.run_id ? { type: 'run', id: rec.run_id } : { type: 'user', id: rec.subject || 'anonymous' },
        visibility: 'internal',
        priority: 'low',
        payload,
    });
    queued++;
    dbRef.afterCommit(() => svc && svc.kick());
    return env;
}


/**
 * ai.deep_dive.updated@1: a deep dive's step changed or it ended (server/deep-dive/). One low-priority event per
 * step transition and at the end, so OpenVibe.Exchange's page can follow a run and OpenVibe.Design can attach a
 * finished report without polling. The payload carries ids, the step, the progress and the status; never the
 * question's answer, a capture or a prompt. No-op while publishing is off.
 */
async function deepDiveUpdated({ runId, deepDiveId, status, step, progress, steps, depth, requester, on_behalf_of, url, error = null }) {
    if (!svc || !dbRef || !runId) return null;
    const payload = {
        deep_dive_id: String(deepDiveId || runId), run_id: String(runId),
        status: status === 'queued' ? 'queued' : ['running', 'choosing', 'succeeded', 'failed', 'cancelled'].includes(status) ? status : 'running',
        step: step === 'done' ? 'done' : (['plan', 'search', 'choose', 'capture', 'analyse', 'synthesise', 'report'].includes(step) ? step : null),
        progress: Math.max(0, Math.min(1, Number(progress) || 0)),
        steps: (steps || []).slice(0, 7).map((s) => ({ key: s.key, status: s.status })),
        depth: ['quick', 'thorough', 'expert'].includes(depth) ? depth : 'quick',
        requester: requester && requester.type && requester.id ? { type: requester.type, id: String(requester.id) } : { type: 'service', id: 'ai' },
        on_behalf_of: on_behalf_of && on_behalf_of.type && on_behalf_of.id ? { type: on_behalf_of.type, id: String(on_behalf_of.id) } : null,
        url: String(url || `https://openvibe.exchange/deep-dive/${runId}`),
        error: error && error.code ? { code: String(error.code).slice(0, 80), detail: String(error.detail || '').slice(0, 500) } : null,
        occurred_at: new Date().toISOString(),
    };
    const env = await svc.emit({ event_type: 'ai.deep_dive.updated', actor: { type: 'service', id: 'ai' }, subject: { type: 'run', id: payload.run_id }, visibility: 'internal', priority: status === 'failed' ? 'important' : 'low', payload });
    queued++;
    dbRef.afterCommit(() => svc && svc.kick());
    return env;
}

async function videoAnalysisUpdated({ runId, analysisId, status, step, progress, steps, depth, requester, on_behalf_of, url, error = null }) {
    if (!svc || !dbRef || !runId) return null;
    const payload = {
        video_analysis_id: String(analysisId || runId), run_id: String(runId),
        status: ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status) ? status : 'running',
        step: step === 'done' ? 'done' : (['probe', 'keyframes', 'transcript', 'describe', 'analyse', 'explicit', 'report'].includes(step) ? step : null),
        progress: Math.max(0, Math.min(1, Number(progress) || 0)),
        steps: (steps || []).slice(0, 7).map((s) => ({ key: s.key, status: s.status })),
        depth: ['quick', 'standard', 'deep'].includes(depth) ? depth : 'standard',
        requester: requester && requester.type && requester.id ? { type: requester.type, id: String(requester.id) } : { type: 'service', id: 'ai' },
        on_behalf_of: on_behalf_of && on_behalf_of.type && on_behalf_of.id ? { type: on_behalf_of.type, id: String(on_behalf_of.id) } : null,
        url: String(url || 'https://openvibe.exchange/video-analysis/' + runId),
        error: error && error.code ? { code: String(error.code).slice(0, 80), detail: String(error.detail || '').slice(0, 500) } : null,
        occurred_at: new Date().toISOString(),
    };
    const env = await svc.emit({ event_type: 'ai.video_analysis.updated', actor: { type: 'service', id: 'ai' }, subject: { type: 'run', id: payload.run_id }, visibility: 'internal', priority: status === 'failed' ? 'important' : 'low', payload });
    queued++;
    dbRef.afterCommit(() => svc && svc.kick());
    return env;
}

async function status() {
    if (!svc) return { enabled: false };
    const s = await svc.status();
    return { enabled: true, pending: s.pending, rejected: s.rejected, queued_since_boot: queued, last_error: s.last_error };
}
/**
 * Graceful stop (start().close(), after runs.drain()): the relay stops and nothing more is queued; resolves
 * when the send in progress has finished. Unsent rows stay in the outbox for the next start.
 */
async function stop() {
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = null;
    const o = svc;
    svc = null;
    if (o) await o.stop();
}
function _reset() { if (svc) svc.stop(); svc = null; queued = 0; }

module.exports = { init, runChanged, credentialFailed, callRecorded, deepDiveUpdated, videoAnalysisUpdated, callPayload, payloadOf, status, stop, _reset };


