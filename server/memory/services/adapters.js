'use strict';
/**
 * The memory-service adapters (Memory M5): mem0, Letta and Zep.
 *
 * Each adapter is data plus one read: where the service keeps a person's notes, how to page through them and how to
 * turn one record into a memory item. They never store anything; server/memory/services/index.js seals the key,
 * calls one adapter with it and hands the items to the store's own batch (which redacts again).
 *
 * The key travels in the request header and nowhere else. It is never put in a URL, a log line, an error message or
 * a response: an upstream refusal becomes a status code and a short, fixed sentence, even when the service echoes
 * the key back. The endpoints and their shapes:
 *
 *   mem0   GET  <base>/v1/memories/?page=&page_size=          Authorization: Token <key>
 *          { results: [{ id, memory, created_at }], next } (or a bare array without paging)
 *          https://docs.mem0.ai/api-reference/memory/get-memories
 *
 *   Letta  GET  <base>/v1/agents/                             Authorization: Bearer <key>
 *          GET  <base>/v1/agents/{id}/core-memory/blocks     (the core memory: { label, value })
 *          GET  <base>/v1/agents/{id}/archival-memory        (the archival passages: { text })
 *          https://docs.letta.com/api-reference/agents
 *
 *   Zep    GET  <base>/users                                  Authorization: Api-Key <key>
 *          GET  <base>/users/{user_id}/sessions
 *          GET  <base>/users/{user_id}/sessions/{session_id}/memory  (facts or messages)
 *          <base> defaults to https://api.getzep.com/api/v2
 *          https://help.getzep.com/api-reference
 *
 * A service that pages answers at most MAX_ITEMS records per sync; the store dedupes what a later sync finds again.
 */

const MAX_ITEMS = 1000;
const MAX_PAGES = 10;
const PAGE = 100;
const MAX_CHARS = 2000;
const TIMEOUT_MS = 15000;

const NAMES = { mem0: 'mem0', letta: 'Letta', zep: 'Zep' };
const DEFAULT_BASE = { mem0: 'https://api.mem0.ai', letta: 'https://api.letta.com', zep: 'https://api.getzep.com/api/v2' };

class ServiceError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function baseOf(id, baseUrl) {
    return String(baseUrl || DEFAULT_BASE[id]).replace(/\/+$/, '');
}

async function getJson(fetchImpl, url, headers) {
    let res;
    try {
        res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        // A network error's message may carry a URL but never the key: it is in a header, not the URL.
        throw new ServiceError(502, 'memory.service_unreachable', `${NAMES_OF_URL(url)} did not answer`);
    }
    if (res.status === 401 || res.status === 403) throw new ServiceError(401, 'memory.service_key_refused', 'the service refused the key');
    if (res.status === 429) throw new ServiceError(429, 'memory.service_rate_limited', 'the service is rate-limiting the key; try again later');
    if (!res.ok) throw new ServiceError(502, 'memory.service_failed', `the service answered ${res.status}`);
    try { return await res.json(); } catch { throw new ServiceError(502, 'memory.service_failed', 'the service answered with a body that is not JSON'); }
}

/** Only the host of the service, for an error sentence a person may see. Never the key or a query. */
function NAMES_OF_URL(url) {
    try { return new URL(url).host; } catch { return 'the memory service'; }
}

/** One record → one item. Text is cut to the store's own per-item bound; the store redacts and dedupes. */
function itemOf(text, { kind = 'fact', created_at, path } = {}) {
    const clean = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
    if (!clean) return null;
    return {
        text: clean.slice(0, MAX_CHARS),
        kind,
        scope: 'user',
        source_ref: path ? { path: String(path).slice(0, 500) } : null,
        ...(created_at && !Number.isNaN(Date.parse(String(created_at))) ? { seen_at: new Date(created_at).toISOString() } : {}),
    };
}

const arrayOf = (json, key) => Array.isArray(json) ? json : (json && Array.isArray(json[key]) ? json[key] : []);

/* ── mem0 ─────────────────────────────────────────────────────────────────── */
async function mem0List({ key, baseUrl, fetchImpl, limit = MAX_ITEMS }) {
    const base = baseOf('mem0', baseUrl);
    const out = [];
    for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
        const url = `${base}/v1/memories/?page=${page}&page_size=${PAGE}`;
        const json = await getJson(fetchImpl, url, { Authorization: `Token ${key}` });
        const rows = arrayOf(json, 'results');
        for (const row of rows) {
            const it = itemOf(row && row.memory, { created_at: row && row.created_at, path: row && row.id ? `mem0:${row.id}` : 'mem0' });
            if (it) out.push(it);
            if (out.length >= limit) break;
        }
        const next = json && typeof json === 'object' ? json.next : null;
        if (!rows.length || (!next && rows.length < PAGE)) break;
    }
    return out;
}

/* ── Letta ────────────────────────────────────────────────────────────────── */
async function lettaList({ key, baseUrl, fetchImpl, limit = MAX_ITEMS }) {
    const base = baseOf('letta', baseUrl);
    const headers = { Authorization: `Bearer ${key}` };
    const agents = arrayOf(await getJson(fetchImpl, `${base}/v1/agents/`, headers), 'agents');
    const out = [];
    for (const agent of agents) {
        if (!agent || !agent.id || out.length >= limit) continue;
        const id = encodeURIComponent(String(agent.id));
        let blocks = [];
        try { blocks = arrayOf(await getJson(fetchImpl, `${base}/v1/agents/${id}/core-memory/blocks`, headers), 'blocks'); }
        catch (err) { if (err.status === 401 || err.status === 403 || err.status === 429) throw err; /* one agent's blocks */ }
        for (const block of blocks) {
            // `persona` is what the agent is; `human` and the rest are what it knows about the person.
            const kind = block && block.label === 'persona' ? 'fact' : 'preference';
            const it = itemOf(block && block.value, { kind, path: `letta:${agent.id}:${(block && block.label) || 'block'}` });
            if (it) out.push(it);
            if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
        let passages = [];
        try { passages = arrayOf(await getJson(fetchImpl, `${base}/v1/agents/${id}/archival-memory?limit=${PAGE}`, headers), 'passages'); }
        catch (err) { if (err.status === 401 || err.status === 403 || err.status === 429) throw err; /* no archival memory */ }
        for (const passage of passages) {
            const it = itemOf(passage && passage.text, { created_at: passage && passage.created_at, path: passage && passage.id ? `letta:${passage.id}` : `letta:${agent.id}` });
            if (it) out.push(it);
            if (out.length >= limit) break;
        }
    }
    return out;
}

/* ── Zep ──────────────────────────────────────────────────────────────────── */
/** Zep v2 keeps a session's memory as facts; older responses carry messages. Both are read, never trusted to exist. */
function zepMemories(json) {
    const out = [];
    for (const container of [json && json.memory, json]) {
        if (!container || typeof container !== 'object') continue;
        for (const k of ['facts', 'messages', 'results']) {
            if (Array.isArray(container[k])) out.push(...container[k]);
        }
    }
    return out;
}

async function zepList({ key, baseUrl, fetchImpl, limit = MAX_ITEMS }) {
    const base = baseOf('zep', baseUrl);
    const headers = { Authorization: `Api-Key ${key}` };
    const users = arrayOf(await getJson(fetchImpl, `${base}/users`, headers), 'users');
    const out = [];
    for (const user of users) {
        const uid = user && (user.user_id || user.id);
        if (!uid || out.length >= limit) continue;
        let sessions = [];
        try { sessions = arrayOf(await getJson(fetchImpl, `${base}/users/${encodeURIComponent(String(uid))}/sessions`, headers), 'sessions'); }
        catch (err) { if (err.status === 401 || err.status === 403 || err.status === 429) throw err; continue; }
        for (const session of sessions) {
            const sid = session && (session.session_id || session.id);
            if (!sid || out.length >= limit) continue;
            let json;
            try { json = await getJson(fetchImpl, `${base}/users/${encodeURIComponent(String(uid))}/sessions/${encodeURIComponent(String(sid))}/memory`, headers); }
            catch (err) { if (err.status === 401 || err.status === 403 || err.status === 429) throw err; continue; }
            for (const memory of zepMemories(json)) {
                const text = memory && (memory.fact || memory.content || memory.text);
                const it = itemOf(text, { kind: 'fact', created_at: memory && (memory.created_at || memory.valid_at || memory.createdAt), path: memory && memory.uuid ? `zep:${memory.uuid}` : `zep:${uid}` });
                if (it) out.push(it);
                if (out.length >= limit) break;
            }
        }
    }
    return out;
}

const ADAPTERS = Object.freeze({
    mem0: { id: 'mem0', name: NAMES.mem0, docs: 'https://docs.mem0.ai/api-reference/memory/get-memories', defaultBaseUrl: DEFAULT_BASE.mem0, list: mem0List },
    letta: { id: 'letta', name: NAMES.letta, docs: 'https://docs.letta.com/api-reference/agents', defaultBaseUrl: DEFAULT_BASE.letta, list: lettaList },
    zep: { id: 'zep', name: NAMES.zep, docs: 'https://help.getzep.com/api-reference', defaultBaseUrl: DEFAULT_BASE.zep, list: zepList },
});

const PROVIDERS = Object.freeze(Object.keys(ADAPTERS));

module.exports = { ADAPTERS, PROVIDERS, MAX_ITEMS, MAX_CHARS, ServiceError, itemOf };
