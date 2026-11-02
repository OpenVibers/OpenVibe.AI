'use strict';
/**
 * OpenVibe.Events → AI for Bench's ratings. This is AI's consumer side (the ai.run.* outbox in
 * server/events.js is its producer side).
 *
 * At boot it ensures one subscription — topic `bench.rating.changed`, endpoint this service's loopback
 * `/internal/events` — with AI's own Events token (audience openvibe.events, scope
 * events.subscription.manage), so Network must grant client `ai` that scope on openvibe.events. Creation
 * is idempotent (Events answers 409 with the existing subscription) and retried in the background. The
 * endpoint verifies the v2 signature with AI_EVENTS_SECRET (comma-separated during rotation) and hands the
 * envelope to server/bench/evidence.js, whose inbox makes a redelivery a no-op.
 *
 * Off without EVENTS_URL/AI_EVENTS_URL and AI_EVENTS_SECRET; AI_EVENTS_SUBSCRIBE=0 creates no subscription
 * (an operator/script may do it), while the endpoint still verifies deliveries when the secret is set.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { serviceAuth } = require('openvibe-contracts');
const { parseDelivery } = require('openvibe-sdk/events');
const { TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

const TOPIC = 'bench.rating.changed';

function createBenchEvents({ bench, db = null, accountData = null, accountSend = null, config, log = console, fetchImpl = globalThis.fetch, clientSecret = process.env.OV_OAUTH_CLIENT_SECRET }) {
    const router = express.Router();
    const secrets = (config.events && config.events.secrets) || [];

    function refused(res, status, code, detail) {
        return http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    }

    /** Apply one verified envelope (also used by tests and an operator replay). */
    async function apply(event) {
        return await bench.applyEvent(event);
    }

    router.post('/internal/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        if (!secrets.length) return refused(res, 503, 'bench.consumer_disabled', 'AI_EVENTS_SECRET is not set');
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        let delivery = null;
        for (const secret of secrets) {
            delivery = parseDelivery(raw, req.headers, secret, { requireV2: true });
            if (delivery) break;
        }
        if (!delivery) return refused(res, 401, 'bench.bad_signature', 'the Events delivery signature does not verify');
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !event.event_id) {
            return refused(res, 400, 'bench.bad_delivery', 'body must be { event: <envelope> }');
        }
        if (accountData && ACCOUNT_TOPICS.includes(event.event_type)) {
            try {
                const outcome = await accountData.apply(event, { send: accountSend });
                return res.status(200).json({ event_id: event.event_id, outcome });
            } catch (err) {
                log.warn(`[account-data] event ${event.event_id} (${event.event_type}) failed: ${err.message}`);
                return refused(res, 503, 'ai.account_retry', 'not applied; Events will retry');
            }
        }
        try {
            const out = await apply(event);
            return res.status(200).json({ event_id: event.event_id, ...out });
        } catch (err) {
            log.error(`[bench] event ${event.event_id} (${event.event_type}) failed: ${err.message}`);
            return refused(res, 500, 'bench.event_failed', 'processing failed; it will be retried');
        }
    });

    /**
     * Ensure the subscription exists, idempotently and in the background. Returns a stop handle, or null
     * while the consumer is off. Nothing is created when AI_EVENTS_SUBSCRIBE=0 or no signing secret is set.
     */
    function startSubscriptions({ port, eventsUrl = config.events && config.events.url, networkUrl = config.networkInternalUrl, clientId = config.console && config.console.clientId } = {}) {
        if (!config.events || config.events.subscribe === false || !eventsUrl || !secrets.length || !clientSecret) return null;
        const base = String(eventsUrl).replace(/\/+$/, '');
        const endpoint = (config.events.endpoint || `http://127.0.0.1:${port}/internal/events`);
        const tokens = serviceAuth.createTokenClient({
            tokenUrl: `${networkUrl}/oauth/token`, clientId: clientId || 'ai', clientSecret,
            audience: 'openvibe.events', scope: 'events.subscription.manage', fetchImpl,
        });
        const call = async (method, path, body) => {
            const res = await fetchImpl(`${base}${path}`, {
                method,
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000),
            });
            const json = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, body: json };
        };
        const attempt = async () => {
            const listed = await call('GET', '/api/v1/subscriptions');
            if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
            const mine = (listed.body.subscriptions || []).filter((s) => s.endpoint === endpoint);
            if (mine.some((s) => s.topic_pattern === TOPIC)) return;
            const made = await call('POST', '/api/v1/subscriptions', { topic_pattern: TOPIC, endpoint, secret: secrets[0] });
            if (!made.ok && made.status !== 409) throw new Error(`subscribing to ${TOPIC}: ${made.status} ${made.body.code || ''}`);
            if (made.ok) log.log(`[bench] Events subscription created: ${made.body.id} (${TOPIC} → ${endpoint})`);
        };
        const delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
        let i = 0;
        let timer = null;
        let stopped = false;
        const run = () => {
            timer = null;
            if (stopped) return;
            attempt().catch((err) => {
                if (stopped) return;
                if (++i < delays.length) { timer = setTimeout(run, delays[i]); if (timer.unref) timer.unref(); }
                else log.warn(`[bench] Events subscription not created: ${err.message}`);
            });
        };
        timer = setTimeout(run, delays[0]);
        if (timer.unref) timer.unref();
        return {
            topic: TOPIC,
            endpoint,
            stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
        };
    }

    async function status() {
        return {
            enabled: Boolean(secrets.length),
            topic: TOPIC,
            evidence: await bench.list(null).catch(() => []),
        };
    }

    return { router, apply, startSubscriptions, status, TOPIC };
}

module.exports = { createBenchEvents, TOPIC };
