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

module.exports = { init, runChanged, payloadOf, status, stop, _reset };
