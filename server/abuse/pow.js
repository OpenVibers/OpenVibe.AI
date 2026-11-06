'use strict';
/**
 * Plan E5: an in-house hashcash challenge for the anonymous Try it (no account), never a third-party captcha.
 *
 *   issue(meta)    → { challenge, bits, expires_at }   a random challenge, stored as sha256(challenge) only
 *   verify(meta, token) → boolean                      one accepted solution, single use
 *
 * A solution is `sha256("<challenge>:<nonce>")` with `bits` leading zero bits. The client finds the nonce; on a
 * phone about 2^18 hashes is roughly a second, and the difficulty is AI_POW_BITS. The challenge carries no
 * address: the row keeps the keyed device and /24–/48 hashes the caller passed in, so an issued challenge can
 * be rate-limited and audited without storing who asked.
 */
const crypto = require('crypto');

const HEX = '0123456789abcdef';

/** Leading zero bits of a digest. */
function zeroBits(buffer) {
    let n = 0;
    for (const byte of buffer) {
        if (byte === 0) { n += 8; continue; }
        let b = byte;
        while ((b & 0x80) === 0) { n++; b = (b << 1) & 0xff; }
        return n;
    }
    return n;
}

function digest(challenge, nonce) {
    return crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
}

/** A nonce that solves the challenge, for tests, the docs and any server-side caller. */
function solve(challenge, bits) {
    for (let nonce = 0; ; nonce++) {
        if (zeroBits(digest(challenge, nonce)) >= bits) return String(nonce);
    }
}

function createPow({ db, clock = { now: () => Date.now() }, bits = 18, ttlMs = 300_000, log = console } = {}) {
    const ins = db.prepare(`INSERT INTO abuse_pow (challenge_hash, device_hash, prefix_hash, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`);
    const take = db.prepare(`UPDATE abuse_pow SET used_at = ?
        WHERE challenge_hash = ? AND used_at IS NULL AND expires_at > ?`);
    const get = db.prepare('SELECT * FROM abuse_pow WHERE challenge_hash = ?');
    const clean = db.prepare('DELETE FROM abuse_pow WHERE expires_at < ?');

    /** { challenge, bits, expires_at } and the challenge hash stored; never the raw challenge in the database. */
    async function issue({ deviceHash = null, prefixHash = null } = {}) {
        const challenge = crypto.randomBytes(16).toString('hex');
        const now = clock.now();
        const expires = now + Math.max(30_000, Math.min(3_600_000, Number(ttlMs) || 0));
        await ins.run(crypto.createHash('sha256').update(challenge).digest('hex'), deviceHash, prefixHash, new Date(now).toISOString(), new Date(expires).toISOString());
        // Housekeeping rides the issuance: an expired row is useless and would grow without bound.
        await clean.run(new Date(now - 86_400_000).toISOString()).catch(() => {});
        return { challenge, bits: Math.max(1, Math.min(28, Number(bits) || 18)), expires_at: new Date(expires).toISOString() };
    }

    /**
     * One accepted solution. `token` is `<challenge>:<nonce>` (the challenge is public; the nonce is the work).
     * The update is the single-use check: two requests racing one solution, only one UPDATE changes a row.
     */
    async function verify(token, { deviceHash = null } = {}) {
        const raw = String(token || '').trim();
        const at = raw.indexOf(':');
        if (at <= 0) return false;
        const challenge = raw.slice(0, at);
        const nonce = raw.slice(at + 1);
        if (!/^[0-9a-f]{16,128}$/i.test(challenge) || !/^[0-9]{1,20}$/.test(nonce)) return false;
        const hash = crypto.createHash('sha256').update(challenge).digest('hex');
        const row = await get.get(hash);
        if (!row || row.used_at) return false;
        const now = clock.now();
        if (Date.parse(row.expires_at) <= now) return false;
        if (!(zeroBits(digest(challenge, nonce)) >= Math.max(1, Number(bits) || 18))) return false;
        const changed = await take.run(new Date(now).toISOString(), hash, new Date(now).toISOString());
        if (!changed || !changed.changes) return false;
        // A solution issued for one device belongs to that device when both sides know one.
        if (row.device_hash && deviceHash && row.device_hash !== deviceHash) return false;
        return true;
    }

    return { issue, verify, bits: () => Math.max(1, Math.min(28, Number(bits) || 18)), zeroBits, solve };
}

module.exports = { createPow, zeroBits, solve, digest };
