'use strict';
/**
 * The memory-service connections (Memory M5): mem0, Letta and Zep, each with the person's own key.
 *
 *   GET    /api/v1/memory/services                 the connections, without any key (the last four characters only)
 *   PUT    /api/v1/memory/services/:provider       store or replace the key, then test it
 *   DELETE /api/v1/memory/services/:provider       forget the key
 *   POST   /api/v1/memory/services/:provider/sync  read the service and put what it has into the store
 *
 * The key is sealed (server/memory/services/keys.js) and opened only for the duration of one probe or sync. It is
 * never in a URL, a log line, an error or an answer. A sync hands the adapter's items to the store's own batch, so
 * they are redacted again there, deduped by the same text MAC and scoped to the person who connected the service.
 */

const { redact, onlySecret } = require('openvibe-sdk/redact');
const { AiError } = require('../../util');
const { createServiceKeys } = require('./keys');
const { ADAPTERS, PROVIDERS } = require('./adapters');
const { createServiceTransport, assertPublicBaseUrl } = require('./transport');

const MAX_SYNC = 1000;
const BATCH = 200;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createMemoryServices({ db, config, clock = { now: () => Date.now() }, log = console, memory, transport = null, lookup = null }) {
    const keys = createServiceKeys({ db, config, clock });
    const guarded = createServiceTransport({ transport, lookup });
    /** The stored base (or the adapter's default), checked again: a legacy row is never sent a key to a private host. */
    async function baseFor(row, adapter) {
        const u = await assertPublicBaseUrl(String((row && row.base_url) || adapter.defaultBaseUrl), { lookup });
        return u.toString().replace(/\/+$/, '');
    }
    const adapterOf = (provider) => {
        const adapter = ADAPTERS[provider];
        if (!adapter) throw new AiError(404, 'memory.service_not_found', 'no such memory service');
        return adapter;
    };

    /** The person's connections, one row per provider that has a key. Never a key. */
    async function list(subject) {
        const rows = await keys.list(subject);
        return {
            providers: PROVIDERS.map((id) => {
                const adapter = ADAPTERS[id];
                const row = rows.find((r) => r.provider === id);
                return {
                    provider: id, name: adapter.name, docs: adapter.docs, default_base_url: adapter.defaultBaseUrl,
                    connected: !!row,
                    ...(row || { hint: null, base_url: null, account: null, status: 'untested', checked_at: null, last_error: null, last_sync_at: null, last_sync_count: 0 }),
                };
            }),
        };
    }

    /**
     * Store a key, then test it by reading one page. The URL is judged (and resolved) before anything is stored, so a
     * key is never written for a private or malformed host; a key the service refuses is kept with the connection.
     */
    async function put(subject, provider, body) {
        const adapter = adapterOf(provider);
        const b = body && typeof body === 'object' ? body : {};
        let base = null;
        if (b.base_url != null && b.base_url !== '') {
            // 422 before keys.put: the key must not even be stored for a host that cannot be reached safely.
            base = (await assertPublicBaseUrl(b.base_url, { lookup })).toString().replace(/\/+$/, '');
        }
        if (b.account != null && (typeof b.account !== 'string' || b.account.length > 200)) throw new AiError(422, 'input.invalid', 'account must be a string of at most 200 characters');
        const saved = await keys.put(subject, provider, { key: b.key, base_url: base, account: b.account || null });
        const opened = await keys.openFor(subject, provider);
        let probe;
        try {
            const found = await adapter.list({ key: opened.key, baseUrl: opened.row.base_url, request: guarded.get, limit: 1 });
            probe = { ok: true, count: found.length };
        } catch (err) {
            // A redirect, a blocked answer or an oversized body is the URL's problem, not the key's: forget the row
            // and refuse the save. A refused key stays, with its redacted reason, so the person can replace it.
            if (['memory.service_redirect', 'memory.service_blocked', 'memory.service_too_large'].includes(String(err && err.code))) {
                await keys.remove(subject, provider);
                throw new AiError(422, 'memory.service_url', err.message);
            }
            probe = { ok: false, error: keys.scrub(err && err.message, opened.key) };
            log.warn(`[memory] ${provider} key test failed: ${err && err.code ? err.code : 'error'}`);
        }
        await keys.markProbe(subject, provider, probe);
        const row = (await keys.list(subject)).find((r) => r.provider === provider);
        return { service: row || saved };
    }

    async function remove(subject, provider) {
        adapterOf(provider);
        const gone = await keys.remove(subject, provider);
        if (!gone) throw new AiError(404, 'memory.service_not_found', 'that memory service is not connected');
        return { removed: 1 };
    }

    /**
     * Read one connected service and put its notes in the person's store. The adapter sees the decrypted key for this
     * call only; the store's batch does the redaction, the dedupe and the suggestion rule again.
     */
    async function sync(subject, provider) {
        const adapter = adapterOf(provider);
        const owner = `user:${subject}`;
        const view = (await keys.list(subject)).find((r) => r.provider === provider);
        if (!view) throw new AiError(404, 'memory.service_not_found', 'that memory service is not connected');
        // Judge and resolve the base before the key is opened: a refused host never sees the person's key.
        const base = await baseFor(view, adapter);
        const { key } = await keys.openFor(subject, provider);
        let found;
        try {
            found = await adapter.list({ key, baseUrl: base, request: guarded.get, limit: MAX_SYNC });
        } catch (err) {
            await keys.markProbe(subject, provider, { ok: false, error: err && err.message });
            log.warn(`[memory] ${provider} sync failed: ${err && err.code ? err.code : 'error'}`);
            if (String(err && err.code) === 'memory.service_blocked') {
                throw new AiError(422, 'memory.service_url', 'the service resolves to a non-public address');
            }
            if (String(err && err.code) === 'memory.service_redirect') {
                throw new AiError(502, 'memory.service_redirect', 'the service answered with a redirect');
            }
            throw new AiError(err && err.status === 401 ? 401 : 502, err && err.code ? err.code : 'memory.service_failed',
                err && err.status === 401 ? 'the service refused the key' : 'the memory service did not answer');
        }
        // Redact here as well as in the store, so an item that is only a secret is dropped (not a whole batch refused).
        const items = [];
        let skipped = 0;
        for (const raw of found) {
            const text = String((raw && raw.text) || '');
            if (!text.trim() || onlySecret(redact(text).text)) { skipped++; continue; }
            items.push({
                text: text.slice(0, 8000), kind: raw.kind, scope: 'user', source: provider,
                source_ref: raw.source_ref || null, confidence: 0.8, ...(raw.seen_at ? { seen_at: raw.seen_at } : {}),
            });
        }
        let created = 0;
        let deduped = 0;
        for (let i = 0; i < items.length; i += BATCH) {
            const chunk = items.slice(i, i + BATCH);
            const out = await memory.batch({
                principal: { kind: 'user', subject: { type: 'user', id: subject }, claims: {} },
                body: { items: chunk },
            }, owner);
            created += Number(out.created) || 0;
            deduped += Number(out.deduped) || 0;
        }
        await keys.markSync(subject, provider, items.length);
        return { provider, found: found.length, imported: created, deduped, skipped };
    }

    return { list, put, remove, sync, adapterOf, PROVIDERS, SUBJECT_RE };
}

module.exports = { createMemoryServices, SUBJECT_RE };
