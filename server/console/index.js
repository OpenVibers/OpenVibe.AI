'use strict';
/**
 * The AI operator console (roadmap WS-O task 4): server-rendered, no JavaScript, on
 * ai.openvibe.network under /console, for OpenVibe.Network staff.
 *
 *   GET  /auth/login, /auth/callback     Network SSO (authorization code + PKCE S256, OAuth client `ai`)
 *   POST /auth/logout
 *   GET  /console                        overview: providers, runs and failures (24 h), spend, queue, quotas
 *   GET  /console/providers              providers (secret reference names + presence only) and models
 *   POST /console/providers/:key/status  enable/disable            (ai.provider.manage; ops.setProviderStatus)
 *   POST /console/providers/:key/reset   close the circuit         (ai.provider.manage; ops.resetCircuit)
 *   GET  /console/{routes,templates,workflows}[/:key[?version=]]  versions, status, content
 *   POST /console/{routes,templates,workflows}/:key/versions/:v/status   (ai.workflow.manage; registry.setStatus)
 *   GET  /console/runs[?status&workflow&requester&code&from&to&before], /console/runs/:id
 *   POST /console/runs/:id/cancel        (ai.workflow.manage; runs.cancel)
 *   GET  /console/quotas; POST /console/quotas   (writes: ai.provider.manage; quotas.upsert)
 *   GET  /console/usage[?from&to&requester]      (quotas.usage)
 *   GET  /console/cache; POST /console/cache/purge   (writes: ai.provider.manage; ops.purgeCache)
 *   GET  /console/audit[?kind&action&actor&target_type&target_id&before]
 *
 * Who: a Network person (usr_ subject) whose sign-in token holds staff capabilities of the contracts
 * staff map (policy.staff-role-map@1, ADR-022). A console session holds the AI capability ids of
 * STAFF_TO_AI below, and each page and action names the one it needs, exactly as the admin API does:
 *
 *   staff.site.view       (admin, owner) -> ai.usage.read       open the console, read every page
 *   staff.ai.manage       (admin, owner) -> ai.workflow.manage  version status changes, cancel runs
 *   staff.secrets.manage  (owner)        -> ai.provider.manage  providers, circuits, quotas, cache purge
 *
 * A global_mod (staff.console.access only) and everyone else is refused (403) and gets no session.
 * The staff claims are read from the sign-in token and kept on the session, which is short
 * (AI_CONSOLE_SESSION_TTL_MIN, 60 min); the mapping is applied again on every request.
 *
 * Writes go through the functions the admin API uses (server/ops.js, registry, quotas, runs), so each
 * writes the same audit_log row, with the person's subject as the actor. Every POST needs the
 * session's CSRF token and a same-origin request; refusals and sign-ins are audited as console.*.
 * Nothing starts when this module loads or when the router is built: no timer, no outbound call.
 */
const crypto = require('crypto');
const express = require('express');
const { AiError, resolveSecret } = require('../util');
const { CAPS } = require('../auth');
const { staff: staffMap } = require('openvibe-contracts');
const { createSessions, sameString, random } = require('./session');
const sso = require('./sso');
const q = require('./queries');
const { CSP, esc, pages } = require('./views');

/** Network staff capability -> AI capability held by a console session (documented in README "Operator console"). */
const STAFF_TO_AI = Object.freeze([
    ['staff.site.view', CAPS.usageRead],
    ['staff.ai.manage', CAPS.workflowManage],
    ['staff.secrets.manage', CAPS.providerManage],
]);

/** The AI capabilities these staff claims map to. */
function consoleCapabilities(staffClaims) {
    const out = [];
    for (const [s, ai] of STAFF_TO_AI) {
        let ok = false;
        try { ok = staffMap.can(staffClaims || {}, s); } catch { ok = false; }
        if (ok) out.push(ai);
    }
    return out;
}

/** Where to go after sign-in: a console page only; control characters and backslashes go home. */
function sanitizeNext(v) {
    // Browsers drop tab and newline characters from a URL and read a backslash as "/": "/<TAB>/evil.com"
    // would leave the site. A next with any control character or backslash goes home.
    if (typeof v === 'string' && /[\u0000-\u001f\u007f\\]/.test(v)) return '/console';
    const s = String(v || '');
    if (s.length > 300 || !/^\/console(?:$|[/?#])/.test(s)) return '/console';
    return s;
}

const NOTICES = {
    provider_status: 'Provider status changed.',
    circuit_reset: 'Circuit reset: the provider will be tried again.',
    version_status: 'Version status changed.',
    quota_saved: 'Quota saved.',
    cache_purged: 'Cache purged.',
    run_cancelled: 'Run cancelled.',
};
const DEF_KINDS = {
    routes: { one: 'route', list: 'listRoutes', get: 'getRoute' },
    templates: { one: 'template', list: 'listTemplates', get: 'getTemplate' },
    workflows: { one: 'workflow', list: 'listWorkflows', get: 'getWorkflow' },
};
const DAY_MS = 86400000;

function consoleRouter({ config, db, registry, pool, quotas, cache, runs, keys, ops, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console }) {
    const cc = config.console;
    const r = express.Router();
    const scoped = ['/console', '/auth'];
    const baseOrigin = (() => { try { return new URL(config.baseUrl).origin; } catch { return null; } })();

    let secret = resolveSecret(cc.sessionSecretRef, env);
    let unavailable = null;
    if (!secret || secret.length < 32) {
        if (config.isProduction) unavailable = 'AI_CONSOLE_SESSION_SECRET (at least 32 characters) is not set';
        else {
            secret = crypto.randomBytes(32).toString('hex');
            if (config.nodeEnv !== 'test') log.warn('[console] AI_CONSOLE_SESSION_SECRET unset: using an ephemeral secret (development only)');
        }
    }
    const clientSecret = () => resolveSecret(cc.clientSecretRef, env);
    if (!clientSecret()) unavailable = unavailable || 'OV_OAUTH_CLIENT_SECRET is not set';
    if (unavailable && config.nodeEnv !== 'test') log.warn(`[console] operator console disabled: ${unavailable}`);
    const sessions = createSessions({ db, config, clock, secret: secret || 'unavailable' });

    /** Every secret value this process can resolve, so that no page can ever carry one (belt and braces). */
    function secretValues() {
        const vals = new Set([clientSecret(), secret]);
        for (const p of registry.listProviders()) vals.add(resolveSecret(p.secret_ref, env));
        return [...vals].filter((v) => v && v.length >= 8);
    }
    function scrub(text) {
        let out = text;
        for (const v of secretValues()) for (const form of new Set([v, esc(v)])) out = out.split(form).join('[redacted]');
        return out;
    }
    const send = (res, status, text) => res.status(status).type('html').send(scrub(text));
    const who = (req) => ({ actor: req.staff.subject, trace: req.ov ? req.ov.traceId : null });
    const common = (req) => ({ staff: req.staff, csrf: req.staff ? req.staff.csrf : '' });
    const audit = (actor, action, targetType, targetId, metadata, req) => registry.audit(actor || 'anonymous', action, targetType, targetId, { trace: req && req.ov ? req.ov.traceId : null, metadata });
    const notice = (req) => {
        const base = NOTICES[req.query.done];
        if (!base) return null;
        return req.query.done === 'cache_purged' ? `${base} ${Number(req.query.removed) || 0} entr${Number(req.query.removed) === 1 ? 'y' : 'ies'} removed.` : base;
    };

    // ── Every console and sign-in response ───────────────────
    r.use(scoped, (req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', 'no-store');
        if (unavailable) return send(res, 503, pages.message({ title: 'Console unavailable', text: 'The operator console is not configured on this host. The operator must set its environment (see .env.example, "Operator console").' }));
        return next();
    });
    r.use(scoped, express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }));

    // ── Session -> req.staff ─────────────────────────────────
    r.use(scoped, (req, res, next) => {
        req.staff = null;
        const row = sessions.read(req);
        if (!row) return next();
        const caps = consoleCapabilities(row.staff);
        if (!caps.includes(CAPS.usageRead)) {
            sessions.revoke(row);
            sessions.clear(res);
            audit(row.subject, 'console.request.refused', 'console', 'session', { reason: 'the session no longer maps to ai.usage.read' }, req);
            return send(res, 403, pages.message({ title: 'Not authorized', text: 'Your account is not AI operator staff any more. The session was ended.' }));
        }
        req.staff = {
            subject: row.subject, username: row.username, role: staffMap.effectiveRole(row.staff), caps, csrf: row.csrf, session: row,
            principal: { sub: row.subject, subject: { type: 'user', id: row.subject }, cap: caps, claims: { sub: row.subject, cap: caps } },
        };
        return next();
    });

    /** Staff only, holding `cap` through STAFF_TO_AI. POSTs also need the CSRF token. */
    function needs(cap) {
        return (req, res, next) => {
            if (!req.staff) {
                if (req.method === 'GET') return send(res, 401, pages.signIn({ next: sanitizeNext(req.originalUrl) }));
                return send(res, 401, pages.signIn({ message: 'Your session has ended. Sign in again, then repeat the action.' }));
            }
            if (!req.staff.caps.includes(cap)) {
                if (req.method === 'POST') audit(req.staff.subject, 'console.request.refused', 'console', req.path, { reason: `needs ${cap}` }, req);
                return send(res, 403, pages.message({ title: 'Not authorized', text: `This needs ${cap}.`, ...common(req) }));
            }
            if (req.method === 'POST' && !csrfOk(req)) {
                audit(req.staff.subject, 'console.request.refused', 'console', req.path, { reason: 'missing or invalid CSRF token, or a cross-site request' }, req);
                return send(res, 403, pages.message({ title: 'Request refused', text: 'The form was stale or came from another site. Reload the page and try again.', ...common(req) }));
            }
            return next();
        };
    }
    function csrfOk(req) {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return false;
        const origin = req.headers.origin;
        if (origin && origin !== baseOrigin) return false;
        return sameString((req.body || {})._csrf, req.staff.csrf);
    }
    const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch((e) => {
        if (e instanceof AiError) return send(res, e.status >= 400 && e.status < 600 ? e.status : 400, pages.message({ title: 'Refused', text: `${e.detail || e.message} (${e.code})`, back: req.get('referer') && req.get('referer').startsWith(`${baseOrigin}/console`) ? req.get('referer') : '/console', ...common(req) }));
        log.error(`[console] ${req.method} ${req.path}: ${e && e.stack ? e.stack : e}`);
        if (!res.headersSent) send(res, 500, pages.message({ title: 'Error', text: 'Something went wrong. Nothing was changed unless the page says so; check the audit log.', ...common(req) }));
        return null;
    });
    const read = needs(CAPS.usageRead);

    // ── Sign-in ──────────────────────────────────────────────
    r.get('/auth/login', (req, res) => {
        const state = random(32);
        const { verifier, challenge } = sso.pkcePair();
        sessions.setFlow(res, { s: state, v: verifier, n: sanitizeNext(req.query.next) });
        res.redirect(302, sso.authorizeUrl(config, { state, challenge }));
    });

    r.get('/auth/callback', wrap(async (req, res) => {
        const flow = sessions.takeFlow(req, res);
        if (req.query.error) return send(res, 400, pages.signIn({ message: `Sign-in was not completed (${String(req.query.error).slice(0, 60)}).` }));
        if (!flow || !req.query.code || !sameString(req.query.state, flow.s)) {
            return send(res, 400, pages.signIn({ message: 'The sign-in could not be verified (expired or mismatched state). Please try again.' }));
        }
        let person;
        try {
            const publicKey = keys.get() || await keys.fetchOnce();
            if (!publicKey) throw new Error('the Network key is not loaded');
            person = await sso.exchange({ config, clientSecret: clientSecret(), code: req.query.code, verifier: flow.v, publicKey, now: clock.now(), fetchImpl });
        } catch (e) {
            log.warn(`[console] sign-in failed: ${e.message}`);
            return send(res, e.status && e.status < 500 ? 400 : 502, pages.signIn({ message: 'OpenVibe.Network did not confirm the sign-in. Please try again.' }));
        }
        const ipHash = sessions.ipHash(req.ip);
        if (person.error) {
            audit('anonymous', 'console.sign_in.refused', 'console', 'sign_in', { reason: person.error, ip_hash: ipHash }, req);
            return send(res, 403, pages.message({ title: 'Not authorized', text: 'This console is only for OpenVibe.Network staff. Your sign-in was recorded.' }));
        }
        const caps = consoleCapabilities(person.staff);
        const role = staffMap.effectiveRole(person.staff);
        if (!caps.includes(CAPS.usageRead)) {
            audit(person.subject, 'console.sign_in.refused', 'console', 'sign_in', { reason: `role ${role} does not hold staff.site.view`, role, ip_hash: ipHash }, req);
            return send(res, 403, pages.message({ title: 'Not authorized', text: 'This console is only for OpenVibe.Network staff (admins and the owner). Your sign-in was recorded.' }));
        }
        db.transaction(() => {
            sessions.create(res, { subject: person.subject, username: person.username, staff: person.staff, ip: req.ip });
            audit(person.subject, 'console.sign_in', 'console', 'sign_in', { role, capabilities: caps, ip_hash: ipHash }, req);
        })();
        return res.redirect(303, flow.n || '/console');
    }));

    r.post('/auth/logout', read, (req, res) => {
        db.transaction(() => {
            sessions.revoke(req.staff.session);
            audit(req.staff.subject, 'console.sign_out', 'console', 'sign_in', {}, req);
        })();
        sessions.clear(res);
        res.redirect(303, '/console');
    });

    // ── Overview ─────────────────────────────────────────────
    r.get('/console', read, wrap((req, res) => {
        const since = new Date(clock.now() - DAY_MS).toISOString();
        const st = ops.status();
        const problems = [];
        for (const p of registry.listProviders().filter((x) => x.status === 'active' && x.kind !== 'stub')) {
            const v = ops.providerView(p);
            if (v.credentials === 'missing') problems.push({ key: p.key, kind: p.kind, problem: `credentials missing (${p.secret_ref || 'no reference'})` });
            if (v.health && v.health.state !== 'closed') problems.push({ key: p.key, kind: p.kind, problem: `circuit ${v.health.state}` });
        }
        const stats = cache.stats();
        const frac = (c) => {
            const x = c.quota;
            return Math.max(x.max_requests ? c.used.requests / x.max_requests : 0, x.max_tokens ? c.used.tokens / x.max_tokens : 0, x.max_cost_usd ? c.used.cost_usd / x.max_cost_usd : 0);
        };
        send(res, 200, pages.overview({
            ...common(req), st, counts24: q.statusCounts(db, since), failures24: q.failures(db, since), queue: runs.stats(), problems,
            cacheTotals: { entries: stats.reduce((a, s) => a + s.entries, 0), hits: stats.reduce((a, s) => a + (s.hits || 0), 0) },
            stubFallback: config.stubFallback, topQuotas: [...st.quotas].sort((a, b) => frac(b) - frac(a)).slice(0, 10),
        }));
    }));

    // ── Providers ────────────────────────────────────────────
    r.get('/console/providers', read, wrap((req, res) => send(res, 200, pages.providers({
        ...common(req), rows: registry.listProviders().map(ops.providerView), models: registry.listModels(), stubFallback: config.stubFallback,
        canManage: req.staff.caps.includes(CAPS.providerManage), notice: notice(req),
    }))));
    r.post('/console/providers/:key/status', needs(CAPS.providerManage), wrap((req, res) => {
        ops.setProviderStatus(req.params.key, String(req.body.status || ''), who(req));
        res.redirect(303, '/console/providers?done=provider_status');
    }));
    r.post('/console/providers/:key/reset', needs(CAPS.providerManage), wrap((req, res) => {
        if (!registry.getProvider(req.params.key)) throw new AiError(404, 'ai.not_found', 'no such provider');
        ops.resetCircuit(req.params.key, who(req));
        res.redirect(303, '/console/providers?done=circuit_reset');
    }));

    // ── Routes, templates, workflows ─────────────────────────
    /** key -> the version runs use: the newest route version if active; the newest active template/workflow version. */
    function inUseMap(kind, history) {
        const m = new Map();
        const byKey = new Map();
        for (const x of history) { if (!byKey.has(x.key)) byKey.set(x.key, []); byKey.get(x.key).push(x); }
        for (const [key, list] of byKey) {
            const sorted = [...list].sort((a, b) => b.version - a.version);
            const v = kind === 'routes' ? (sorted[0].status === 'active' ? sorted[0].version : null) : ((sorted.find((x) => x.status === 'active') || {}).version || null);
            m.set(key, v);
        }
        return m;
    }
    for (const [kind, k] of Object.entries(DEF_KINDS)) {
        r.get(`/console/${kind}`, read, wrap((req, res) => send(res, 200, pages.definitions({
            ...common(req), kind, rows: registry[k.list](), inUse: inUseMap(kind, registry[k.list]({ history: true })),
        }))));
        r.get(`/console/${kind}/:key`, read, wrap((req, res) => {
            const versions = registry[k.list]({ history: true }).filter((x) => x.key === req.params.key).sort((a, b) => b.version - a.version);
            if (!versions.length) return send(res, 404, pages.message({ title: 'Not found', text: `No ${k.one} ${req.params.key}.`, back: `/console/${kind}`, ...common(req) }));
            const want = Number(req.query.version);
            const selected = (Number.isInteger(want) && versions.find((x) => x.version === want)) || versions[0];
            return send(res, 200, pages.definition({
                ...common(req), kind, key: req.params.key, versions, selected: registry[k.get](req.params.key, selected.version),
                inUse: inUseMap(kind, versions).get(req.params.key), canManage: req.staff.caps.includes(CAPS.workflowManage), notice: notice(req),
            }));
        }));
        r.post(`/console/${kind}/:key/versions/:version/status`, needs(CAPS.workflowManage), wrap((req, res) => {
            const version = Number(req.params.version);
            if (!Number.isInteger(version) || version < 1) throw new AiError(404, 'ai.not_found', `no ${k.one} ${req.params.key} v${req.params.version}`);
            registry.setStatus(k.one, req.params.key, version, String(req.body.status || ''), who(req));
            res.redirect(303, `/console/${kind}/${encodeURIComponent(req.params.key)}?version=${version}&done=version_status`);
        }));
    }

    // ── Runs ─────────────────────────────────────────────────
    r.get('/console/runs', read, wrap((req, res) => {
        const { filters, form, bad } = q.parseRunFilters(req.query);
        const list = q.listRuns(db, filters);
        send(res, bad.length ? 400 : 200, pages.runs({
            ...common(req), form, filters, bad, rows: list.rows, next: list.next, facets: q.runFacets(db),
            failures24: filters.status === 'failed' ? q.failures(db, new Date(clock.now() - DAY_MS).toISOString()) : [],
        }));
    }));
    r.get('/console/runs/:id', read, wrap((req, res) => {
        const run = runs.get(req.params.id);
        if (!run) return send(res, 404, pages.message({ title: 'Not found', text: `No run ${req.params.id}.`, back: '/console/runs', ...common(req) }));
        return send(res, 200, pages.run({
            ...common(req), r: run, citations: runs.citations(run.id), requests: runs.requestsFor(run.id), input: q.preview(run.input), output: q.preview(run.output),
            canCancel: req.staff.caps.includes(CAPS.workflowManage), notice: notice(req),
        }));
    }));
    r.post('/console/runs/:id/cancel', needs(CAPS.workflowManage), wrap((req, res) => {
        runs.cancel(req.params.id, req.staff.principal, { trace: req.ov ? req.ov.traceId : null, principalHas: (cap) => req.staff.caps.includes(cap) });
        res.redirect(303, `/console/runs/${encodeURIComponent(req.params.id)}?done=run_cancelled`);
    }));

    // ── Quotas and usage ─────────────────────────────────────
    const quotaPage = (req, res, status, extra = {}) => send(res, status, pages.quotas({
        ...common(req), counters: quotas.counters(), all: quotas.list(), canManage: req.staff.caps.includes(CAPS.providerManage), notice: notice(req), ...extra,
    }));
    r.get('/console/quotas', read, wrap((req, res) => quotaPage(req, res, 200)));
    r.post('/console/quotas', needs(CAPS.providerManage), wrap((req, res) => {
        const b = req.body || {};
        const form = {};
        for (const f of ['scope_type', 'scope_id', 'window', 'max_requests', 'max_tokens', 'max_cost_usd', 'workflow_prefix', 'status']) form[f] = String(b[f] == null ? '' : b[f]).trim().slice(0, 200);
        try {
            quotas.upsert({ ...form, scope_id: form.scope_id || (form.scope_type === 'global' ? '*' : ''), workflow_prefix: form.workflow_prefix || null, status: form.status || 'active' }, { ...who(req), origin: 'admin' });
        } catch (e) {
            if (!(e instanceof AiError)) throw e;
            return quotaPage(req, res, e.status, { error: `${e.detail || e.message} (${e.code})`, form, notice: null });
        }
        return res.redirect(303, '/console/quotas?done=quota_saved');
    }));
    r.get('/console/usage', read, wrap((req, res) => {
        const { filters, form, bad } = q.parseUsageFilters(req.query, clock.now());
        send(res, bad.length ? 400 : 200, pages.usage({ ...common(req), form, bad, report: q.usageReport(quotas, filters) }));
    }));

    // ── Cache ────────────────────────────────────────────────
    const cachePage = (req, res, status, extra = {}) => send(res, status, pages.cache({
        ...common(req), stats: cache.stats(), canManage: req.staff.caps.includes(CAPS.providerManage), notice: notice(req), ...extra,
    }));
    r.get('/console/cache', read, wrap((req, res) => cachePage(req, res, 200)));
    r.post('/console/cache/purge', needs(CAPS.providerManage), wrap((req, res) => {
        const workflow = String((req.body || {}).workflow || '').trim();
        if (workflow && !/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/.test(workflow)) return cachePage(req, res, 422, { error: 'that is not a workflow key', notice: null });
        if (!workflow && (req.body || {}).confirm_all !== 'yes') return cachePage(req, res, 422, { error: 'give a workflow key, or tick the box to purge every entry', notice: null });
        const removed = ops.purgeCache(workflow || null, who(req));
        return res.redirect(303, `/console/cache?done=cache_purged&removed=${removed}`);
    }));

    // ── Audit ────────────────────────────────────────────────
    r.get('/console/audit', read, wrap((req, res) => {
        const { filters, form, bad } = q.parseAuditFilters(req.query);
        const page = q.listAudit(db, filters);
        send(res, bad.length ? 400 : 200, pages.audit({ ...common(req), form, bad, rows: page.rows, next: page.next, names: q.usernames(db), kinds: q.AUDIT_KINDS }));
    }));

    // Anything else under /console or /auth: the sign-in page, or (signed in) the console's own not-found page.
    r.all(['/console/*', '/auth/*'], (req, res) => {
        if (!req.staff) return send(res, 401, pages.signIn({ next: req.method === 'GET' ? sanitizeNext(req.originalUrl) : '/console' }));
        return send(res, 404, pages.message({ title: 'Not found', text: 'There is no such console page.', ...common(req) }));
    });

    return r;
}

module.exports = { consoleRouter, consoleCapabilities, sanitizeNext, STAFF_TO_AI };
