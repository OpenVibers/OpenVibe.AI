'use strict';

const SOURCES = Object.freeze([
    { id: 'google-notes', provider: 'gemini', url: 'https://aistudio.google.com/docs/changelog', kind: 'text' },
    { id: 'openai-notes', provider: 'openai', url: 'https://developers.openai.com/api/docs/changelog', kind: 'text' },
    { id: 'anthropic-notes', provider: 'anthropic', url: 'https://platform.claude.com/docs/en/release-notes/overview', kind: 'text' },
    { id: 'google-sdk', provider: 'gemini', url: 'https://raw.githubusercontent.com/googleapis/python-genai/main/google/genai/types.py', kind: 'text' },
    { id: 'openai-sdk', provider: 'openai', url: 'https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat_model.py', kind: 'text' },
    { id: 'anthropic-sdk', provider: 'anthropic', url: 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/model.py', kind: 'text' },
    { id: 'openrouter-newest', provider: 'openrouter', url: 'https://openrouter.ai/api/v1/models', kind: 'openrouter' },
    { id: 'huggingface-google', provider: 'huggingface', url: 'https://huggingface.co/api/models?author=google&sort=createdAt&direction=-1&limit=30', kind: 'huggingface' },
    { id: 'huggingface-meta', provider: 'huggingface', url: 'https://huggingface.co/api/models?author=meta-llama&sort=createdAt&direction=-1&limit=30', kind: 'huggingface' },
    { id: 'huggingface-qwen', provider: 'huggingface', url: 'https://huggingface.co/api/models?author=Qwen&sort=createdAt&direction=-1&limit=30', kind: 'huggingface' },
    { id: 'arena-codenames', provider: 'arena', url: 'https://lmarena.ai/leaderboard/text', kind: 'text' },
]);
const PATTERNS = Object.freeze({
    gemini: /\b(?:gemini|gemma|imagen|veo)-[a-z0-9][a-z0-9._-]{2,90}\b/gi,
    openai: /\b(?:gpt|o[1-9]|sora|dall-e)-[a-z0-9][a-z0-9._-]{2,90}\b/gi,
    anthropic: /\bclaude-(?:opus|sonnet|haiku|fable|mythos)-[a-z0-9][a-z0-9._-]{2,90}\b/gi,
    arena: /\b(?:anonymous|stealth|secret)-[a-z0-9][a-z0-9._-]{2,90}\b/gi,
});
const safeId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{2,160}$/.test(v) && !v.includes('..');
function findings(source, body, observedAt) {
    const add = (model, url, publishedAt = null) => safeId(model) ? {
        id: `${source.provider}/${model}`.toLowerCase(), provider: source.provider, model,
        source: { url, observed_at: observedAt, ...(publishedAt ? { published_at: publishedAt } : {}) },
    } : null;
    if (source.kind === 'openrouter') {
        const data = JSON.parse(body);
        return (Array.isArray(data.data) ? data.data : []).slice(0, 100).map(m => add(m.id, `https://openrouter.ai/models/${m.id}`, Number.isFinite(Number(m.created)) ? new Date(Number(m.created) * 1000).toISOString() : null)).filter(Boolean);
    }
    if (source.kind === 'huggingface') {
        const data = JSON.parse(body);
        return (Array.isArray(data) ? data : []).slice(0, 30).map(m => add(m.id, `https://huggingface.co/${m.id}`, m.createdAt || null)).filter(Boolean);
    }
    const matches = [...String(body).matchAll(PATTERNS[source.provider] || /$^/g)].map(m => m[0]);
    return [...new Set(matches)].slice(0, 100).map(model => add(model, source.url)).filter(Boolean);
}

function createModelDiscovery({ db, registry, fetchImpl = globalThis.fetch, clock = { now: Date.now }, sources = SOURCES, log = console }) {
    let running = null;
    let timer = null;
    const at = () => new Date(clock.now()).toISOString();
    const known = async () => new Set((await registry.listModels()).map(m => `${m.provider_key}/${m.model_key}`.toLowerCase()));
    async function list({ includeDismissed = false } = {}) {
        const listed = await known();
        const rows = await db.prepare('SELECT * FROM model_spots ORDER BY last_seen_at DESC LIMIT 1000').all();
        return rows.filter(r => !listed.has(r.id) && (includeDismissed || r.status !== 'dismissed')).map(r => ({
            id: r.id, provider: r.provider_key, model: r.model_key, name: r.display_name,
            status: 'spotted', promoted: r.status === 'promoted', dismissed: r.status === 'dismissed',
            first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, sources: JSON.parse(r.sources_json),
        }));
    }
    async function run() {
        if (running) return running;
        running = (async () => {
            const started = at();
            const job = await db.prepare("INSERT INTO model_discovery_runs (started_at, status) VALUES (?, 'running') RETURNING id").get(started);
            let read = 0, newCount = 0;
            const listed = await known();
            try {
                for (const source of sources) {
                    try {
                        const response = await fetchImpl(source.url, { headers: { Accept: source.kind === 'text' ? 'text/html, text/plain' : 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000) });
                        if (!response.ok) continue;
                        const body = (await response.text()).slice(0, 2_000_000);
                        const found = findings(source, body, at());
                        read++;
                        for (const item of found) {
                            if (listed.has(item.id)) continue;
                            const old = await db.prepare('SELECT * FROM model_spots WHERE id = ?').get(item.id);
                            const sources = old ? JSON.parse(old.sources_json) : [];
                            if (!sources.some(s => s.url === item.source.url)) sources.push(item.source);
                            if (old) await db.prepare('UPDATE model_spots SET last_seen_at = ?, sources_json = ?, updated_at = ? WHERE id = ?')
                                .run(at(), JSON.stringify(sources.slice(-8)), at(), item.id);
                            else {
                                await db.prepare('INSERT INTO model_spots (id, provider_key, model_key, display_name, status, sources_json, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                                    .run(item.id, item.provider, item.model, item.model, 'spotted', JSON.stringify(sources), at(), at(), at());
                                newCount++;
                            }
                        }
                    } catch { log.warn(`[model-discovery] ${source.id} unavailable`); }
                }
                const status = read ? 'succeeded' : 'failed';
                await db.prepare('UPDATE model_discovery_runs SET finished_at = ?, status = ?, sources_read = ?, spotted = ? WHERE id = ?')
                    .run(at(), status, read, newCount, job.id);
                return { status, sources_read: read, spotted: newCount, entries: await list() };
            } catch (error) {
                await db.prepare("UPDATE model_discovery_runs SET finished_at = ?, status = 'failed' WHERE id = ?").run(at(), job.id);
                throw error;
            }
        })().finally(() => { running = null; });
        return running;
    }
    async function tick() {
        const last = await db.prepare('SELECT started_at FROM model_discovery_runs ORDER BY id DESC LIMIT 1').get();
        if (!last || clock.now() - Date.parse(last.started_at) >= 86_400_000) await run();
    }
    async function setStatus(id, status) {
        if (!['spotted', 'promoted', 'dismissed'].includes(status)) throw new RangeError('invalid spot status');
        const row = await db.prepare('UPDATE model_spots SET status = ?, updated_at = ? WHERE id = ? RETURNING id').get(status, at(), id);
        return Boolean(row);
    }
    return { list, run, tick, setStatus,
        start() { if (!timer) { void tick().catch(() => log.warn('[model-discovery] schedule failed')); timer = setInterval(() => void tick().catch(() => log.warn('[model-discovery] schedule failed')), 60_000); timer.unref?.(); } },
        async stop() { clearInterval(timer); timer = null; if (running) await running; },
    };
}
module.exports = { SOURCES, findings, createModelDiscovery };
