'use strict';
/**
 * One owner alert when a provider's account runs out of credit or its key is refused.
 *
 * This is the same Network notification path the rest of the platform uses
 * (POST /internal/notifications/push, network.notifications.push): the SDK resolves the owner's
 * Network user from `AI_OWNER_SUBJECT` and pushes one GENERIC notification. It is sent once per open
 * balance/auth circuit, never per request; the circuit row keeps notified_at so a restart does not
 * repeat it. Without the owner subject (or the service credentials) the alert is skipped, and the
 * console and the Prometheus gauges still show what happened.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createNotificationsClient } = require('openvibe-sdk/notifications');

function createOwnerNotifier({ config, env = process.env, fetchImpl = globalThis.fetch, log = console }) {
    const subject = config.ownerSubject;
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const clientSecret = String(env.OV_OAUTH_CLIENT_SECRET || '');
    const clientId = (config.console && config.console.clientId) || 'ai';
    if (!subject || !base || !clientSecret) {
        return async () => false;
    }

    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId, clientSecret,
        audience: 'openvibe.network', scope: 'identity.subject.resolve network.notifications.push', fetchImpl,
    });

    async function json({ path, method = 'GET', json: body, query } = {}) {
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        const out = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return out;
    }

    const notifications = createNotificationsClient({ json }, { baseUrl: base });

    return async function notifyOwner({ title, message, url }) {
        try {
            const out = await notifications.push({
                subjectId: subject, type: 'GENERIC', title, message,
                service: 'ai', url: url || `${String(config.exchangeUrl || 'https://openvibe.exchange').replace(/\/+$/, '')}/console/providers`,
                category: 'system',
            });
            return Boolean(out && out.sent);
        } catch (err) {
            log.warn(`[ai] owner alert not sent: ${String(err && err.message || err).slice(0, 200)}`);
            return false;
        }
    };
}

module.exports = { createOwnerNotifier };
