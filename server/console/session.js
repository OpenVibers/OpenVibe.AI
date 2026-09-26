'use strict';
/**
 * Operator console sessions, the sign-in flow cookie, CSRF tokens and client-address hashing (the
 * same scheme as OpenVibe.Billing's staff console).
 *
 *   session cookie  `__Host-ovai_staff` (plain `ovai_staff` when the console is served over http in
 *                   development): a random 256-bit id, host-only, Path=/, HttpOnly, Secure,
 *                   SameSite=Strict, Max-Age = the session TTL (absolute, AI_CONSOLE_SESSION_TTL_MIN,
 *                   60 min by default). The database keeps only its SHA-256.
 *   flow cookie     `ovai_flow`, Path=/auth, HttpOnly, Secure, SameSite=Lax, 10 minutes: the OAuth
 *                   state, the PKCE verifier and the page to return to, HMAC-signed with the session
 *                   secret. Lax because the callback is a top-level navigation back from
 *                   openvibe.network; the state and PKCE checks are what make it safe.
 *   CSRF            one random token per session, in every form, compared in constant time on every
 *                   POST, plus an Origin / Sec-Fetch-Site check (index.js csrfOk).
 */
const crypto = require('crypto');
const { iso, parseJson } = require('../util');

const FLOW_COOKIE = 'ovai_flow';
const FLOW_TTL_MS = 10 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function sameString(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i).trim();
        if (k in out) continue;
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: ignored */ }
    }
    return out;
}

function cookieHeader(name, value, { maxAgeSec, path = '/', sameSite = 'Strict', secure }) {
    const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
    if (secure) parts.push('Secure');
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
    return parts.join('; ');
}

function appendCookie(res, value) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : [value]);
}

function createSessions({ db, config, clock, secret }) {
    const cc = config.console;
    const now = () => clock.now();
    const sessionCookie = cc.cookieSecure ? '__Host-ovai_staff' : 'ovai_staff';
    const hmac = (s) => crypto.createHmac('sha256', secret).update(String(s)).digest('base64url');

    /** Keyed hash of the client address: comparable across rows, not reversible by enumerating IPv4. */
    const ipHash = (ip) => (ip ? crypto.createHmac('sha256', secret).update(`ip:${ip}`).digest('hex').slice(0, 32) : null);

    // ── Sign-in flow cookie ──────────────────────────────────
    function setFlow(res, flow) {
        const body = Buffer.from(JSON.stringify({ ...flow, e: now() + FLOW_TTL_MS })).toString('base64url');
        appendCookie(res, cookieHeader(FLOW_COOKIE, `${body}.${hmac(`flow:${body}`)}`, { maxAgeSec: FLOW_TTL_MS / 1000, path: '/auth', sameSite: 'Lax', secure: cc.cookieSecure }));
    }
    function takeFlow(req, res) {
        appendCookie(res, cookieHeader(FLOW_COOKIE, '', { maxAgeSec: 0, path: '/auth', sameSite: 'Lax', secure: cc.cookieSecure }));
        const raw = parseCookies(req)[FLOW_COOKIE];
        if (!raw) return null;
        const [body, sig] = raw.split('.');
        if (!body || !sig || !sameString(sig, hmac(`flow:${body}`))) return null;
        try {
            const flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            return flow && typeof flow.e === 'number' && flow.e > now() ? flow : null;
        } catch { return null; }
    }

    // ── Sessions ─────────────────────────────────────────────
    function create(res, { subject, username, staff, ip }) {
        const t = now();
        db.prepare('DELETE FROM console_sessions WHERE expires_at < ?').run(iso(t - 24 * 3600 * 1000));
        const id = random(32);
        const ttlMs = cc.sessionTtlMin * 60 * 1000;
        db.prepare(`INSERT INTO console_sessions (id_hash, subject, username, staff, csrf, created_at, expires_at, ip_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(id), subject, username || null, JSON.stringify(staff || {}), random(32), iso(t), iso(t + ttlMs), ipHash(ip));
        appendCookie(res, cookieHeader(sessionCookie, id, { maxAgeSec: ttlMs / 1000, secure: cc.cookieSecure }));
    }

    /** The live session of this request, or null (unknown, expired or revoked). */
    function read(req) {
        const id = parseCookies(req)[sessionCookie];
        if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
        const row = db.prepare('SELECT * FROM console_sessions WHERE id_hash = ?').get(sha256(id));
        if (!row || row.revoked_at || Date.parse(row.expires_at) <= now()) return null;
        return { ...row, staff: parseJson(row.staff, {}) };
    }

    function revoke(row) {
        if (row) db.prepare('UPDATE console_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(iso(now()), row.id_hash);
    }
    function clear(res) {
        appendCookie(res, cookieHeader(sessionCookie, '', { maxAgeSec: 0, secure: cc.cookieSecure }));
    }

    return { setFlow, takeFlow, create, read, revoke, clear, ipHash, sessionCookie };
}

module.exports = { createSessions, parseCookies, sameString, sha256, random, FLOW_COOKIE };
