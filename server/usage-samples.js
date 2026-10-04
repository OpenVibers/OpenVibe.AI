'use strict';
/**
 * AI → OpenVibe.Billing: one platform.usage-sample@1 reading per accounted run, posted to
 * billing.usage.record (POST /api/v1/usage, audience openvibe.billing) through a retry-safe outbox.
 *
 * quota.js account() writes the reading in the SAME transaction as usage_daily. A cache hit writes its
 * zero reading in the transaction that records the run. The relay (openvibe-sdk createPgOutbox) posts
 * each row with AI's service token. If Billing is down, has no grant yet, or is not deployed, the row
 * waits and is retried with backoff, across restarts. Only Billing refusing the reading itself (400, 409,
 * 413, 422) marks a row rejected. A reading carries ids, the workflow, the requester, tokens and cost. It
 * never carries the input, the output or a prompt. Readings are queued once init() ran, unless
 * USAGE_SAMPLES=off. The relay runs while OV_BILLING_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET are set.
 * Runs on a person's own key, and runs that called no provider and were not a cache hit, are not
 * accounted and have no reading. free_allowance_used (§2.1.8) is the share the provider free allowance covered; the
 * cost_estimate the caller passes already leaves that share out.
 */
const { createPgOutbox } = require('openvibe-sdk/events');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const contracts = require('openvibe-contracts');
const TABLE = 'usage_sample_outbox'; const METRIC = 'tokens'; const SCHEMA = 'platform.usage-sample@1';
const REFUSED = new Set([400, 409, 413, 422]); const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
let relay = null; let on = false; let pruneTimer = null; let lastError = null; let queued = 0;
function sampleOf({ runId, workflowKey, requester, provider = null, tokensIn = 0, tokensOut = 0, cost = 0, freeAllowanceUsed = 0, at, traceId = null }) {
  const key = `ai:${runId}:${METRIC}`;
  const s = { id: key, idempotency_key: key, service: 'ai', subject: requester, resource: runId, operation: workflowKey,
    quantity: Math.max(0, (Number(tokensIn) || 0) + (Number(tokensOut) || 0)), unit: 'tokens', at: new Date(at).toISOString(),
    cost_estimate: Math.max(0, Number(cost) || 0), source: 'ai.runs' };
  if (provider && provider !== 'mixed') s.provider = provider;
  // §2.1.8: the tokens the provider free allowance covered (server/free-allowance.js); absent when nothing was free.
  const free = Math.min(s.quantity, Math.max(0, Math.floor(Number(freeAllowanceUsed) || 0)));
  if (free > 0) s.free_allowance_used = free;
  if (traceId) s.trace_id = String(traceId);
  return s;
}
/** MUST be awaited inside the transaction that accounts the run; a second call for the same run changes nothing. */
async function record(db, fields) {
  if (!on) return null;
  const s = sampleOf(fields);
  const v = contracts.validate(SCHEMA, s);
  if (!v.valid) throw new Error(`usage sample for ${fields.runId} is not a valid ${SCHEMA}: ${JSON.stringify(v.errors)}`);
  const ins = await db.prepare(`INSERT INTO ${TABLE} (event_id, envelope, created_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING`).run(s.id, JSON.stringify(s), Date.now());
  await db.prepare('UPDATE runs SET usage_sample_id = ? WHERE id = ?').run(s.id, fields.runId);
  if (ins.changes) queued++;
  if (relay) db.afterCommit(() => relay && relay.kick());
  return s.id;
}
// createPgOutbox's `events` seam pointed at Billing: one reading per POST. isPermanent() reads err.status.
function billingSink({ billingUrl, tokens, audience, fetchImpl, timeoutMs = 5000 }) {
  return { prepare: (sample) => sample, async publish(sample) {
    const token = await tokens.getToken({ audience });
    const res = await fetchImpl(`${billingUrl}/api/v1/usage`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(sample), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { const err = new Error(`billing.usage.record answered ${res.status}`); err.status = REFUSED.has(res.status) ? 422 : 503; throw err; }   // 401/403 before the grant, 404 before Billing ships the route, 429, 5xx: retried
    return { event_id: sample.id, seq: null };
  } };
}
function init(db, { enabled = true, billingUrl = '', audience = 'openvibe.billing', capability = 'billing.usage.record', clientId = process.env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret = process.env.OV_OAUTH_CLIENT_SECRET, networkUrl = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000', fetchImpl = globalThis.fetch, intervalMs = 2000, log = console } = {}) {
  if (relay) return relay;
  on = Boolean(enabled);
  if (!on || !billingUrl || !clientSecret) return null;
  const tokens = createServiceTokenClient({ tokenUrl: `${String(networkUrl).replace(/\/+$/, '')}/oauth/token`, clientId, clientSecret, scope: { [audience]: capability }, fetch: fetchImpl });
  relay = createPgOutbox(db, { events: billingSink({ billingUrl: String(billingUrl).replace(/\/+$/, ''), tokens, audience, fetchImpl }), table: TABLE, batchSize: 1, intervalMs,
    onError: (err) => { const msg = err && err.message; if (msg !== lastError) log.warn(`[Billing] usage sample send failed (will retry): ${msg}`); lastError = msg; } });
  relay.start();
  pruneTimer = setInterval(() => { if (relay) relay.prune().catch((err) => log.warn('[Billing] usage outbox prune failed:', err && err.message)); }, PRUNE_EVERY_MS);
  if (pruneTimer.unref) pruneTimer.unref();
  log.log(`[Billing] ai usage samples → ${billingUrl}`);
  return relay;
}
async function status() { if (!relay) return { enabled: on, relay: false }; return { enabled: on, relay: true, pending: Number(await relay.pending()), rejected: Number(await relay.rejected()), queued_since_boot: queued, last_error: lastError }; }
/** Graceful stop (after runs.drain(), before db.close()): one last bounded pass sends what is due, then the relay stops; unsent rows wait for the next start. */
async function stop({ drainMs = 3000 } = {}) {
  if (pruneTimer) clearInterval(pruneTimer); pruneTimer = null;
  const r = relay; relay = null; on = false;
  if (r) { let timer; await Promise.race([r.flush().catch(() => {}), new Promise((res) => { timer = setTimeout(res, drainMs); if (timer.unref) timer.unref(); })]); clearTimeout(timer); await r.stop(); }
}
function _reset() { if (pruneTimer) clearInterval(pruneTimer); pruneTimer = null; if (relay) relay.stop(); relay = null; on = false; queued = 0; lastError = null; }
module.exports = { init, record, sampleOf, status, stop, _reset, TABLE };
