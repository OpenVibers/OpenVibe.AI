'use strict';
/**
 * Provider keys an owner adds from the operator console (migrations/0010_provider_secrets.sql). A provider whose
 * secret_ref is 'vault:<provider key>' (util.resolveSecret) reads its key from here.
 *
 * At rest each key is AES-256-GCM encrypted with AI_CREDENTIALS_KEY, bound to its provider key (the additional data).
 * The decrypted keys are held in this process only (load() at boot and after every change), because the provider pool
 * resolves secrets synchronously; nothing here logs, returns or audits a value — only a four-character hint.
 */
const crypto = require('crypto');
const { AiError } = require('./util');

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const keys = new Map();     // provider key → plaintext, this process only

function secretKey(config) {
    const hex = String((config && config.credentialsKey) || '');
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be stored here: AI_CREDENTIALS_KEY is not set');
    return Buffer.from(hex, 'hex');
}

function seal(config, plain, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', secretKey(config), iv);
    c.setAAD(Buffer.from(`provider:${aad}`));
    const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

function open(config, sealed, aad) {
    const [v, iv, tag, body] = String(sealed || '').split(':');
    if (v !== 'v1' || !iv || !tag || !body) throw new Error('not a sealed key');
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(config), Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(`provider:${aad}`));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

function createVault({ db, config, clock = { now: () => Date.now() }, log = console }) {
    /** Read every stored key into this process (a key that no longer decrypts is skipped and named in the log). */
    async function load() {
        const rows = await db.prepare('SELECT provider_key, sealed FROM provider_secrets').all();
        keys.clear();
        for (const r of rows) {
            try { keys.set(r.provider_key, open(config, r.sealed, r.provider_key)); } catch { log.warn(`[Vault] the key of provider ${r.provider_key} does not decrypt (was AI_CREDENTIALS_KEY changed?)`); }
        }
        return keys.size;
    }

    async function put(providerKey, plain, { actor = 'system' } = {}) {
        if (!KEY_RE.test(providerKey || '')) throw new AiError(422, 'ai.invalid', 'provider key must be lowercase dotted/dashed');
        const value = String(plain || '').trim();
        if (value.length < 8 || value.length > 4000 || /\s/.test(value)) throw new AiError(422, 'ai.invalid', 'that does not look like an API key');
        const sealed = seal(config, value, providerKey);
        const t = new Date(clock.now()).toISOString();
        await db.prepare(`INSERT INTO provider_secrets (provider_key, sealed, hint, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (provider_key) DO UPDATE SET sealed = excluded.sealed, hint = excluded.hint, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(providerKey, sealed, `…${value.slice(-4)}`, actor, t);
        keys.set(providerKey, value);
        return { provider_key: providerKey, hint: `…${value.slice(-4)}`, updated_at: t };
    }

    async function remove(providerKey) {
        await db.prepare('DELETE FROM provider_secrets WHERE provider_key = ?').run(providerKey);
        keys.delete(providerKey);
    }

    async function hints() {
        const rows = await db.prepare('SELECT provider_key, hint, updated_by, updated_at FROM provider_secrets').all();
        return new Map(rows.map((r) => [r.provider_key, { hint: r.hint, updated_by: r.updated_by, updated_at: r.updated_at }]));
    }

    return { load, put, remove, hints };
}

/** The key of a provider whose secret_ref is 'vault:<key>' ('' when none is stored). */
function get(providerKey) { return keys.get(providerKey) || ''; }

module.exports = { createVault, get, KEY_RE, _seal: seal, _open: open, _keys: keys };
