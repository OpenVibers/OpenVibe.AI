'use strict';
/**
 * The sealed keys of the memory services (Memory M5).
 *
 * A key is stored the way a BYO provider key already is in OpenVibe.AI (server/credentials.js): AES-256-GCM with
 * AI_CREDENTIALS_KEY, the envelope `v1:<iv>:<tag>:<body>`, and the additional data
 * `memory-service|<subject>|<provider>`, so a row moved to another person or provider does not decrypt. The plaintext
 * exists only while one sync runs. It is never returned by a route, written to a log, put in an error or an account
 * export; the person sees the last four characters (`key_hint`) and the service's health.
 */
const crypto = require('crypto');
const { AiError } = require('../../util');

const KEY_RE = /^[\x21-\x7e]{8,400}$/;          // printable, no spaces: an API key, not a passphrase
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const iso = (ms) => new Date(ms).toISOString();

/** Replace anything that looks like the key before a reason is stored or answered. */
function scrub(text, key) {
    let out = String(text == null ? '' : text);
    if (key) out = out.split(String(key)).join('[redacted]');
    return out.replace(/\b(sk|key|token|api[-_]?key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]').slice(0, 300);
}

function createServiceKeys({ db, config, clock = { now: () => Date.now() } }) {
    function secretKey() {
        const hex = String(config.credentialsKey || '');
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'memory.services_unavailable', 'memory services are not configured on this service (AI_CREDENTIALS_KEY)');
        return Buffer.from(hex, 'hex');
    }
    function aadFor(subject, provider) { return `memory-service|${subject}|${provider}`; }
    function seal(plain, aad) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
        c.setAAD(Buffer.from(aad));
        const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
        return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    }
    function open(sealed, aad) {
        const [v, iv, tag, body] = String(sealed).split(':');
        if (v !== 'v1') throw new Error('unknown memory-service key format');
        const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    }
    const hintOf = (key) => String(key).slice(-4);

    function view(row) {
        return {
            provider: row.provider,
            hint: row.key_hint,
            base_url: row.base_url || null,
            account: row.account || null,
            status: row.status || 'untested',
            checked_at: row.checked_at || null,
            last_error: row.last_error || null,
            last_sync_at: row.last_sync_at || null,
            last_sync_count: Number(row.last_sync_count) || 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    async function list(subject) {
        if (!SUBJECT_RE.test(String(subject))) return [];
        const rows = await db.many('SELECT * FROM memory_service_connections WHERE subject = $1 ORDER BY provider', [String(subject)]);
        return rows.map(view);
    }

    async function row(subject, provider) {
        return await db.maybe('SELECT * FROM memory_service_connections WHERE subject = $1 AND provider = $2', [String(subject), String(provider)]);
    }

    /** Store or replace a key. The key itself never comes back. */
    async function put(subject, provider, { key, base_url, account } = {}) {
        if (!SUBJECT_RE.test(String(subject))) throw new AiError(400, 'input.invalid', 'subject must be a usr_ subject');
        if (key != null && !KEY_RE.test(String(key))) throw new AiError(422, 'input.invalid', 'key must be 8-400 printable characters with no spaces');
        const at = iso(clock.now());
        const prev = await row(subject, provider);
        if (key == null && !prev) throw new AiError(400, 'memory.service_key_required', 'key is required the first time');
        const plain = key != null ? String(key) : open(prev.key_enc, aadFor(subject, provider));
        await db.exec(`INSERT INTO memory_service_connections (subject, provider, base_url, account, key_enc, key_hint, status, checked_at, last_error, last_sync_at, last_sync_count, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'untested', NULL, NULL, $7, $8, $9, $10)
                ON CONFLICT (subject, provider) DO UPDATE SET base_url = excluded.base_url, account = excluded.account,
                  key_enc = excluded.key_enc, key_hint = excluded.key_hint, status = 'untested', checked_at = NULL,
                  last_error = NULL, last_sync_at = excluded.last_sync_at, last_sync_count = excluded.last_sync_count,
                  updated_at = excluded.updated_at`,
            [String(subject), String(provider), base_url ? String(base_url).slice(0, 500) : null, account ? String(account).slice(0, 200) : null,
                seal(plain, aadFor(subject, provider)), hintOf(plain), prev ? prev.last_sync_at : null, prev ? prev.last_sync_count : 0,
                prev ? prev.created_at : at, at]);
        return view(await row(subject, provider));
    }

    async function remove(subject, provider) {
        const gone = await db.exec('DELETE FROM memory_service_connections WHERE subject = $1 AND provider = $2', [String(subject), String(provider)]);
        return Number(gone) > 0;
    }

    /** The row and its decrypted key, for one sync only. Never returned to a route. */
    async function openFor(subject, provider) {
        const r = await row(subject, provider);
        if (!r) throw new AiError(404, 'memory.service_not_found', 'that memory service is not connected');
        let key;
        try { key = open(r.key_enc, aadFor(subject, provider)); }
        catch { throw new AiError(500, 'memory.service_unreadable', 'the saved key for this service cannot be opened'); }
        return { row: r, key };
    }

    async function markProbe(subject, provider, { ok, error, count = 0 } = {}) {
        const at = iso(clock.now());
        await db.exec(`UPDATE memory_service_connections SET status = $1, checked_at = $2, last_error = $3, updated_at = $2
            WHERE subject = $4 AND provider = $5`, [ok ? 'ok' : 'failing', at, ok ? null : scrub(error).slice(0, 300), String(subject), String(provider)]);
        if (ok) await db.exec('UPDATE memory_service_connections SET last_sync_count = $1 WHERE subject = $2 AND provider = $3', [Number(count) || 0, String(subject), String(provider)]);
    }

    async function markSync(subject, provider, count) {
        const at = iso(clock.now());
        await db.exec(`UPDATE memory_service_connections SET last_sync_at = $1, last_sync_count = $2, status = 'ok', checked_at = $1,
            last_error = NULL, updated_at = $1 WHERE subject = $3 AND provider = $4`, [at, Number(count) || 0, String(subject), String(provider)]);
    }

    return { list, put, remove, openFor, markProbe, markSync, view, scrub, aadFor, seal, open };
}

module.exports = { createServiceKeys, scrub, KEY_RE, SUBJECT_RE };
