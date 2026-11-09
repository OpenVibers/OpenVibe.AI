'use strict';

const URL = 'https://models.dev/api.json';
const DAY_MS = 86_400_000;
// Keep identical to Report server/data/ai-join.js.
const bare = (v) => String(v || '').toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/[-_@:](\d{4}-?\d{2}-?\d{2}|latest|free)$/, '');

function indexMetadata(data) {
    const entries = [];
    for (const [provider, p] of Object.entries(data || {})) {
        for (const [id, m] of Object.entries(p.models || {})) {
            if (!m || typeof m !== 'object') continue;
            const canonical = m.canonical_model_id || m.id || id;
            // A reseller's name is not the maker. Prefer explicit canonical identity, then a
            // first-party record; unprefixed reseller-only records leave maker unknown.
            const maker = m.maker || (canonical.includes('/') ? canonical.split('/')[0] : null);
            entries.push({ id: m.id || id, provider, maker, model: m });
        }
    }
    return entries;
}

function lookupMetadata(entries, id, provider) {
    const matches = entries.filter((e) => bare(e.id) === bare(id));
    const found = matches.find((e) => e.provider === provider && e.id === id)
        || matches.find((e) => e.provider === provider)
        || matches.find((e) => e.id === id) || matches[0];
    if (!found) return {};
    const m = found.model;
    const firstParty = matches.find((e) => !e.id.includes('/') && e.provider !== 'openrouter' &&
        matches.some((other) => other.maker === e.provider));
    return {
        maker: found.maker || (firstParty && firstParty.provider) || null,
        release_date: m.release_date || null, knowledge_cutoff: m.knowledge || null,
        licence: typeof (m.license || m.licence) === 'string' ? (m.license || m.licence) : null,
        context: m.limit?.context ?? null, max_output: m.limit?.output ?? null,
        modalities: m.modalities ? { input: m.modalities.input || [], output: m.modalities.output || [] } : null,
        open_weights: typeof m.open_weights === 'boolean' ? m.open_weights : null,
    };
}

function createModelMetadata({ db, fetchImpl = globalThis.fetch, now = Date.now, enabled = true, log = console }) {
    let snapshot = null; let loaded = false; let retryAt = 0; let pending = null;
    async function refresh() {
        if (!loaded) {
            const row = await db.prepare('SELECT payload, checked_at FROM exchange_model_metadata WHERE id = ?').get('models.dev');
            if (row) snapshot = { entries: indexMetadata(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload), checked_at: new Date(row.checked_at).toISOString() };
            loaded = true;
        }
        const expired = !snapshot || now() - Date.parse(snapshot.checked_at) >= DAY_MS;
        if (expired && enabled && now() >= retryAt) {
            retryAt = now() + 60_000;
            try {
                const response = await fetchImpl(URL, { signal: AbortSignal.timeout(15_000) });
                if (!response.ok) throw new Error('metadata HTTP failure');
                const raw = await response.text();
                if (raw.length > 32 * 1024 * 1024) throw new Error('metadata exceeds size limit');
                const data = JSON.parse(raw); const entries = indexMetadata(data);
                if (!entries.length) throw new Error('metadata has no models');
                const checked_at = new Date(now()).toISOString();
                await db.prepare(`INSERT INTO exchange_model_metadata (id, payload, checked_at) VALUES (?, ?::jsonb, ?)
                    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, checked_at = EXCLUDED.checked_at`).run('models.dev', raw, checked_at);
                snapshot = { entries, checked_at };
            } catch (_) { log.warn?.('models.dev metadata refresh failed; keeping last copy'); }
        }
        return { entries: snapshot?.entries || [], source: URL, checked_at: snapshot?.checked_at || null,
            stale: !snapshot || now() - Date.parse(snapshot.checked_at) >= DAY_MS };
    }
    return { read() { if (!pending) pending = refresh().finally(() => { pending = null; }); return pending; } };
}
module.exports = { createModelMetadata, indexMetadata, lookupMetadata, bare, URL, DAY_MS };
