'use strict';
/**
 * AI's user modules on OpenVibe.Network (openvibe-contracts 0.41.0, roadmap WS-B task 9):
 *
 *   ai.preferences    read (AI is a listed reader of all five fields): style, length and perspective shape
 *                     the prompts of runs made on a person's behalf (engine.js withPreferences);
 *                     history: false keeps neither their input nor a cache entry (runs.js). Cached
 *                     5 minutes per person; Network down or no record = no preferences.
 *   ai.usage_summary  written as the owner: runs_30d, tokens_30d, by_service, last_run_at, computed_at,
 *                     for runs on the person's behalf. scan() every 5 minutes (runs finished since the
 *                     last one), refresh() daily (the window moves); only when it changed (ai_module_pushes).
 *
 * Off without OV_OAUTH_CLIENT_SECRET. Only usr_ subjects.
 */
const crypto = require('crypto');

const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PREFS_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 86400000;

function subjectOf(onBehalfOf) {
    let ref = onBehalfOf;
    if (typeof ref === 'string') { try { ref = JSON.parse(ref); } catch { return null; } }
    return ref && ref.type === 'user' && USR.test(String(ref.id || '')) ? ref.id : null;
}

function createUserModules({ db, config, env = process.env, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console } = {}) {
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const enabled = !!secret && String(env.AI_USER_MODULES || '').toLowerCase() !== 'off';
    const base = String(config.networkInternalUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const prefsCache = new Map();
    const stats = { written: 0, unchanged: 0, failed: 0, lastError: null };
    let tokens = null, lastScan = null, timers = [];

    function tokenClient() {
        if (!tokens) {
            const { createServiceTokenClient } = require('openvibe-sdk/auth');
            tokens = createServiceTokenClient({ tokenUrl: `${base}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'ai', clientSecret: secret, fetch: fetchImpl });
        }
        return tokens;
    }
    async function call(method, ns, subject, data) {
        const t = await tokenClient().getToken({ audience: 'openvibe.network' });
        const res = await fetchImpl(`${base}/internal/modules/${ns}/${subject}`, {
            method, signal: AbortSignal.timeout(5000),
            headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) },
            body: data ? JSON.stringify({ data }) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    }

    /** The person's ai.preferences for a run's on_behalf_of ({} when none, not a person, or unavailable). */
    async function preferencesFor(onBehalfOf) {
        const subject = subjectOf(onBehalfOf);
        if (!enabled || !subject) return {};
        const hit = prefsCache.get(subject);
        if (hit && clock.now() - hit.at < PREFS_TTL_MS) return hit.data;
        let data = {};
        try {
            const r = await call('GET', 'ai.preferences', subject);
            if (r.status === 200 && r.body && r.body.data && typeof r.body.data === 'object') data = r.body.data;
            else if (r.status !== 404) return hit ? hit.data : {};
        } catch { return hit ? hit.data : {}; }
        if (prefsCache.size > 5000) prefsCache.clear();
        prefsCache.set(subject, { data, at: clock.now() });
        return data;
    }

    function ensureSchema() {
        db.exec(`CREATE TABLE IF NOT EXISTS ai_module_pushes (subject_id TEXT PRIMARY KEY, hash TEXT NOT NULL, pushed_at TEXT NOT NULL)`);
    }

    /** ai.usage_summary for one person over the 30 days before now, or null when there were no runs. */
    function summarize(subject, now = clock.now()) {
        const since = new Date(now - 30 * DAY_MS).toISOString();
        const rows = db.prepare(`SELECT COALESCE(source_service, requester_id) AS svc, COUNT(*) AS n, SUM(tokens_in + tokens_out) AS tokens, MAX(created_at) AS last
            FROM runs WHERE json_extract(on_behalf_of, '$.type') = 'user' AND json_extract(on_behalf_of, '$.id') = ? AND created_at >= ?
            GROUP BY svc`).all(subject, since);
        const lastEver = db.prepare("SELECT MAX(created_at) AS last FROM runs WHERE json_extract(on_behalf_of, '$.type') = 'user' AND json_extract(on_behalf_of, '$.id') = ?").get(subject).last;
        if (!lastEver) return null;
        const by = {};
        for (const r of rows.slice(0, 30)) if (/^[a-z][a-z0-9-]{1,39}$/.test(String(r.svc || ''))) by[r.svc] = r.n;
        return {
            runs_30d: rows.reduce((a, r) => a + r.n, 0),
            tokens_30d: rows.reduce((a, r) => a + (Number(r.tokens) || 0), 0),
            by_service: by,
            last_run_at: lastEver,
        };
    }

    async function push(subject, now = clock.now()) {
        if (!enabled || !USR.test(String(subject || ''))) return false;
        const data = summarize(subject, now);
        if (!data) return false;
        const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
        const last = db.prepare('SELECT hash FROM ai_module_pushes WHERE subject_id = ?').get(subject);
        if (last && last.hash === hash) { stats.unchanged++; return false; }
        try {
            const r = await call('PUT', 'ai.usage_summary', subject, { ...data, computed_at: new Date(now).toISOString() });
            if (r.status >= 300) throw new Error(`Network answered ${r.status} ${(r.body && r.body.code) || ''}`);
        } catch (err) { stats.failed++; stats.lastError = err.message; return false; }
        db.prepare(`INSERT INTO ai_module_pushes (subject_id, hash, pushed_at) VALUES (?, ?, ?)
            ON CONFLICT(subject_id) DO UPDATE SET hash = excluded.hash, pushed_at = excluded.pushed_at`).run(subject, hash, new Date(now).toISOString());
        stats.written++;
        return true;
    }

    const people = (sql, ...args) => db.prepare(sql).all(...args).map((r) => r.s).filter((s) => USR.test(String(s || '')));

    /** People with a run created since the previous scan. */
    async function scan(now = clock.now()) {
        if (!enabled) return 0;
        const from = lastScan || new Date(now - 10 * 60 * 1000).toISOString();
        const to = new Date(now).toISOString();
        const subjects = people("SELECT DISTINCT json_extract(on_behalf_of, '$.id') AS s FROM runs WHERE on_behalf_of IS NOT NULL AND created_at >= ? AND created_at < ?", from, to);
        for (const s of subjects) await push(s, now);
        lastScan = to;
        return subjects.length;
    }

    /** Everyone with a run in the last 31 days or a record already written (their window moves). */
    async function refresh(now = clock.now()) {
        if (!enabled) return 0;
        const since = new Date(now - 31 * DAY_MS).toISOString();
        const subjects = people(`SELECT DISTINCT json_extract(on_behalf_of, '$.id') AS s FROM runs WHERE on_behalf_of IS NOT NULL AND created_at >= ?
            UNION SELECT subject_id AS s FROM ai_module_pushes`, since);
        for (const s of subjects) await push(s, now);
        return subjects.length;
    }

    function start() {
        if (!enabled || timers.length) return false;
        ensureSchema();
        const safe = (fn) => () => { fn().catch((err) => { stats.lastError = err.message; }); };
        timers = [setInterval(safe(() => scan()), 5 * 60 * 1000), setInterval(safe(() => refresh()), DAY_MS), setTimeout(safe(() => refresh()), 3 * 60 * 1000)];
        for (const t of timers) t.unref?.();
        return true;
    }
    function stop() { for (const t of timers) { clearInterval(t); clearTimeout(t); } timers = []; }

    return { enabled, preferencesFor, ensureSchema, summarize, push, scan, refresh, start, stop, stats: () => ({ enabled, ...stats }) };
}

/** The system-prompt lines a person's ai.preferences add ('' when none). */
function preferenceLines(prefs) {
    if (!prefs || typeof prefs !== 'object') return '';
    const lines = [];
    if (['neutral', 'casual', 'formal'].includes(prefs.style)) lines.push(`Write in a ${prefs.style} style.`);
    if (prefs.length === 'short') lines.push('Keep it short.');
    else if (prefs.length === 'long') lines.push('Go into detail: a longer answer is welcome.');
    if (typeof prefs.perspective === 'string' && prefs.perspective.trim()) lines.push(`Write from this perspective: ${prefs.perspective.trim().slice(0, 80)}.`);
    return lines.length ? `The person this is for asked for the following. Follow it unless the task's own format rules say otherwise.\n${lines.join('\n')}` : '';
}

module.exports = { createUserModules, preferenceLines, subjectOf };
