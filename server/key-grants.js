'use strict';
/**
 * Who may use a person's own key (plan L55 C3; the owner's rule L24: a person opts in per app; nothing uses their
 * data or keys by default).
 *
 * A grant is the person's own: (subject, service, provider) — the app, and one provider or '*' for all of them. The
 * key itself never comes here: it stays sealed in subject_credentials (server/credentials.js). This table says who may
 * ask for it, nothing more: no key, no token, no hint.
 *
 * A service that holds no credential of its own for a person may still use that person's key, but only for the
 * providers the person allowed it, and only while the grant stands. Removing it takes effect at once.
 */
const { AiError } = require('./util');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
// A service (an app on the network): actor, codes, chat, live…
const SERVICE_RE = /^[a-z][a-z0-9._-]{1,39}$/;
// The provider names a grant may name, plus '*' for all of them.
const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,39}$/;

function createKeyGrants({ db, clock = { now: () => Date.now() } } = {}) {
    const iso = (ms) => new Date(ms).toISOString();

    /** The provider ids a grant may name: '*' (all) or a provider. */
    function providerOf(value) {
        const p = String(value == null ? '*' : value).trim().toLowerCase();
        if (p !== '*' && !PROVIDER_RE.test(p)) throw new AiError(422, 'input.invalid', 'provider is not a provider name');
        return p;
    }

    /** Let a service use this person's key for a provider (or for all of them). */
    async function allow(subject, service, provider = '*') {
        if (!SUBJECT_RE.test(String(subject || ''))) throw new AiError(400, 'input.invalid', 'subject must be a usr_ subject');
        const svc = String(service || '').trim().toLowerCase();
        if (!SERVICE_RE.test(svc)) throw new AiError(422, 'input.invalid', 'service is not an app name');
        const p = providerOf(provider);
        const at = iso(clock.now());
        await db.prepare(
            'INSERT INTO ai_key_grants (subject, service, provider, created_at) VALUES (?, ?, ?, ?)'
            + ' ON CONFLICT (subject, service, provider) DO UPDATE SET created_at = excluded.created_at',
        ).run(subject, svc, p, at);
        return { subject, service: svc, provider: p, created_at: at };
    }

    /** Take a grant away. Without a provider, every grant for that service goes. */
    async function remove(subject, service, provider = null) {
        if (!SUBJECT_RE.test(String(subject || ''))) return 0;
        const svc = String(service || '').trim().toLowerCase();
        if (provider == null) {
            const r = await db.prepare('DELETE FROM ai_key_grants WHERE subject = ? AND service = ?').run(subject, svc);
            return Number(r && r.changes) || 0;
        }
        const p = providerOf(provider);
        const r = await db.prepare('DELETE FROM ai_key_grants WHERE subject = ? AND service = ? AND provider = ?').run(subject, svc, p);
        return Number(r && r.changes) || 0;
    }

    /** Every grant the person gave, newest first. */
    async function list(subject) {
        if (!SUBJECT_RE.test(String(subject || ''))) return [];
        return await db.prepare('SELECT subject, service, provider, created_at FROM ai_key_grants WHERE subject = ? ORDER BY created_at DESC').all(subject);
    }

    /** May this service use this person's key for this provider? */
    async function allows(subject, service, provider) {
        if (!SUBJECT_RE.test(String(subject || '')) || !service) return false;
        const svc = String(service).trim().toLowerCase();
        const p = String(provider || '').trim().toLowerCase();
        const rows = await db.prepare('SELECT provider FROM ai_key_grants WHERE subject = ? AND service = ?').all(subject, svc);
        return rows.some((r) => r.provider === '*' || r.provider === p);
    }

    /** The providers this person allowed this service for, names only. */
    async function allowedProviders(subject, service) {
        if (!SUBJECT_RE.test(String(subject || '')) || !service) return [];
        const svc = String(service).trim().toLowerCase();
        const rows = await db.prepare('SELECT provider FROM ai_key_grants WHERE subject = ? AND service = ?').all(subject, svc);
        if (rows.some((r) => r.provider === '*')) return ['*'];
        return rows.map((r) => r.provider).filter(Boolean).sort();
    }

    return { allow, remove, list, allows, allowedProviders };
}

module.exports = { createKeyGrants, SUBJECT_RE, SERVICE_RE };
