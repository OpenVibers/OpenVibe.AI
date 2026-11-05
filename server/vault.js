'use strict';
/**
 * Provider keys, now kept in the ai.provider_keys configuration namespace (D11) instead of the provider_secrets
 * table. The owner's key is a write-only secret-class config value bound to the provider's origin, so a key can
 * never be sent to a host it was not entered for.
 *
 * The provider pool resolves a key synchronously (util.resolveSecret → get), so this module still holds the
 * in-process cache: the config store's onActivate refreshes it (server/settings.js). Nothing here logs, returns or
 * audits a value — only a four-character hint, from the store's marker.
 *
 * The legacy provider_secrets rows (AES-256-GCM under AI_CREDENTIALS_KEY) are migrated once at boot by migrate():
 * each one is opened, written as the sealed `<provider>.key` bound to the provider's current origin, read back, and
 * only then deleted. It is idempotent, and logs counts only.
 */
const crypto = require('crypto');
const { AiError } = require('./util');

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const keys = new Map();     // provider key → plaintext, this process only

function secretKey(config) {
    const hex = String((config && config.credentialsKey) || '');
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be read here: AI_CREDENTIALS_KEY is not set');
    return Buffer.from(hex, 'hex');
}

/** The legacy vault's seal (provider key as AAD), read only by the one-time migration. */
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

/** Fill the synchronous cache from the store's effective values (onActivate, boot). Locked secrets are absent. */
function refresh(values = {}) {
    keys.clear();
    for (const [k, v] of Object.entries(values)) {
        if (k.endsWith('.key') && typeof v === 'string' && v) keys.set(k.slice(0, -4), v);
    }
    return keys.size;
}

/** The key of a provider whose secret_ref is 'vault:<key>' ('' when none is stored or it does not open). */
function get(providerKey) { return keys.get(providerKey) || ''; }

function actorRef(actor) {
    if (actor && typeof actor === 'object' && actor.type && actor.id) return { type: String(actor.type), id: String(actor.id) };
    return { type: 'service', id: 'ai' };
}

function createVault({ settings, clock = { now: () => Date.now() }, log = console }) {
    if (!settings || !settings.providerKeys) throw new TypeError('createVault: pass the D11 settings');

    async function load() { return refresh(settings.providerKeys.store.get()); }

    async function put(providerKey, plain, { actor = 'system' } = {}) {
        if (!KEY_RE.test(providerKey || '')) throw new AiError(422, 'ai.invalid', 'provider key must be lowercase dotted/dashed');
        const value = String(plain || '').trim();
        if (value.length < 8 || value.length > 4000 || /\s/.test(value)) throw new AiError(422, 'ai.invalid', 'that does not look like an API key');
        const marker = await settings.providerKeys.setKey(providerKey, value, { actor: actorRef(actor), reason: 'provider key set from the console' });
        return { provider_key: providerKey, hint: marker.hint, updated_at: marker.set_at };
    }

    async function remove(providerKey) {
        await settings.providerKeys.deleteKey(providerKey, { actor: { type: 'service', id: 'ai' }, reason: 'provider key removed' });
    }

    /** Name → marker (hint, set_at, set_by) for the console's provider page; never a value. */
    async function hints() {
        const summary = await settings.providerKeys.store.summary();
        const out = new Map();
        for (const [k, m] of Object.entries(summary.secrets || {})) {
            if (!k.endsWith('.key')) continue;
            out.set(k.slice(0, -4), { hint: m.hint ? `…${m.hint}` : null, updated_by: m.set_by, updated_at: m.set_at });
        }
        return out;
    }

    return { load, put, remove, hints };
}

/**
 * One-time, idempotent vault → ai.provider_keys migration (AI_CREDENTIALS_KEY + OV_CONFIG_KEKS set). Returns
 * { migrated, already, failed, skipped } counts; a row is deleted only after the sealed key reads back.
 */
async function migrate({ db, config, settings, log = console }) {
    const none = { migrated: 0, already: 0, failed: 0, skipped: 0 };
    if (!settings || !settings.providerKeys) return none;
    if (!/^[0-9a-f]{64}$/i.test(String((config && config.credentialsKey) || ''))) return none;
    if (!settings.providerKeys.sealed) return none;
    const rows = await db.prepare('SELECT provider_key, sealed FROM provider_secrets').all();
    const report = { ...none };
    if (!rows.length) return report;
    const store = () => settings.providerKeys.store;
    const before = new Set(Object.keys((await store().summary()).secrets || {}));
    for (const row of rows) {
        let plain;
        try { plain = open(config, row.sealed, row.provider_key); } catch { report.failed++; continue; }
        const key = `${row.provider_key}.key`;
        try {
            if (before.has(key)) {
                if (store().get(key) === plain) { await db.prepare('DELETE FROM provider_secrets WHERE provider_key = ?').run(row.provider_key); report.already++; }
                else report.failed++;
                continue;
            }
            await settings.providerKeys.setKey(row.provider_key, plain, { actor: { type: 'service', id: 'ai' }, reason: 'migrated from AI_CREDENTIALS_KEY vault' });
            if (store().get(key) !== plain) throw new Error('the sealed key did not read back');
            await db.prepare('DELETE FROM provider_secrets WHERE provider_key = ?').run(row.provider_key);
            before.add(key);
            report.migrated++;
        } catch (err) {
            if (/no base URL/.test(String(err && err.message))) report.skipped++;
            else report.failed++;
        }
    }
    log.log(`[Vault] provider-key migration: ${report.migrated} moved, ${report.already} already, ${report.skipped} without an origin, ${report.failed} failed`);
    return report;
}

module.exports = { createVault, migrate, get, refresh, KEY_RE, _seal: seal, _open: open, _keys: keys };
