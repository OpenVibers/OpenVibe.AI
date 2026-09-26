'use strict';
/**
 * Read models of the operator console. Reads only: every change goes through the functions the
 * admin API uses (server/ops.js, registry, quotas, runs). Filters are validated here; a malformed one
 * is dropped and reported, never passed on, and every value is a bound parameter.
 *
 * Run previews follow the run storage rules (server/runs.js retainedInput): inline images are
 * already hashes and passthrough prompts are not kept at all. On top of that the console shows at
 * most PREVIEW_STRING characters of any string, PREVIEW_ITEMS items of any list and PREVIEW_BYTES in
 * all, and blanks keys that name credentials. Raw debug prompt/response fields are never selected.
 */

const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'cached'];
const KEY_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const REQUESTER_RE = /^(service|app|mod|user):[A-Za-z0-9_.:-]{1,120}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const CODE_RE = /^[a-z][a-z0-9_.-]{1,80}$/;
const RUN_ID_RE = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?$/;
const PAGE = 50;

const PREVIEW_STRING = 240;
const PREVIEW_ITEMS = 20;
const PREVIEW_DEPTH = 6;
const PREVIEW_BYTES = 6000;
// Keys that name a credential (api_key, apiKey, client_secret, accessToken, password, …), compared letters-only.
const SECRETISH = ['apikey', 'secret', 'secrets', 'password', 'passwd', 'token', 'authorization', 'cookie', 'credential', 'credentials', 'privatekey'];
const secretish = (k) => { const x = String(k).toLowerCase().replace(/[^a-z]/g, ''); return SECRETISH.some((s) => x.endsWith(s)); };

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 'YYYY-MM-DD' or a datetime-local value (read as UTC) -> ISO; `to` of a bare day is the next midnight (exclusive). */
function parseTime(v, edge) {
    if (DAY_RE.test(v)) {
        const ms = Date.parse(`${v}T00:00:00Z`);
        if (!Number.isFinite(ms)) return null;
        return new Date(edge === 'to' ? ms + 86400000 : ms).toISOString();
    }
    if (MINUTE_RE.test(v)) {
        const ms = Date.parse(v.endsWith('Z') ? v : `${v}Z`);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    return null;
}

/** 'live' -> 'service:live'; 'service:live', 'app:…' kept; anything else null. */
function requesterOf(v) {
    if (!v) return null;
    if (SERVICE_RE.test(v)) return `service:${v}`;
    return REQUESTER_RE.test(v) ? v : null;
}

/** Run list filters from the query string: { filters, form, bad }. `form` echoes what was typed. */
function parseRunFilters(q = {}) {
    const filters = {};
    const bad = [];
    const form = {};
    for (const k of ['status', 'workflow', 'requester', 'code', 'from', 'to', 'before']) form[k] = str(q[k]).slice(0, 200);
    if (form.status) { if (RUN_STATUSES.includes(form.status)) filters.status = form.status; else bad.push('status'); }
    if (form.workflow) { if (form.workflow.length <= 120 && KEY_RE.test(form.workflow)) filters.workflow = form.workflow; else bad.push('workflow'); }
    if (form.requester) { const r = requesterOf(form.requester); if (r) filters.requester = r; else bad.push('requester'); }
    if (form.code) { if (CODE_RE.test(form.code)) filters.code = form.code; else bad.push('error code'); }
    if (form.from) { const t = parseTime(form.from, 'from'); if (t) filters.fromIso = t; else bad.push('from'); }
    if (form.to) { const t = parseTime(form.to, 'to'); if (t) filters.toIso = t; else bad.push('to'); }
    if (form.before) { if (RUN_ID_RE.test(form.before)) filters.before = form.before; else bad.push('before'); }
    return { filters, form, bad };
}

function listRuns(db, f, limit = PAGE) {
    const where = [];
    const args = [];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.workflow) { where.push('workflow_key = ?'); args.push(f.workflow); }
    if (f.requester) {
        const i = f.requester.indexOf(':');
        where.push('requester_type = ? AND requester_id = ?');
        args.push(f.requester.slice(0, i), f.requester.slice(i + 1));
    }
    if (f.code) { where.push('error_code = ?'); args.push(f.code); }
    if (f.fromIso) { where.push('created_at >= ?'); args.push(f.fromIso); }
    if (f.toIso) { where.push('created_at < ?'); args.push(f.toIso); }
    if (f.before) { where.push('id < ?'); args.push(f.before); }
    const rows = db.prepare(`SELECT id, status, workflow_key, workflow_version, requester_type, requester_id, provider_key, model_key, fallback_used, attempts,
            tokens_in, tokens_out, cost_usd, error_code, synthetic, cached_from, retry_of, created_at, finished_at
        FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
    return { rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
}

/** Failed runs since `sinceIso`, grouped by error code. */
function failures(db, sinceIso) {
    return db.prepare(`SELECT error_code, COUNT(*) AS n, COUNT(DISTINCT workflow_key) AS workflows, MAX(created_at) AS last_at
        FROM runs WHERE status = 'failed' AND created_at >= ? GROUP BY error_code ORDER BY n DESC LIMIT 20`).all(sinceIso);
}

function statusCounts(db, sinceIso) {
    return Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY status').all(sinceIso).map(r => [r.status, r.n]));
}

/** Suggestions for the run filters (<datalist>): requesters and workflow keys that have runs. */
function runFacets(db) {
    return {
        requesters: db.prepare("SELECT DISTINCT requester_type || ':' || requester_id AS r FROM runs ORDER BY r LIMIT 100").all().map(x => x.r),
        workflows: db.prepare('SELECT DISTINCT workflow_key AS w FROM runs ORDER BY w LIMIT 300').all().map(x => x.w),
        codes: db.prepare("SELECT DISTINCT error_code AS c FROM runs WHERE error_code IS NOT NULL ORDER BY c LIMIT 100").all().map(x => x.c),
    };
}

/** A bounded, credential-blanked copy of a stored input/output for display. */
function preview(value) {
    let cut = false;
    const walk = (v, depth) => {
        if (typeof v === 'string') {
            if (v.length <= PREVIEW_STRING) return v;
            cut = true;
            return `${v.slice(0, PREVIEW_STRING)}… (${v.length - PREVIEW_STRING} more characters)`;
        }
        if (v == null || typeof v !== 'object') return v;
        if (depth >= PREVIEW_DEPTH) { cut = true; return '…'; }
        if (Array.isArray(v)) {
            const out = v.slice(0, PREVIEW_ITEMS).map(x => walk(x, depth + 1));
            if (v.length > PREVIEW_ITEMS) { cut = true; out.push(`… (${v.length - PREVIEW_ITEMS} more items)`); }
            return out;
        }
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (secretish(k) && x != null && x !== '') { out[k] = '[not shown]'; cut = true; } else out[k] = walk(x, depth + 1);
        }
        return out;
    };
    if (value === null || value === undefined) return { text: null, cut: false };
    let text = JSON.stringify(walk(value, 0), null, 2);
    if (text.length > PREVIEW_BYTES) { text = `${text.slice(0, PREVIEW_BYTES)}\n… (truncated)`; cut = true; }
    return { text, cut };
}

// ── Audit ────────────────────────────────────────────────────
const AUDIT_KINDS = Object.freeze({
    changes: { label: 'Configuration changes', where: "target_type IN ('provider', 'model', 'route', 'template', 'workflow', 'quota', 'cache')" },
    runs: { label: 'Runs', where: "target_type = 'run'" },
    console: { label: 'Console sign-ins and refusals', where: "action LIKE 'console.%'" },
    all: { label: 'Everything', where: null },
});

function parseAuditFilters(q = {}) {
    const form = {};
    for (const k of ['kind', 'action', 'actor', 'target_type', 'target_id', 'before']) form[k] = str(q[k]).slice(0, 200);
    const f = { kind: AUDIT_KINDS[form.kind] ? form.kind : 'changes' };
    const bad = [];
    if (form.action) { if (/^[a-z][a-z0-9_.]{1,80}$/.test(form.action)) f.action = form.action; else bad.push('action'); }
    if (form.actor) { if (/^[A-Za-z0-9_:.-]{1,120}$/.test(form.actor)) f.actor = form.actor; else bad.push('actor'); }
    if (form.target_type) { if (/^[a-z_]{1,40}$/.test(form.target_type)) f.targetType = form.target_type; else bad.push('target type'); }
    if (form.target_id) f.targetId = form.target_id;
    if (form.before) { if (/^\d{1,15}$/.test(form.before)) f.before = Number(form.before); else bad.push('before'); }
    form.kind = f.kind;
    return { filters: f, form, bad };
}

function listAudit(db, f, limit = 100) {
    const where = [];
    const args = [];
    const kind = AUDIT_KINDS[f.kind] || AUDIT_KINDS.changes;
    if (kind.where) where.push(`(${kind.where})`);
    if (f.action) { where.push('action = ?'); args.push(f.action); }
    if (f.actor) { where.push('actor = ?'); args.push(f.actor); }
    if (f.targetType) { where.push('target_type = ?'); args.push(f.targetType); }
    if (f.targetId) { where.push('target_id = ?'); args.push(f.targetId); }
    if (f.before) { where.push('id < ?'); args.push(f.before); }
    const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
    const page = rows.slice(0, limit).map(r => ({ ...r, metadata: parseMeta(r.metadata) }));
    return { rows: page, next: rows.length > limit ? page[page.length - 1].id : null };
}
function parseMeta(s) { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }

/** subject -> username, from console sign-ins (the audit log keeps only the subject). */
function usernames(db) {
    const map = new Map();
    for (const r of db.prepare('SELECT subject, username FROM console_sessions WHERE username IS NOT NULL ORDER BY created_at').all()) map.set(r.subject, r.username);
    return map;
}

// ── Usage ────────────────────────────────────────────────────
function parseUsageFilters(q = {}, nowMs = Date.now()) {
    const form = { from: str(q.from).slice(0, 10), to: str(q.to).slice(0, 10), requester: str(q.requester).slice(0, 200) };
    const bad = [];
    const f = {};
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (!form.from) form.from = new Date(nowMs - 6 * 86400000).toISOString().slice(0, 10);
    if (!form.to) form.to = today;
    if (DAY_RE.test(form.from)) f.from = form.from; else bad.push('from');
    if (DAY_RE.test(form.to)) f.to = form.to; else bad.push('to');
    if (form.requester) { const r = requesterOf(form.requester); if (r) f.requester = r; else bad.push('requester'); }
    return { filters: f, form, bad };
}

/** usage_daily rows (quotas.usage, the API's own query) summed four ways. */
function usageReport(quotas, f) {
    const rows = quotas.usage({ from: f.from, to: f.to, requester: f.requester });
    const blank = () => ({ requests: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0 });
    const add = (acc, r) => { acc.requests += r.requests; acc.tokens_in += r.tokens_in; acc.tokens_out += r.tokens_out; acc.tokens_cached += r.tokens_cached; acc.cost_usd += r.cost_usd; return acc; };
    const group = (keyOf) => {
        const m = new Map();
        for (const r of rows) { const k = keyOf(r); m.set(k, add(m.get(k) || blank(), r)); }
        return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests);
    };
    return {
        total: rows.reduce(add, blank()),
        truncated: rows.length >= 1000,
        byDay: group(r => r.day).sort((a, b) => (a.key < b.key ? 1 : -1)),
        byRequester: group(r => r.requester),
        byWorkflow: group(r => r.workflow_key),
        byModel: group(r => `${r.provider_key}${r.model_key ? ` / ${r.model_key}` : ''}`),
    };
}

module.exports = {
    RUN_STATUSES, AUDIT_KINDS, PAGE, parseRunFilters, listRuns, failures, statusCounts, runFacets, preview,
    parseAuditFilters, listAudit, usernames, parseUsageFilters, usageReport, parseTime, requesterOf,
};
