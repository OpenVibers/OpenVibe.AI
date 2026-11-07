'use strict';
/**
 * Exchange webhooks (design EXCHANGE-REMAKE-2026-11-06, "For builders", item 7).
 *
 * A developer registers an https receiver with their Network developer key (or a person's own token) on the public
 * Exchange API. AI then sends three events: usage (an answered request), earnings (a community offer earned credits
 * or kudos) and offer.down (an endpoint offer was removed). Every delivery carries
 * X-OpenVibe-Signature-V2: t=<unix seconds>, v2=<hex HMAC-SHA256 of "<t>.<raw body>"> -- exactly the header
 * openvibe-sdk/exchange's verifyWebhook checks, in constant time, with a 300-second timestamp window. The event id,
 * the type and the delivery id ride beside it so a receiver can deduplicate and log.
 *
 * A delivery is a row, not a call in the request that caused it: the run/offer write commits first, the receiver is
 * called after, and a failure is retried with an exponential backoff. The receiver sees the delivery log
 * (GET /api/v1/exchange/webhooks/:id/deliveries), with every attempt, status and error.
 *
 * The receiver URL is judged by the egress guard the community endpoint flow uses: https only, a public DNS answer
 * judged inside the connection (no rebinding), never an IP literal or a private name, port 443 or 8443, no query or
 * fragment. A redirect is never followed: a webhook receiver must answer where it was registered.
 */
const crypto = require('node:crypto');
const net = require('node:net');
const https = require('node:https');
const egress = require('openvibe-shared/egress');
const { ids } = require('openvibe-contracts');
const { AiError, parseJson, sha256 } = require('../util');

const EVENTS = Object.freeze(['usage', 'earnings', 'offer.down']);
const EVENT_SET = new Set(EVENTS);
const OWNER_RE = /^(?:usr|prj)_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENDPOINT_ID = /^whk_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_URL = 2048;
const ALLOWED_PORTS = new Set(['', '443', '8443']);

const iso = (ms) => new Date(ms).toISOString();
const nowSec = (ms) => Math.floor(ms / 1000);
const cut = (s, n) => String(s == null ? '' : s).slice(0, n);

/**
 * The one URL rule for a receiver. Returns a URL, or throws AiError 422 `exchange.webhook_url`; the message never
 * echoes the host. The DNS answer is judged again inside every connection (createSafeLookup), so a name that later
 * resolves private is refused at delivery too.
 */
function judgeUrl(raw) {
    let u;
    try { u = new URL(String(raw == null ? '' : raw)); } catch { throw new AiError(422, 'exchange.webhook_url', 'url must be an https URL'); }
    if (u.protocol !== 'https:') throw new AiError(422, 'exchange.webhook_url', 'url must be https');
    if (u.username || u.password) throw new AiError(422, 'exchange.webhook_url', 'credentials in url are not allowed');
    if (u.search || u.hash) throw new AiError(422, 'exchange.webhook_url', 'url carries no query or fragment');
    if (!ALLOWED_PORTS.has(u.port)) throw new AiError(422, 'exchange.webhook_url', 'url must use port 443 or 8443');
    const host = egress.normalizeHost(u.hostname);
    // Node never calls the lookup hook for an IP literal, so the literal is the check.
    if (net.isIP(host)) throw new AiError(422, 'exchange.webhook_url', 'url must name a host, not an IP address');
    if (egress.isInternalName(host)) throw new AiError(422, 'exchange.webhook_url', 'url must be a public host name');
    if (String(raw).length > MAX_URL) throw new AiError(422, 'exchange.webhook_url', `url is at most ${MAX_URL} characters`);
    u.hostname = host;
    return u;
}

/** A subscription as its owner sees it; the secret only on the create answer. */
function viewOf(row, { secret = false } = {}) {
    if (!row) return null;
    const out = {
        id: row.id, url: row.url, events: Array.isArray(row.events) ? row.events : parseJson(row.events, []),
        description: row.description || null, created_at: row.created_at, updated_at: row.updated_at,
    };
    if (secret) out.secret = row.secret;
    return out;
}

function deliveryView(row) {
    return {
        id: row.id, event_id: row.event_id, event_type: row.event_type, status: row.status,
        attempts: Number(row.attempts) || 0, last_status: row.last_status == null ? null : Number(row.last_status),
        last_error: row.last_error || null, last_attempt_at: row.last_attempt_at || null,
        next_attempt_at: row.next_attempt_at || null, delivered_at: row.delivered_at || null,
        created_at: row.created_at, payload: parseJson(row.payload, null),
    };
}

/** The retry pause after attempt n (1-based): base, 2x, 4x … up to maxDelayMs. */
function delayAfter(attempt, { baseDelayMs, maxDelayMs }) {
    const raw = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.max(baseDelayMs, Math.min(maxDelayMs, Math.round(raw)));
}

function createWebhooks({ db, config = null, clock = { now: () => Date.now() }, log = console, transport = null, lookup = null }) {
    const cfg = (config && config.webhooks) || {};
    const enabled = Boolean(db) && cfg.enabled !== false;
    const timeoutMs = Math.max(1000, Math.min(120000, Number(cfg.timeoutMs) || 10000));
    const maxBytes = Math.max(4096, Math.min(1024 * 1024, Number(cfg.maxBytes) || 65536));
    const maxAttempts = Math.max(1, Math.min(12, Number(cfg.maxAttempts) || 6));
    const maxPerOwner = Math.max(1, Math.min(50, Number(cfg.maxPerOwner) || 10));
    const backoff = {
        baseDelayMs: Math.max(100, Number(cfg.baseDelayMs) || 10000),
        maxDelayMs: Math.max(1000, Number(cfg.maxDelayMs) || 3600000),
    };
    const tickMs = Math.max(250, Number(cfg.tickMs) || 1000);
    const safeLookup = egress.createSafeLookup({ ...(lookup ? { lookup } : {}) });

    let timer = null;
    let working = false;

    const endpointRows = () => db.prepare('SELECT * FROM exchange_webhook_endpoints ORDER BY created_at DESC');

    async function list(owner) {
        if (!OWNER_RE.test(String(owner))) throw new AiError(422, 'exchange.webhook_owner', 'owner must be a usr_ or prj_ subject');
        return (await endpointRows().all()).filter((r) => r.owner_subject === owner).map((r) => viewOf(r));
    }

    async function create({ owner, input }) {
        if (!OWNER_RE.test(String(owner))) throw new AiError(422, 'exchange.webhook_owner', 'owner must be a usr_ or prj_ subject');
        const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        for (const k of Object.keys(b)) {
            if (!['url', 'events', 'description'].includes(k)) throw new AiError(422, 'exchange.webhook_invalid', `unknown field ${k}`);
        }
        const url = judgeUrl(b.url).toString();
        let events = EVENTS.slice();
        if (b.events != null) {
            if (!Array.isArray(b.events) || !b.events.length) throw new AiError(422, 'exchange.webhook_invalid', 'events must be a non-empty array');
            events = [...new Set(b.events.map((e) => String(e)))];
            if (events.some((e) => !EVENT_SET.has(e))) throw new AiError(422, 'exchange.webhook_invalid', `events must be among ${EVENTS.join(', ')}`);
        }
        const description = b.description == null ? null : cut(String(b.description).trim(), 200) || null;
        const existing = (await endpointRows().all()).filter((r) => r.owner_subject === owner);
        if (existing.length >= maxPerOwner) throw new AiError(409, 'exchange.webhook_limit', `at most ${maxPerOwner} webhook receivers per account`);
        const at = iso(clock.now());
        const row = {
            id: `whk_${ids.ulid()}`, owner, url, events, description,
            secret: `whsec_${crypto.randomBytes(32).toString('base64url')}`, created_at: at, updated_at: at,
        };
        await db.prepare(`INSERT INTO exchange_webhook_endpoints (id, owner_subject, url, secret, events, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, row.owner, row.url, row.secret, row.events, row.description, row.at || at, at);
        // The secret is shown once, in this answer: a later read never carries it.
        return viewOf({ ...row, created_at: at, updated_at: at }, { secret: true });
    }

    async function remove({ id, owner }) {
        if (!ENDPOINT_ID.test(String(id)) || !OWNER_RE.test(String(owner))) {
            throw new AiError(404, 'exchange.webhook_not_found', `no webhook ${id}`);
        }
        const row = await db.prepare('SELECT id FROM exchange_webhook_endpoints WHERE id = ? AND owner_subject = ?').get(String(id), String(owner));
        if (!row) throw new AiError(404, 'exchange.webhook_not_found', `no webhook ${id}`);
        await db.prepare('DELETE FROM exchange_webhook_endpoints WHERE id = ?').run(String(id));
        return { id: String(id), removed: true };
    }

    /** The delivery log of one receiver, newest first. The payload is what was sent; no secret is ever here. */
    async function deliveries({ id, owner, limit = 50 } = {}) {
        if (!ENDPOINT_ID.test(String(id)) || !OWNER_RE.test(String(owner))) {
            throw new AiError(404, 'exchange.webhook_not_found', `no webhook ${id}`);
        }
        const row = await db.prepare('SELECT id FROM exchange_webhook_endpoints WHERE id = ? AND owner_subject = ?').get(String(id), String(owner));
        if (!row) throw new AiError(404, 'exchange.webhook_not_found', `no webhook ${id}`);
        const n = Math.max(1, Math.min(200, Number(limit) || 50));
        const rows = await db.prepare('SELECT * FROM exchange_webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?').all(String(id), n);
        return rows.map(deliveryView);
    }

    /** One response, without following anything: the transport seam is the tests'. */
    function once(target, { body, headers }) {
        const send = { method: 'POST', url: target.toString(), headers, body, lookup: safeLookup, timeoutMs, maxBytes };
        if (transport) return transport(send);
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (err) => { if (settled) return; settled = true; try { req.destroy(); } catch { /* */ } reject(err); };
            const ok = (value) => { if (settled) return; settled = true; resolve(value); };
            const req = https.request(target, { method: 'POST', headers, lookup: safeLookup, timeout: timeoutMs, agent: false }, (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400) { res.resume(); return ok({ status, headers: res.headers, body: '' }); }
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); return fail(new AiError(413, 'exchange.webhook_too_large', `the receiver answered more than ${maxBytes} bytes`)); }
                let bytes = 0;
                const chunks = [];
                res.on('data', (c) => {
                    bytes += c.length;
                    if (bytes > maxBytes) { res.destroy(); return fail(new AiError(413, 'exchange.webhook_too_large', `the receiver answered more than ${maxBytes} bytes`)); }
                    chunks.push(c);
                });
                res.on('error', (err) => fail(err));
                res.on('end', () => ok({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('error', (err) => fail(err));
            req.on('timeout', () => fail(new AiError(504, 'exchange.webhook_timeout', `the receiver did not answer within ${timeoutMs}ms`)));
            const guard = setTimeout(() => fail(new AiError(504, 'exchange.webhook_timeout', `the receiver did not answer within ${timeoutMs}ms`)), timeoutMs);
            req.on('close', () => clearTimeout(guard));
            req.end(body);
        });
    }

    /** A signed delivery of one row, retried or closed. Never throws into the caller. */
    async function attempt(row) {
        const at = iso(clock.now());
        const attemptNo = (Number(row.attempts) || 0) + 1;
        let outcome = { status: null, error: null };
        let headers = null;
        try {
            const target = judgeUrl(row.url);
            const payload = Buffer.isBuffer(row.payload) ? row.payload.toString('utf8') : String(row.payload);
            const t = nowSec(clock.now());
            const signature = crypto.createHmac('sha256', String(row.secret)).update(`${t}.`).update(payload).digest('hex');
            headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'OpenVibe.Exchange/1.0 (+https://openvibe.exchange)',
                'X-OpenVibe-Signature-V2': `t=${t},v2=${signature}`,
                'X-OpenVibe-Event': String(row.event_type),
                'X-OpenVibe-Delivery': String(row.id),
                'X-OpenVibe-Webhook-Id': String(row.endpoint_id),
            };
            const res = await once(target, { body: payload, headers });
            const status = Number(res && res.status) || 0;
            outcome = { status, error: null };
            if (status >= 200 && status < 300) {
                await db.prepare(`UPDATE exchange_webhook_deliveries SET status = 'delivered', attempts = ?, last_attempt_at = ?, delivered_at = ?,
                    next_attempt_at = NULL, last_status = ?, last_error = NULL WHERE id = ?`).run(attemptNo, at, at, status, row.id);
                return { delivered: true, attempts: attemptNo, status };
            }
            outcome.error = `the receiver answered HTTP ${status}`;
        } catch (err) {
            outcome = { status: null, error: String((err && err.message) || err) };
        }
        const retry = attemptNo < maxAttempts
            && (outcome.status == null || [408, 425, 429, 500, 502, 503, 504].includes(outcome.status))
            && !(outcome.status >= 300 && outcome.status < 400);
        if (retry) {
            const next = iso(clock.now() + delayAfter(attemptNo, backoff));
            await db.prepare(`UPDATE exchange_webhook_deliveries SET status = 'pending', attempts = ?, last_attempt_at = ?, next_attempt_at = ?,
                last_status = ?, last_error = ? WHERE id = ?`).run(attemptNo, at, next, outcome.status, cut(outcome.error, 500), row.id);
            return { delivered: false, attempts: attemptNo, status: outcome.status, next_attempt_at: next, error: outcome.error };
        }
        await db.prepare(`UPDATE exchange_webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_attempt_at = NULL,
            last_status = ?, last_error = ? WHERE id = ?`).run(attemptNo, at, outcome.status, cut(outcome.error, 500), row.id);
        return { delivered: false, attempts: attemptNo, status: outcome.status, error: outcome.error };
    }

    /**
     * Deliver every due row once. A row is claimed by pushing next_attempt_at a lease ahead, an atomic UPDATE, so
     * several workers of this service never send the same delivery twice; a worker that dies leaves the lease to
     * expire, and the next tick tries again.
     */
    async function deliverDue({ limit = 25 } = {}) {
        if (!enabled) return { sent: 0, delivered: 0, failed: 0 };
        const due = iso(clock.now());
        const lease = iso(clock.now() + Math.max(30000, timeoutMs + 30000));
        const rows = await db.prepare(`SELECT d.*, e.url, e.secret FROM exchange_webhook_deliveries d
            JOIN exchange_webhook_endpoints e ON e.id = d.endpoint_id
            WHERE d.status = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
            ORDER BY d.next_attempt_at NULLS FIRST, d.created_at LIMIT ?`).all(due, Math.max(1, Math.min(100, Number(limit) || 25)));
        let sent = 0;
        let delivered = 0;
        let failed = 0;
        for (const row of rows) {
            const claimed = await db.prepare(`UPDATE exchange_webhook_deliveries SET next_attempt_at = ?
                WHERE id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`).run(lease, row.id, due);
            if (!claimed || !claimed.changes) continue;
            sent++;
            const out = await attempt(row);
            if (out.delivered) delivered++;
            else if (out.next_attempt_at == null) failed++;
        }
        return { sent, delivered, failed };
    }

    /** Wake the worker after a write; a no-op before start() and inside tests that call deliverDue themselves. */
    function kick() {
        if (!timer || working) return;
        setImmediate(async () => {
            if (working) return;
            working = true;
            try { await deliverDue(); } catch (err) { log.warn(`[webhooks] delivery failed: ${err && err.message}`); }
            finally { working = false; }
        });
    }

    /**
     * Queue one event for every matching receiver of an owner. The payload is the exact JSON string that will be
     * signed and sent, stored once per delivery. Never throws: a webhook is a notification, never a reason for the
     * write that caused it to fail.
     */
    async function emit({ owner, type, data, source = null, dedupe = true }) {
        if (!enabled || !OWNER_RE.test(String(owner)) || !EVENT_SET.has(String(type))) return 0;
        let rows;
        try {
            rows = await db.prepare('SELECT * FROM exchange_webhook_endpoints WHERE owner_subject = ? AND ? = ANY(events)').all(String(owner), String(type));
        } catch (err) {
            log.warn(`[webhooks] ${type} receivers for ${owner}: ${err && err.message}`);
            return 0;
        }
        if (!rows.length) return 0;
        const at = iso(clock.now());
        const eventId = dedupe && source
            ? `evt_${sha256(`${type}|${source}|${owner}`).slice(0, 26)}`
            : `evt_${ids.ulid()}`;
        const payload = JSON.stringify({ id: eventId, type, created_at: at, data: data || {} });
        let queued = 0;
        for (const row of rows) {
            try {
                await db.prepare(`INSERT INTO exchange_webhook_deliveries (id, endpoint_id, owner_subject, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
                    .run(`whd_${ids.ulid()}`, row.id, owner, eventId, String(type), payload, at, at);
                queued++;
            } catch (err) {
                log.warn(`[webhooks] ${type} delivery for ${owner}: ${err && err.message}`);
            }
        }
        kick();
        return queued;
    }

    /**
     * The usage event of an answered run, and the earnings event when a community offer served it. The owner is the
     * run's own requester (a person or a project); a community earnings event also reaches the project that
     * registered the endpoint. The prompt and the answer are never in either payload.
     */
    async function usage({ row, record, outcome = 'succeeded' } = {}) {
        if (!enabled || !row || !record) return 0;
        const owner = row.requester_type === 'project' ? row.requester_id : (record.subject || null);
        let queued = 0;
        if (owner) {
            queued += await emit({
                owner, type: 'usage', source: row.id,
                data: {
                    run_id: row.id, outcome,
                    provider: record.provider || null, model: record.model || null,
                    tokens: {
                        input: Number(record.tokens_input) || 0, output: Number(record.tokens_output) || 0,
                        reasoning: Number(record.tokens_reasoning) || 0,
                        cache_read: Number(record.tokens_cache_read) || 0, cache_write: Number(record.tokens_cache_write) || 0,
                    },
                    cost_usd: {
                        list: Number(record.list_cost_usd) || 0, charged: Number(record.charged_usd) || 0,
                        fee: Number(record.fee_usd) || 0, cache_saved: Number(record.cache_saved_usd) || 0,
                    },
                    paid_by: record.paid_by || null, latency_ms: record.latency_ms == null ? null : Number(record.latency_ms),
                    ttft_ms: record.ttft_ms == null ? null : Number(record.ttft_ms), at: record.at || iso(clock.now()),
                },
            });
        }
        const explain = parseJson(row.explain, null);
        const c = explain && explain.community;
        if (outcome === 'succeeded' && c && c.owner && (Number(c.credits_micro) > 0 || Number(c.kudos) > 0)) {
            const data = {
                offer_id: c.offer_id || null, kind: c.kind || 'machine', model: c.model || null, run_id: row.id,
                tokens: { input: Number(c.tokens_in) || 0, output: Number(c.tokens_out) || 0 },
                credits_micro: Number(c.credits_micro) || 0, earning_status: c.earning_status || null,
                self_served: Boolean(c.self_served), kudos: Number(c.kudos) || 0, at: record.at || iso(clock.now()),
            };
            queued += await emit({ owner: c.owner, type: 'earnings', source: `${row.id}|${c.owner}`, data });
            if (c.project_id && c.project_id !== c.owner) {
                queued += await emit({ owner: c.project_id, type: 'earnings', source: `${row.id}|${c.project_id}`, data });
            }
        }
        return queued;
    }

    /** An endpoint offer is gone: tell its owner (and the developer project that registered it), once. */
    async function offerDown({ owner, projectId = null, offer = null, reason = 'removed by the seller' } = {}) {
        if (!enabled || !owner) return 0;
        const data = {
            offer_id: (offer && offer.offer_id) || null, kind: 'endpoint',
            models: (offer && Array.isArray(offer.models)) ? offer.models : [], reason, at: iso(clock.now()),
        };
        let queued = await emit({ owner, type: 'offer.down', source: `offer|${(offer && offer.id) || 'unknown'}`, data });
        if (projectId && projectId !== owner) {
            queued += await emit({ owner: projectId, type: 'offer.down', source: `offer|${(offer && offer.id) || 'unknown'}`, data });
        }
        return queued;
    }

    /** Start the retry worker (off in tests, which call deliverDue with their own clock). */
    function start() {
        if (!enabled || timer) return;
        timer = setInterval(async () => {
            if (working) return;
            working = true;
            try { await deliverDue(); } catch (err) { log.warn(`[webhooks] delivery failed: ${err && err.message}`); }
            finally { working = false; }
        }, tickMs);
        if (timer.unref) timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { enabled, EVENTS, list, create, remove, deliveries, emit, usage, offerDown, deliverDue, start, stop, _test: { judgeUrl, delayAfter } };
}

module.exports = { createWebhooks, judgeUrl, EVENTS };
