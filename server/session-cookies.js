'use strict';

// Provider readers are deliberately a closed allowlist. Callers cannot supply a URL, method, host, path, or header.
const crypto = require('crypto');
const { guardedFetch } = require('./providers/guarded-fetch');
const READERS = Object.freeze({
    anthropic: Object.freeze([
        Object.freeze({ name: 'purchased', method: 'GET', host: 'console.anthropic.com', path: (s) => `/api/organizations/${encodeURIComponent(s.org_id)}/prepaid/credits`, header: (secret) => ({ Cookie: `sessionKey=${secret}` }), parse: (j) => Number(j.amount) / 100 }),
        Object.freeze({ name: 'current_spend', method: 'GET', host: 'console.anthropic.com', path: (s) => `/api/organizations/${encodeURIComponent(s.org_id)}/current_spend`, header: (secret) => ({ Cookie: `sessionKey=${secret}` }), parse: (j) => j }),
    ]),
    openai: Object.freeze([
        Object.freeze({ name: 'credit_grants', method: 'GET', host: 'api.openai.com', path: () => '/dashboard/billing/credit_grants', header: (secret) => ({ Authorization: `Bearer ${secret}` }), parse: (j) => ({ total_granted: j.total_granted, total_used: j.total_used, total_available: j.total_available, grants: Array.isArray(j.grants) ? j.grants : [] }) }),
    ]),
});

function createSessionCookies({ db, config, fetchImpl = guardedFetch, clock = { now: () => Date.now() }, notify = async () => {} }) {
    const key = () => {
        const hex = String(config.credentialsKey || '');
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('session credentials are unavailable');
        return Buffer.from(hex, 'hex');
    };
    const seal = (plain, aad) => {
        const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); c.setAAD(Buffer.from(aad));
        const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
        return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    };
    const open = (sealed, aad) => {
        const [v, iv, tag, body] = String(sealed).split(':');
        if (v !== 'v1') throw new Error('session credential unavailable');
        const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64')); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    };
    const aad = (r) => `${r.owner}|${r.subject}|${r.provider}|session_cookie`;
    const view = (r) => ({ id: String(r.id), kind: 'session_cookie', provider: r.provider, label: r.label, created: r.created_at, last_used: r.last_used_at || null, expires: r.expires_at || null, expired: Boolean(r.expired) });
    async function add(owner, subject, body = {}) {
        const provider = String(body.provider || '');
        if (!READERS[provider] || typeof body.cookie !== 'string' || body.cookie.length < 16 || body.cookie.length > 4096) throw new TypeError('provider and session cookie are required');
        const now = new Date(clock.now()).toISOString();
        const row = { owner, subject, provider };
        await db.prepare(`INSERT INTO session_credentials(owner,subject,provider,label,secret_enc,created_at,expires_at,settings_json,expired,notified_expired) VALUES(?,?,?,?,?,?,?,?,0,0)
            ON CONFLICT(owner,subject,provider) DO UPDATE SET label=excluded.label, secret_enc=excluded.secret_enc, created_at=excluded.created_at, last_used_at=NULL, expires_at=excluded.expires_at, settings_json=excluded.settings_json, expired=0, notified_expired=0`)
            .run(owner, subject, provider, String(body.label || `${provider} browser session`).slice(0, 80), seal(body.cookie, aad(row)), now, body.expires_at || null, JSON.stringify(provider === 'anthropic' ? { org_id: String(body.org_id || '').slice(0, 120) } : {}));
        return view({ ...row, label: String(body.label || `${provider} browser session`).slice(0, 80), created_at: now, expires_at: body.expires_at || null, expired: 0 });
    }
    async function list(owner, subject) { return (await db.prepare('SELECT * FROM session_credentials WHERE owner=? AND subject=? ORDER BY provider').all(owner, subject)).map(view); }
    async function remove(owner, subject, id) {
        if (!/^\d+$/.test(String(id))) return false;
        return (await db.prepare('DELETE FROM session_credentials WHERE owner=? AND subject=? AND id=?').run(owner, subject, id)).changes > 0;
    }
    async function balance(owner, subject, id = null) {
        const row = id == null ? await db.prepare('SELECT * FROM session_credentials WHERE owner=? AND subject=? ORDER BY provider LIMIT 1').get(owner, subject) : await db.prepare('SELECT * FROM session_credentials WHERE owner=? AND subject=? AND id=?').get(owner, subject, id);
        if (!row) return null;
        if (row.expires_at && Date.parse(row.expires_at) <= clock.now()) {
            await db.prepare('UPDATE session_credentials SET expired=1 WHERE id=?').run(row.id);
            return { credential: view({ ...row, expired: 1 }), source: 'estimate', at: new Date(clock.now()).toISOString(), values: {} };
        }
        const secret = open(row.secret_enc, aad(row)); const settings = JSON.parse(row.settings_json || '{}'); const values = {};
        try {
            for (const reader of READERS[row.provider] || []) {
                const url = new URL(reader.path(settings), `https://${reader.host}`);
                if (url.hostname !== reader.host || url.protocol !== 'https:' || !reader.path(settings).startsWith('/') || reader.method !== 'GET') throw new Error('reader allowlist rejected request');
                const response = await fetchImpl(url, { method: 'GET', headers: reader.header(secret), redirect: 'error', signal: AbortSignal.timeout(10000) });
                if (response.status === 401 || response.status === 403) {
                    await db.prepare('UPDATE session_credentials SET expired=1,notified_expired=1 WHERE id=?').run(row.id);
                    if (!row.notified_expired) await notify({ owner, subject, provider: row.provider });
                    return { credential: view({ ...row, expired: 1 }), source: 'estimate', at: new Date(clock.now()).toISOString(), values: {} };
                }
                if (!response.ok) continue;
                values[reader.name] = reader.parse(await response.json());
            }
            await db.prepare('UPDATE session_credentials SET last_used_at=?,expired=0 WHERE id=?').run(new Date(clock.now()).toISOString(), row.id);
            return { credential: view(row), source: 'provider console', at: new Date(clock.now()).toISOString(), values };
        } catch {
            // Provider secrets and upstream response text are intentionally not propagated.
            return { credential: view(row), source: 'estimate', at: new Date(clock.now()).toISOString(), values: {} };
        }
    }
    return { add, list, remove, balance };
}

module.exports = { createSessionCookies, READERS };
