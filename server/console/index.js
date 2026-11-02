'use strict';
/**
 * The AI operator console (roadmap WS-O task 4): server-rendered, no JavaScript, on
 * ai.openvibe.services under /console, for OpenVibe.Network staff.
 *
 *   GET  /auth/login, /auth/callback     Network SSO (authorization code + PKCE S256, OAuth client `ai`)
 *   GET  /auth/person/login              the same sign-in for any person, for their run receipt page
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
 *   GET  /console/usage[?from&to&requester]      (quotas.usage; free allowance this period, quotas.freeAllowance.current;
 *                                                  Billing readings by delivery state, usage-samples deliveryReport)
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
const usageSamples = require('../usage-samples');
const { CAPS } = require('../auth');
const { staff: staffMap } = require('openvibe-contracts');
const { createSessions, sameString, random } = require('./session');
const sso = require('./sso');
const q = require('./queries');
const catalog = require('../providers/catalog');
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

/** Where to go after a person signs in for a run receipt: exactly one /runs/run_<ULID> page; anything else goes home. */
function sanitizeRunNext(v) {
    if (typeof v === 'string' && /[\u0000-\u001f\u007f\\]/.test(v)) return '/';
    const s = String(v || '');
    return s.length <= 300 && /^\/runs\/run_[0-9A-HJKMNP-TV-Z]{26}$/.test(s) ? s : '/';
}

const NOTICES = {
    provider_status: 'Provider status changed.',
    provider_added: 'Provider added. Point a route at it below, or on the route\'s page.',
    provider_key: 'Key replaced. Runs use it from now on.',
    model_added: 'Model registered.',
    models_synced: 'Model list read. New models are listed switched off: turn on the ones routes may use.',
    model_status: 'Model switched.',
    route_used: 'Route changed: new runs use the provider and model you chose (the previous one is kept as a fallback).',
    route_default: 'Route back to its default.',
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

function consoleRouter({ config, db, registry, pool, quotas, cache, runs, ops, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, vault = null, personSessions = null }) {
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
    async function secretValues() {
        const vals = new Set([clientSecret(), secret]);
        for (const p of await registry.listProviders()) vals.add(resolveSecret(p.secret_ref, env));
        return [...vals].filter((v) => v && v.length >= 8);
    }
    async function scrub(text) {
        let out = text;
        for (const v of await secretValues()) for (const form of new Set([v, esc(v)])) out = out.split(form).join('[redacted]');
        return out;
    }
    const send = async (res, status, text) => res.status(status).type('html').send(await scrub(text));
    const who = (req) => ({ actor: req.staff.subject, trace: req.ov ? req.ov.traceId : null });
    const common = (req) => ({ staff: req.staff, csrf: req.staff ? req.staff.csrf : '' });
    const audit = async (actor, action, targetType, targetId, metadata, req) => await registry.audit(actor || 'anonymous', action, targetType, targetId, { trace: req && req.ov ? req.ov.traceId : null, metadata });
    const notice = (req) => {
        const base = NOTICES[req.query.done];
        if (!base) return null;
        return req.query.done === 'cache_purged' ? `${base} ${Number(req.query.removed) || 0} entr${Number(req.query.removed) === 1 ? 'y' : 'ies'} removed.` : base;
    };

    // ── Every console and sign-in response ───────────────────
    r.use(scoped, async (req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', 'no-store');
        if (unavailable) return await send(res, 503, pages.message({ title: 'Console unavailable', text: 'The operator console is not configured on this host. The operator must set its environment (see .env.example, "Operator console").' }));
        return next();
    });
    r.use(scoped, express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }));

    // ── Session -> req.staff ─────────────────────────────────
    r.use(scoped, async (req, res, next) => {
        req.staff = null;
        const row = await sessions.read(req);
        if (!row) return next();
        const caps = consoleCapabilities(row.staff);
        if (!caps.includes(CAPS.usageRead)) {
            await sessions.revoke(row);
            sessions.clear(res);
            await audit(row.subject, 'console.request.refused', 'console', 'session', { reason: 'the session no longer maps to ai.usage.read' }, req);
            return await send(res, 403, pages.message({ title: 'Not authorized', text: 'Your account is not AI operator staff any more. The session was ended.' }));
        }
        req.staff = {
            subject: row.subject, username: row.username, role: staffMap.effectiveRole(row.staff), caps, csrf: row.csrf, session: row,
            principal: { sub: row.subject, subject: { type: 'user', id: row.subject }, cap: caps, claims: { sub: row.subject, cap: caps } },
        };
        return next();
    });

    /** Staff only, holding `cap` through STAFF_TO_AI. POSTs also need the CSRF token. */
    function needs(cap) {
        return async (req, res, next) => {
            if (!req.staff) {
                if (req.method === 'GET') return await send(res, 401, pages.signIn({ next: sanitizeNext(req.originalUrl) }));
                return await send(res, 401, pages.signIn({ message: 'Your session has ended. Sign in again, then repeat the action.' }));
            }
            if (!req.staff.caps.includes(cap)) {
                if (req.method === 'POST') await audit(req.staff.subject, 'console.request.refused', 'console', req.path, { reason: `needs ${cap}` }, req);
                return await send(res, 403, pages.message({ title: 'Not authorized', text: `This needs ${cap}.`, ...common(req) }));
            }
            if (req.method === 'POST' && !csrfOk(req)) {
                await audit(req.staff.subject, 'console.request.refused', 'console', req.path, { reason: 'missing or invalid CSRF token, or a cross-site request' }, req);
                return await send(res, 403, pages.message({ title: 'Request refused', text: 'The form was stale or came from another site. Reload the page and try again.', ...common(req) }));
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
    const wrap = (fn) => (req, res, next) => Promise.resolve().then(async () => await fn(req, res, next)).catch(async (e) => {
        if (e instanceof AiError) return await send(res, e.status >= 400 && e.status < 600 ? e.status : 400, pages.message({ title: 'Refused', text: `${e.detail || e.message} (${e.code})`, back: req.get('referer') && req.get('referer').startsWith(`${baseOrigin}/console`) ? req.get('referer') : '/console', ...common(req) }));
        log.error(`[console] ${req.method} ${req.path}: ${e && e.stack ? e.stack : e}`);
        if (!res.headersSent) await send(res, 500, pages.message({ title: 'Error', text: 'Something went wrong. Nothing was changed unless the page says so; check the audit log.', ...common(req) }));
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

    // A person's sign-in for one run receipt. It uses the same OAuth client and redirect URI, but the
    // flow cookie says which callback branch to take, so a non-staff person never receives a staff session.
    r.get('/auth/person/login', (req, res) => {
        const state = random(32);
        const { verifier, challenge } = sso.pkcePair();
        sessions.setFlow(res, { s: state, v: verifier, n: sanitizeRunNext(req.query.next), kind: 'person' });
        res.redirect(302, sso.authorizeUrl(config, { state, challenge }));
    });

    r.get('/auth/callback', wrap(async (req, res) => {
        const flow = sessions.takeFlow(req, res);
        const personFlow = flow && flow.kind === 'person';
        if (req.query.error) {
            const text = `Sign-in was not completed (${String(req.query.error).slice(0, 60)}).`;
            return await send(res, 400, personFlow ? pages.message({ title: 'Sign-in not completed', text, back: '/', site: 'your runs' }) : pages.signIn({ message: text }));
        }
        if (!flow || !req.query.code || !sameString(req.query.state, flow.s)) {
            const text = 'The sign-in could not be verified (expired or mismatched state). Please try again.';
            return await send(res, 400, personFlow ? pages.message({ title: 'Sign-in not verified', text, back: '/', site: 'your runs' }) : pages.signIn({ message: text }));
        }
        let person;
        try {
            person = await sso.exchange({ config, clientSecret: clientSecret(), code: req.query.code, verifier: flow.v, now: clock.now(), fetchImpl, log });
        } catch (e) {
            log.warn(`[console] sign-in failed: ${e.message}`);
            const text = 'OpenVibe.Network did not confirm the sign-in. Please try again.';
            return await send(res, e.status && e.status < 500 ? 400 : 502, personFlow ? pages.message({ title: 'Sign-in failed', text, back: '/', site: 'your runs' }) : pages.signIn({ message: text }));
        }
        const ipHash = sessions.ipHash(req.ip);
        if (flow.kind === 'person') {
            if (!personSessions) return await send(res, 503, pages.message({ title: 'Sign-in unavailable', text: 'The run page sign-in is not configured on this host.', back: '/', site: 'your runs' }));
            if (person.error) {
                await audit('anonymous', 'run_page.sign_in.refused', 'run_page', 'sign_in', { reason: person.error, ip_hash: ipHash }, req);
                return await send(res, 403, pages.message({ title: 'Not authorized', text: 'This page needs an OpenVibe.Network person account. Your sign-in was recorded.', back: '/', site: 'your runs' }));
            }
            await db.tx(async () => {
                await personSessions.create(res, { subject: person.subject, username: person.username });
                await audit(person.subject, 'run_page.sign_in', 'run_page', 'sign_in', { ip_hash: ipHash }, req);
            });
            return res.redirect(303, flow.n || '/');
        }
        if (person.error) {
            await audit('anonymous', 'console.sign_in.refused', 'console', 'sign_in', { reason: person.error, ip_hash: ipHash }, req);
            return await send(res, 403, pages.message({ title: 'Not authorized', text: 'This console is only for OpenVibe.Network staff. Your sign-in was recorded.' }));
        }
        const caps = consoleCapabilities(person.staff);
        const role = staffMap.effectiveRole(person.staff);
        if (!caps.includes(CAPS.usageRead)) {
            await audit(person.subject, 'console.sign_in.refused', 'console', 'sign_in', { reason: `role ${role} does not hold staff.site.view`, role, ip_hash: ipHash }, req);
            return await send(res, 403, pages.message({ title: 'Not authorized', text: 'This console is only for OpenVibe.Network staff (admins and the owner). Your sign-in was recorded.' }));
        }
        await db.tx(async () => {
            await sessions.create(res, { subject: person.subject, username: person.username, staff: person.staff, ip: req.ip });
            await audit(person.subject, 'console.sign_in', 'console', 'sign_in', { role, capabilities: caps, ip_hash: ipHash }, req);
        });
        return res.redirect(303, flow.n || '/console');
    }));

    r.post('/auth/logout', read, async (req, res) => {
        await db.tx(async () => {
            await sessions.revoke(req.staff.session);
            await audit(req.staff.subject, 'console.sign_out', 'console', 'sign_in', {}, req);
        });
        sessions.clear(res);
        res.redirect(303, '/console');
    });

    // ── Overview ─────────────────────────────────────────────
    r.get('/console', read, wrap(async (req, res) => {
        const since = new Date(clock.now() - DAY_MS).toISOString();
        const st = await ops.status();
        const problems = [];
        for (const p of (await registry.listProviders()).filter((x) => x.status === 'active' && x.kind !== 'stub')) {
            const v = await ops.providerView(p);
            if (v.credentials === 'missing') problems.push({ key: p.key, kind: p.kind, problem: `credentials missing (${p.secret_ref || 'no reference'})` });
            if (v.health && v.health.state !== 'closed') problems.push({ key: p.key, kind: p.kind, problem: `circuit ${v.health.state}` });
        }
        const stats = await cache.stats();
        const frac = (c) => {
            const x = c.quota;
            return Math.max(x.max_requests ? c.used.requests / x.max_requests : 0, x.max_tokens ? c.used.tokens / x.max_tokens : 0, x.max_cost_usd ? c.used.cost_usd / x.max_cost_usd : 0);
        };
        await send(res, 200, pages.overview({
            ...common(req), st, counts24: await q.statusCounts(db, since), failures24: await q.failures(db, since), queue: runs.stats(), problems,
            cacheTotals: { entries: stats.reduce((a, s) => a + s.entries, 0), hits: stats.reduce((a, s) => a + (s.hits || 0), 0) },
            stubFallback: config.stubFallback, topQuotas: [...st.quotas].sort((a, b) => frac(b) - frac(a)).slice(0, 10),
        }));
    }));

    // ── Providers ────────────────────────────────────────────
    r.get('/console/providers', read, wrap(async (req, res) => await send(res, 200, pages.providers({
        ...common(req), rows: (await Promise.all((await registry.listProviders()).map(ops.providerView))), models: await registry.listModels(), stubFallback: config.stubFallback,
        canManage: req.staff.caps.includes(CAPS.providerManage), notice: notice(req), keyHints: vault ? await vault.hints() : new Map(),
    }))));
    r.post('/console/providers/:key/status', needs(CAPS.providerManage), wrap(async (req, res) => {
        await ops.setProviderStatus(req.params.key, String(req.body.status || ''), who(req));
        res.redirect(303, '/console/providers?done=provider_status');
    }));
    r.post('/console/providers/:key/reset', needs(CAPS.providerManage), wrap(async (req, res) => {
        if (!await registry.getProvider(req.params.key)) throw new AiError(404, 'ai.not_found', 'no such provider');
        await ops.resetCircuit(req.params.key, who(req));
        res.redirect(303, '/console/providers?done=circuit_reset');
    }));

    // Adding a provider with its key, replacing a key, registering a model (owner: ai.provider.manage). The key goes to
    // the vault (server/vault.js, encrypted at rest); the provider's secret_ref names it, never holds it.
    const presets = require('./presets');
    const KEY_RE = /^[a-z0-9][a-z0-9._-]{1,40}$/;
    r.get('/console/providers/new', needs(CAPS.providerManage), wrap(async (req, res) => await send(res, 200, pages.providerNew({
        ...common(req), presets: presets.PRESETS, preset: presets.byId(String(req.query.preset || '')) || null, vaultReady: !!vault && /^[0-9a-f]{64}$/i.test(String(config.credentialsKey || '')),
    }))));
    r.post('/console/providers', needs(CAPS.providerManage), wrap(async (req, res) => {
        if (!vault) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be stored here');
        const b = req.body || {};
        const preset = presets.byId(String(b.preset || 'custom')) || presets.byId('custom');
        const key = String(b.key || preset.id).trim().toLowerCase();
        if (!KEY_RE.test(key)) throw new AiError(422, 'ai.invalid', 'the provider name is 2-41 lowercase letters, digits, dots and dashes');
        if (await registry.getProvider(key)) throw new AiError(409, 'ai.conflict', `a provider called ${key} already exists: replace its key on the providers page`);
        const baseUrl = String(b.base_url || preset.base_url || '').trim();
        if (!/^https:\/\/[^\s]+$/i.test(baseUrl)) throw new AiError(422, 'ai.invalid', 'the base URL is an https address');
        await vault.put(key, b.api_key, who(req));
        const caps = [...presets.TEXT_CAPS, ...(b.vision ? ['vision'] : [])];
        await registry.upsertProvider({
            key, display_name: String(b.display_name || preset.name || key).slice(0, 80), kind: preset.kind, status: 'active', base_url: baseUrl.replace(/\/+$/, ''),
            auth_mode: preset.kind === 'anthropic' ? 'x-api-key' : 'bearer', secret_ref: `vault:${key}`, default_model: String(b.default_model || preset.model || '').trim() || null,
            capabilities: caps, timeout_ms: 60000, priority: 50, billing_profile: 'metered', metadata: { added_from: 'console', preset: preset.id },
        }, { ...who(req), origin: 'admin' });
        // Its model list, read right away (best effort: a provider whose list cannot be read is still added).
        const added = await registry.getProvider(key);
        await catalog.sync({ registry, provider: added, apiKey: resolveSecret(added.secret_ref, env), fetchImpl, actor: who(req).actor }).catch(() => null);
        res.redirect(303, '/console/providers?done=provider_added');
    }));
    r.post('/console/providers/:key/key', needs(CAPS.providerManage), wrap(async (req, res) => {
        if (!vault) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be stored here');
        const p = await registry.getProvider(req.params.key);
        if (!p) throw new AiError(404, 'ai.not_found', 'no such provider');
        await vault.put(p.key, (req.body || {}).api_key, who(req));
        if (p.secret_ref !== `vault:${p.key}`) await registry.upsertProvider({ key: p.key, secret_ref: `vault:${p.key}` }, { ...who(req), origin: 'admin' });
        else await registry.upsertProvider({ key: p.key }, { ...who(req), origin: 'admin' });   // a new updated_at: the pool rebuilds its adapter
        await registry.audit(who(req).actor, 'provider.key_replaced', 'provider', p.key, { trace: who(req).trace });
        res.redirect(303, '/console/providers?done=provider_key');
    }));
    // Read the provider's own model list into the catalogue (L33): new models land switched off, prices stay a person's.
    r.post('/console/providers/:key/sync', needs(CAPS.providerManage), wrap(async (req, res) => {
        const p = await registry.getProvider(req.params.key);
        if (!p) throw new AiError(404, 'ai.not_found', 'no such provider');
        const apiKey = resolveSecret(p.secret_ref, env);
        if (!apiKey && p.auth_mode !== 'none') throw new AiError(422, 'ai.invalid', `${p.key} has no key to read its model list with`);
        const out = await catalog.sync({ registry, provider: p, apiKey, fetchImpl, actor: who(req).actor });
        await registry.audit(who(req).actor, 'provider.models_synced', 'provider', p.key, { trace: who(req).trace, metadata: { added: out.added.length, updated: out.updated.length, missing: out.missing.length } });
        res.redirect(303, '/console/providers?done=models_synced');
    }));
    // Turn one model on or off (a model routes may use, or not).
    r.post('/console/models/:provider/:model/status', needs(CAPS.providerManage), wrap(async (req, res) => {
        const m = await registry.getModel(req.params.provider, req.params.model);
        if (!m) throw new AiError(404, 'ai.not_found', 'no such model');
        const status = (req.body || {}).status === 'active' ? 'active' : 'disabled';
        await registry.upsertModel({ provider_key: m.provider_key, model_key: m.model_key, status }, who(req));
        res.redirect(303, '/console/providers?done=model_status');
    }));
    r.post('/console/providers/:key/models', needs(CAPS.providerManage), wrap(async (req, res) => {
        const p = await registry.getProvider(req.params.key);
        if (!p) throw new AiError(404, 'ai.not_found', 'no such provider');
        const b = req.body || {};
        const price = (v) => (v === '' || v == null ? undefined : Number(v));
        const source = String(b.price_source || '').trim();
        if (source && !/^https:\/\/[^\s]+$/.test(source)) throw new AiError(422, 'ai.invalid', 'the price source is the provider\'s https price page');
        if ((price(b.cost_in) != null || price(b.cost_out) != null) && !source) throw new AiError(422, 'ai.invalid', 'name the price page the prices come from');
        await registry.upsertModel({
            provider_key: p.key, model_key: String(b.model_key || '').trim(), display_name: String(b.display_name || '').trim() || null, type: 'chat',
            supports: { json: true, vision: !!b.vision, tools: !!b.tools, streaming: true },
            // Prices are the person's, typed from the provider's own price page (which they name), checked today.
            // The cache prices are optional (L40): nobody typed them means the record says 'no cache price' and the
            // cache tokens are priced at the plain input price.
            ...(price(b.cost_in) != null || price(b.cost_out) != null ? { cost: { in_per_mtok: price(b.cost_in) ?? null, out_per_mtok: price(b.cost_out) ?? null, cached_per_mtok: price(b.cost_cache_read) ?? null, cache_write_per_mtok: price(b.cost_cache_write) ?? null, ...(source ? { source, verified_at: new Date(clock.now()).toISOString().slice(0, 10) } : {}) } } : {}),
        }, who(req));
        res.redirect(303, '/console/providers?done=model_added');
    }));
    // Which provider and model a route uses (owner: it changes what OpenVibe spends). A new route version with the
    // choice as its primary and the route's previous primary as the first fallback; "default" goes back to what the
    // service seeds (the newest version the seed wrote, as a new version).
    r.post('/console/routes/:key/use', needs(CAPS.providerManage), wrap(async (req, res) => {
        const route = await registry.getRoute(req.params.key);
        if (!route) throw new AiError(404, 'ai.not_found', 'no such route');
        const b = req.body || {};
        if (b.default === '1') {
            const seeded = (await registry.listRoutes({ history: true })).filter((x) => x.key === route.key && x.created_by === 'seed').sort((a, c) => c.version - a.version)[0];
            if (!seeded) throw new AiError(409, 'ai.conflict', 'this route has no default to go back to');
            const { version, created_by, created_at, key: _k, ...def } = seeded;
            await registry.createRouteVersion(route.key, { ...def, status: 'active' }, who(req));
            return res.redirect(303, `/console/routes/${encodeURIComponent(route.key)}?done=route_default`);
        }
        const [provider, model] = String(b.target || '').split('|');
        const p = await registry.getProvider(provider || '');
        if (!p) throw new AiError(422, 'ai.invalid', 'choose a provider');
        const effective = route.alias_of ? await registry.resolveRoute(route.key) : route;
        const previous = effective && effective.primary && effective.primary.provider && !(effective.primary.provider === p.key && (effective.primary.model || null) === (model || null)) ? [{ provider: effective.primary.provider, model: effective.primary.model || null }] : [];
        await registry.createRouteVersion(route.key, {
            primary: { provider: p.key, model: model || p.default_model || null }, fallbacks: previous, capability: null, constraints: {}, pinned: [], alias_of: null,
            options: (effective && effective.options) || {}, max_output_tokens: effective ? effective.max_output_tokens : null,
            response_format: (effective && effective.response_format) || 'text', timeout_ms: effective ? effective.timeout_ms : null, status: 'active',
            learn_from_bench: Boolean(effective && effective.learn_from_bench),
            bench_kind: (effective && effective.bench_kind) || null, bench_category: (effective && effective.bench_category) || null,
        }, who(req));
        res.redirect(303, `/console/routes/${encodeURIComponent(route.key)}?done=route_used`);
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
        r.get(`/console/${kind}`, read, wrap(async (req, res) => await send(res, 200, pages.definitions({
            ...common(req), kind, rows: await registry[k.list](), inUse: inUseMap(kind, await registry[k.list]({ history: true })),
        }))));
        r.get(`/console/${kind}/:key`, read, wrap(async (req, res) => {
            const versions = (await registry[k.list]({ history: true })).filter((x) => x.key === req.params.key).sort((a, b) => b.version - a.version);
            if (!versions.length) return await send(res, 404, pages.message({ title: 'Not found', text: `No ${k.one} ${req.params.key}.`, back: `/console/${kind}`, ...common(req) }));
            const want = Number(req.query.version);
            const selected = (Number.isInteger(want) && versions.find((x) => x.version === want)) || versions[0];
            const current = await registry[k.get](req.params.key, selected.version);
            // BENCH-11: read-only evidence on a route's page. It changes what runs pick, so it is shown with
            // the leader, the tied offers and the reason; it is not editable here (bench_kind is an API field).
            let bench = null;
            if (kind === 'routes' && current.status === 'active' && pool.benchView) {
                try {
                    const target = current.alias_of ? await registry.resolveRoute(current.key) : current;
                    if (target && target.status === 'active') bench = await pool.benchView(target, target.capability || 'chat');
                } catch (err) {
                    log.warn(`[console] bench evidence for route ${current.key}: ${err.message}`);
                }
            }
            return await send(res, 200, pages.definition({
                ...common(req), kind, key: req.params.key, versions, selected: current, bench,
                inUse: inUseMap(kind, versions).get(req.params.key), canManage: req.staff.caps.includes(CAPS.workflowManage), notice: notice(req),
                ...(kind === 'routes' ? { canChoose: req.staff.caps.includes(CAPS.providerManage), providers: (await registry.listProviders()).filter((p) => p.status === 'active' && p.kind !== 'whisper' && p.kind !== 'stub'), models: await registry.listModels() } : {}),
            }));
        }));
        r.post(`/console/${kind}/:key/versions/:version/status`, needs(CAPS.workflowManage), wrap(async (req, res) => {
            const version = Number(req.params.version);
            if (!Number.isInteger(version) || version < 1) throw new AiError(404, 'ai.not_found', `no ${k.one} ${req.params.key} v${req.params.version}`);
            await registry.setStatus(k.one, req.params.key, version, String(req.body.status || ''), who(req));
            res.redirect(303, `/console/${kind}/${encodeURIComponent(req.params.key)}?version=${version}&done=version_status`);
        }));
    }

    // ── Runs ─────────────────────────────────────────────────
    r.get('/console/runs', read, wrap(async (req, res) => {
        const { filters, form, bad } = q.parseRunFilters(req.query);
        const list = await q.listRuns(db, filters);
        await send(res, bad.length ? 400 : 200, pages.runs({
            ...common(req), form, filters, bad, rows: list.rows, next: list.next, facets: await q.runFacets(db),
            failures24: filters.status === 'failed' ? await q.failures(db, new Date(clock.now() - DAY_MS).toISOString()) : [],
        }));
    }));
    r.get('/console/runs/:id', read, wrap(async (req, res) => {
        const run = await runs.explained(await runs.get(req.params.id));
        if (!run) return await send(res, 404, pages.message({ title: 'Not found', text: `No run ${req.params.id}.`, back: '/console/runs', ...common(req) }));
        return await send(res, 200, pages.run({
            ...common(req), r: run, citations: await runs.citations(run.id), requests: await runs.requestsFor(run.id), input: q.preview(run.input), output: q.preview(run.output),
            canCancel: req.staff.caps.includes(CAPS.workflowManage), notice: notice(req),
        }));
    }));
    r.post('/console/runs/:id/cancel', needs(CAPS.workflowManage), wrap(async (req, res) => {
        await runs.cancel(req.params.id, req.staff.principal, { trace: req.ov ? req.ov.traceId : null, principalHas: (cap) => req.staff.caps.includes(cap) });
        res.redirect(303, `/console/runs/${encodeURIComponent(req.params.id)}?done=run_cancelled`);
    }));

    // ── Quotas and usage ─────────────────────────────────────
    const quotaPage = async (req, res, status, extra = {}) => await send(res, status, pages.quotas({
        ...common(req), counters: await quotas.counters(), all: await quotas.list(), canManage: req.staff.caps.includes(CAPS.providerManage), notice: notice(req), ...extra,
    }));
    r.get('/console/quotas', read, wrap(async (req, res) => await quotaPage(req, res, 200)));
    r.post('/console/quotas', needs(CAPS.providerManage), wrap(async (req, res) => {
        const b = req.body || {};
        const form = {};
        for (const f of ['scope_type', 'scope_id', 'window', 'max_requests', 'max_tokens', 'max_cost_usd', 'workflow_prefix', 'status']) form[f] = String(b[f] == null ? '' : b[f]).trim().slice(0, 200);
        try {
            await quotas.upsert({ ...form, scope_id: form.scope_id || (form.scope_type === 'global' ? '*' : ''), workflow_prefix: form.workflow_prefix || null, status: form.status || 'active' }, { ...who(req), origin: 'admin' });
        } catch (e) {
            if (!(e instanceof AiError)) throw e;
            return await quotaPage(req, res, e.status, { error: `${e.detail || e.message} (${e.code})`, form, notice: null });
        }
        return res.redirect(303, '/console/quotas?done=quota_saved');
    }));
    r.get('/console/usage', read, wrap(async (req, res) => {
        const { filters, form, bad } = q.parseUsageFilters(req.query, clock.now());
        await send(res, bad.length ? 400 : 200, pages.usage({
            ...common(req), form, bad, report: await q.usageReport(quotas, filters),
            free: quotas.freeAllowance ? await quotas.freeAllowance.current() : [], readings: await usageSamples.deliveryReport(db),
        }));
    }));

    // ── Cache ────────────────────────────────────────────────
    const cachePage = async (req, res, status, extra = {}) => await send(res, status, pages.cache({
        ...common(req), stats: await cache.stats(), canManage: req.staff.caps.includes(CAPS.providerManage), notice: notice(req), ...extra,
    }));
    r.get('/console/cache', read, wrap(async (req, res) => await cachePage(req, res, 200)));
    r.post('/console/cache/purge', needs(CAPS.providerManage), wrap(async (req, res) => {
        const workflow = String((req.body || {}).workflow || '').trim();
        if (workflow && !/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/.test(workflow)) return await cachePage(req, res, 422, { error: 'that is not a workflow key', notice: null });
        if (!workflow && (req.body || {}).confirm_all !== 'yes') return await cachePage(req, res, 422, { error: 'give a workflow key, or tick the box to purge every entry', notice: null });
        const removed = await ops.purgeCache(workflow || null, who(req));
        return res.redirect(303, `/console/cache?done=cache_purged&removed=${removed}`);
    }));

    // ── Audit ────────────────────────────────────────────────
    r.get('/console/audit', read, wrap(async (req, res) => {
        const { filters, form, bad } = q.parseAuditFilters(req.query);
        const page = await q.listAudit(db, filters);
        await send(res, bad.length ? 400 : 200, pages.audit({ ...common(req), form, bad, rows: page.rows, next: page.next, names: await q.usernames(db), kinds: q.AUDIT_KINDS }));
    }));

    // Anything else under /console or /auth: the sign-in page, or (signed in) the console's own not-found page.
    r.all(['/console/*', '/auth/*'], async (req, res) => {
        if (!req.staff) return await send(res, 401, pages.signIn({ next: req.method === 'GET' ? sanitizeNext(req.originalUrl) : '/console' }));
        return await send(res, 404, pages.message({ title: 'Not found', text: 'There is no such console page.', ...common(req) }));
    });

    return r;
}

module.exports = { consoleRouter, consoleCapabilities, sanitizeNext, sanitizeRunNext, STAFF_TO_AI };
