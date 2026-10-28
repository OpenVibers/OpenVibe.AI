'use strict';
/**
 * Person sessions for the run receipt page (GET /runs/:id): a random 256-bit cookie id, stored as its
 * SHA-256; like the console's sessions, the cookie itself is never written down. A person session is
 * read-only and only opens runs whose on_behalf_of is its subject; it grants no capability and never
 * opens the operator console.
 *
 *   cookie  `__Host-ovai_person` (plain `ovai_person` over http in development): host-only, Path=/,
 *           HttpOnly, SameSite=Lax, Secure when BASE_URL is https, Max-Age = AI_PERSON_SESSION_TTL_MIN.
 */
const crypto = require('crypto');
const { iso } = require('./util');
const { parseCookies } = require('./console/session');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function createPersonSessions({ db, config, clock = { now: () => Date.now() } }) {
    const cc = config.console;
    const now = () => clock.now();
    const cookieSecure = Boolean(cc.cookieSecure);
    const sessionCookie = cookieSecure ? '__Host-ovai_person' : 'ovai_person';
    const ttlMs = Math.max(5, Number(cc.personSessionTtlMin) || 24 * 60) * 60 * 1000;

    function appendCookie(res, value) {
        const prev = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : [value]);
    }
    function cookieHeader(value, maxAgeSec) {
        const parts = [`${sessionCookie}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
        if (cookieSecure) parts.push('Secure');
        parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
        return parts.join('; ');
    }

    async function create(res, { subject, username }) {
        const t = now();
        await db.prepare('DELETE FROM person_sessions WHERE expires_at < ?').run(iso(t - 24 * 3600 * 1000));
        const id = random(32);
        await db.prepare(`INSERT INTO person_sessions (id_hash, subject, username, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)`).run(sha256(id), subject, username || null, iso(t), iso(t + ttlMs));
        appendCookie(res, cookieHeader(id, ttlMs / 1000));
        return id;
    }

    /** The live person session of this request, or null (unknown, expired or revoked). */
    async function read(req) {
        const id = parseCookies(req)[sessionCookie];
        if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
        const row = await db.prepare('SELECT * FROM person_sessions WHERE id_hash = ?').get(sha256(id));
        if (!row || row.revoked_at || Date.parse(row.expires_at) <= now()) return null;
        return { subject: row.subject, username: row.username, session: row };
    }

    function clear(res) {
        appendCookie(res, cookieHeader('', 0));
    }

    return { create, read, clear, sessionCookie, ttlMs };
}

module.exports = { createPersonSessions, sha256, random };
