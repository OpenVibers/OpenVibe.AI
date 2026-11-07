'use strict';
/**
 * Team sharing of a memory store (Memory M5), through openvibe-sdk/share.
 *
 * The store belongs to one person and lives in AI (server/memory). Its share row is one per person: service `ai`,
 * kind `memory-store`, id the owner's `usr_…`. The library owns the model and the rules (the four audiences, the
 * members, requests, transfers, the append-only log and the delivery queue); this file is the wiring AI supplies:
 *
 *   network.json     Network's identity lookups (`identity.subject.resolve`), so a sheet names @people and resolves
 *                    an exact name to a subject. It also fetches the projections the sheet shows.
 *   events.publish   AI's Events producer (`events.event.publish`), so the five share.* envelopes go out. A failure
 *                    leaves the delivery queued and retried; the ACL change itself is already committed.
 *   notify           Network's notification push (`network.notifications.push`). A refusal is logged, never fatal.
 *
 * The share sheet asks `/api/v1/memory-store/:id/share` (the uniform route). The first owner read registers the
 * store as private; a member sees the sheet in their role. A person not on a `people` list never reaches the notes:
 * the routes in server/memory check canView before they return one item, and the page on Codes draws the gate.
 *
 * Nothing here reads a note. Titles and notification words are fixed, and no envelope carries text.
 */
const { createShares } = require('openvibe-sdk/share');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { serviceAuth } = require('openvibe-contracts');
const { bearer } = require('../auth');

const SERVICE = 'ai';
const KIND = 'memory-store';
const AUDIENCES = ['public', 'link', 'people', 'private'];
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const refOf = (owner) => ({ service: SERVICE, kind: KIND, id: String(owner) });

/** Everyone a share call may see: a user subject, never a service or a body-supplied subject. */
function viewerOf(subject) {
    if (!SUBJECT_RE.test(String(subject))) return null;
    return { subject: { type: 'user', id: String(subject) }, staff: false };
}

function createMemorySharing({ db, config, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console }) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const eventsUrl = String((config.events && config.events.url) || '').replace(/\/+$/, '');
    const clientId = (config.console && config.console.clientId) || env.OV_OAUTH_CLIENT_ID || 'ai';
    const clientSecret = env.OV_OAUTH_CLIENT_SECRET || '';
    if (!base || !eventsUrl || !clientSecret) return null;

    const networkTokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId, clientSecret,
        audience: 'openvibe.network', scope: 'identity.subject.resolve network.notifications.push', fetch: fetchImpl,
    });
    const eventTokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId, clientSecret,
        audience: 'openvibe.events', scope: 'events.event.publish', fetch: fetchImpl,
    });

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await networkTokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification. It never carries a note, a title or a scope. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A memory store was shared with you', 'Open it on OpenVibe.Codes, on Memory.'],
            'share.access_requested': ['Someone asked for access to your memory', 'Review the request on OpenVibe.Codes, on Memory.'],
            'share.transfer.requested': ['Someone wants to give you a memory store', 'Accept or decline it on OpenVibe.Codes.'],
            'share.transfer.answered': ['A memory store transfer was answered', 'See what happened on OpenVibe.Codes.'],
        }[n.kind] || ['Sharing on OpenVibe.Codes', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1], service: 'codes',
                    url: `${String(config.codesUrl || 'https://codes.openvibe.services').replace(/\/+$/, '')}/memory`, category: 'social',
                },
            });
        } catch (err) {
            log.warn('[memory-sharing] notification not sent:', err && err.message);
        }
    }

    /** One share.* envelope, with AI's own Events token. A failure leaves the delivery queued for the next flush. */
    async function publish(envelope) {
        const res = await fetchImpl(eventsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await eventTokens.authHeaders()) },
            body: JSON.stringify(envelope),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`Events answered ${res.status}`);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
        now: () => clock.now(),
    });

    /** The person from a verified Network token, or null. A service or an app token is never a viewer here. */
    async function authenticate(req) {
        const token = bearer(req);
        if (!token) return null;
        try {
            const claims = await verifyUserToken(token, {
                ...(config.networkPublicKey ? { publicKey: config.networkPublicKey } : { jwks: config.networkJwksUrl }),
                issuer: config.issuer,
                audience: ['openvibe.network', 'openvibe.ai'],
                now: clock.now(),
                log,
            });
            const subject = SUBJECT_RE.test(String(claims.subject_id || '')) ? claims.subject_id : (SUBJECT_RE.test(String(claims.sub || '')) ? claims.sub : '');
            return viewerOf(subject);
        } catch {
            return null;
        }
    }

    /** The store is private until its owner says otherwise. Repeating it is a no-op, never a change. */
    async function register(owner) {
        if (!SUBJECT_RE.test(String(owner))) return null;
        return await shares.register(refOf(owner), { owner_subject: { type: 'user', id: String(owner) }, audience: 'private' });
    }

    async function canView(viewer, owner) {
        if (!viewer || !SUBJECT_RE.test(String(owner))) return false;
        try { return await shares.canView(viewer, refOf(owner)); } catch { return false; }
    }

    /** Every memory store shared with the person, newest service order. Ids and access only. */
    async function sharedStores(viewer) {
        if (!viewer) return [];
        const out = [];
        let cursor = null;
        for (let page = 0; page < 5; page++) {
            const result = await shares.sharedWithMe(viewer, { service: SERVICE, limit: 50, ...(cursor ? { cursor } : {}) });
            for (const item of result.items || []) {
                if (!item.ref || item.ref.kind !== KIND) continue;
                const owner = item.owner_subject && item.owner_subject.id;
                if (!SUBJECT_RE.test(String(owner || ''))) continue;
                out.push({ owner, audience: item.audience, role: item.role, shared_at: item.shared_at, ...(item.transfer ? { transfer: item.transfer } : {}) });
            }
            cursor = result.next_cursor;
            if (!cursor) break;
        }
        return out;
    }

    const describe = async (ref) => {
        if (ref.service !== SERVICE || ref.kind !== KIND) return {};
        return { title: 'Memory store', link: '/memory', roles: ['viewer'], audiences: AUDIENCES, transferable: false };
    };

    const inner = shares.router({ service: SERVICE, authenticate, describe });

    /**
     * The uniform router, plus the lazy registration of an owner's store: the first GET (or PUT) of a person's own
     * `/api/v1/memory-store/<their id>/share` creates the private row. The router still authenticates and decides.
     */
    function router() {
        return async function memoryShareRouter(req, res, next) {
            const m = /^\/api\/v1\/memory-store\/([^/]+)\/share(?:\/|$)/.exec(String(req.url || ''));
            if (m && (req.method === 'GET' || req.method === 'PUT')) {
                try {
                    const viewer = await authenticate(req);
                    const id = decodeURIComponent(m[1]);
                    if (viewer && viewer.subject.id === id) await register(id);
                } catch { /* the router answers the request itself */ }
            }
            return inner(req, res, next);
        };
    }

    let timer = null;
    /** Expire members/transfers and send queued events, at most once a minute. Tests can call work() directly. */
    function start(intervalMs = 60000) {
        if (timer) return;
        timer = setInterval(() => { work().catch((err) => log.warn('[memory-sharing] sweep:', err && err.message)); }, Math.max(10000, Number(intervalMs) || 60000));
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    async function work({ flush = true } = {}) {
        let expired = 0;
        try { expired = await shares.expireMembers(); } catch (err) { log.warn('[memory-sharing] expiry sweep:', err && err.message); }
        let sent = 0;
        if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[memory-sharing] deliveries:', err && err.message); } }
        return { expired, sent };
    }

    return { shares, SERVICE, KIND, AUDIENCES, refOf, viewerOf, authenticate, register, canView, sharedStores, router, describe, work, start, stop };
}

module.exports = { createMemorySharing, refOf, viewerOf, SERVICE, KIND, AUDIENCES, SUBJECT_RE };
