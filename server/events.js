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
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

let outbox = null;
const stats = { queued: 0, lastError: null };
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

function init(db, { eventsUrl = process.env.EVENTS_URL, clientSecret = process.env.OV_OAUTH_CLIENT_SECRET, clientId = process.env.OV_OAUTH_CLIENT_ID || 'ai',
    networkUrl = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000', fetchImpl, intervalMs, log = console } = {}) {
    if (outbox) return outbox;
    if (process.env.EVENTS_PUBLISH === 'off' || !eventsUrl || !clientSecret) return null;
    const tokens = createServiceTokenClient({ tokenUrl: `${String(networkUrl).replace(/\/+$/, '')}/oauth/token`, clientId, clientSecret, fetch: fetchImpl });
    const client = createClient({ baseUrls: { events: String(eventsUrl).replace(/\/+$/, '') }, tokenProvider: tokens, fetch: fetchImpl, retries: 0 });
    outbox = createOutbox(db, {
        events: createEventsClient(client, { source: 'ai' }),
        intervalMs: intervalMs || 2000,
        onError: (err) => { const m = err && err.message; if (m !== stats.lastError) log.warn('[Events] publish failed (will retry):', m); stats.lastError = m; },
    });
    outbox.ensureSchema();
    outbox.start();
    const prune = setInterval(() => { try { outbox.prune(); } catch { /* next time */ } }, PRUNE_EVERY_MS);
    if (prune.unref) prune.unref();
    log.log(`[Events] ai → ${eventsUrl} (${outbox.pending()} pending)`);
    return outbox;
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
 * Queue the event for a run's new status. MUST run inside the transaction that changed it; a no-op
 * while publishing is off, and for states without an event (running, cancelled).
 */
function runChanged(row) {
    if (!outbox || !row || !['queued', 'cached', 'succeeded', 'failed'].includes(row.status)) return null;
    const requester = { type: row.requester_type, id: row.requester_id };
    const env = outbox.enqueue({
        event_type: `ai.run.${row.status}`,
        actor: requester.type === 'user' || requester.type === 'service' ? requester : { type: 'service', id: 'ai' },
        subject: { type: 'run', id: row.id },
        visibility: 'internal',
        priority: row.status === 'failed' ? 'important' : 'low',
        payload: payloadOf(row),
    });
    stats.queued++;
    setImmediate(() => outbox && outbox.kick());
    return env;
}

function status() {
    if (!outbox) return { enabled: false };
    return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, last_error: stats.lastError };
}
function _reset() { if (outbox) outbox.stop(); outbox = null; stats.queued = 0; stats.lastError = null; }

module.exports = { init, runChanged, payloadOf, status, _reset };
