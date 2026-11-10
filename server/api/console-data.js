'use strict';

const express = require('express');
const q = require('../console/queries');
const { CAPS } = require('../auth');
const { AiError, providerSecret } = require('../util');
const providerPresets = require('../console/presets');
const providerCatalog = require('../providers/catalog');
const poolSeed = require('../providers/pool-seed');
const gpuCatalog = require('../gpu/catalog');
const { tokenCosts } = require('../gpu/token-cost');

/** Read-only JSON read models for Exchange's owner console. Every query is bounded and the query module redacts runs. */
function consoleDataRouter({ db, registry, pool, quotas, cache, runs, ops, auth, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, gpus = null, gpuMarket = null, abuse = null, priceBook = null, modelSync = null, creditGrants = null, sessionCookies = null, vault = null, settings = null, config = {}, log = console }) {
    const r = express.Router();
    const supply = require('../platform/supply').createSupply({ db, registry, clock });
    const ownerConfig = require('../owner-config').createOwnerConfig({ db, registry, clock });
    // The public marketplace readings and the per-token cost they imply, added to both console sections. Data only:
    // Exchange renders it with its existing console classes.
    const marketPayload = async () => {
        if (!gpuMarket) return { market: null, token_costs: [] };
        const market = await gpuMarket.report();
        return { market, token_costs: tokenCosts({ market, models: await registry.listModels(), catalog: gpuCatalog }) };
    };
    const json = express.json({ limit: '64kb' });
    const read = auth.requireCap(CAPS.usageRead);
    const write = auth.requireCap(CAPS.providerManage);
    const workflowWrite = auth.requireCap(CAPS.workflowManage);
    const modelView = (m, provider) => ({ ...m, provider: m.provider_key, model: m.model_key, accepted_price: m.cost,
        content_tier: require('../providers/pool-providers').isUncensored(provider, m) ? 'uncensored' : 'standard',
        owner_override: m.metadata?.owner_override || null });
    const actor = (req) => {
        const subject = String(req.get('x-ov-subject') || '');
        return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject) ? subject : req.principal.sub;
    };
    const wrap = (fn) => async (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(await fn(req)); }
        catch (err) { log.error(`[console-json] ${req.method} ${req.path} failed (${err && err.code || 'ai.internal'})`); res.status(err.status || 500).json({ error: 'AI admin data is unavailable.', code: err.code || 'ai.internal' }); }
    };
    r.get('/api/v1/admin/console/:section', read, wrap(async (req) => {
        const section = req.params.section;
        if (section === 'supply') return { ...await supply.report(), ...await marketPayload() };
        if (section === 'overview') {
            const since = new Date(clock.now() - 86400000).toISOString();
            return { status: await ops.status(), counts24: await q.statusCounts(db, since), failures24: await q.failures(db, since), queue: runs.stats(), cache: await cache.stats() };
        }
        if (section === 'providers') {
            const hints = vault && vault.hints ? await vault.hints() : new Map();
            const rows = (await Promise.all((await registry.listProviders()).map(ops.providerView))).map((p) => ({
                ...p, key_present: p.credentials === 'configured', preference_order: p.priority,
                key_state: p.auth_mode === 'none' ? { source: 'not_required', hint: null, set_at: null }
                    : { source: hints.has(p.key) ? 'stored' : p.credentials === 'configured' ? 'environment' : 'missing',
                        hint: hints.get(p.key)?.hint || (providerSecret(p, env) ? `…${providerSecret(p, env).slice(-4)}` : null),
                        set_at: hints.get(p.key)?.updated_at || null },
                last_check: p.metadata?.last_check || null,
                markup_percent: Number(p.metadata && p.metadata.markup_percent) || 0,
                uncensored: Boolean(p.metadata && p.metadata.uncensored),
            }));
            const poolProviders = require('../providers/pool-providers').PROVIDERS;
            const estimates = creditGrants ? await Promise.all(['anthropic', 'openai'].map(async (provider) => ({
                provider, grants: await creditGrants.list(provider), estimate: creditGrants.values().find((x) => x.provider === provider) || null,
                preference: await creditGrants.preference(provider),
            }))) : [];
            const cookies = sessionCookies ? await sessionCookies.list('operator', 'owner') : [];
            const balances = sessionCookies ? await Promise.all(cookies.map((c) => sessionCookies.balance('operator', 'owner', c.id))) : [];
            return { providers: rows, models: (await registry.listModels()).map(m => modelView(m, rows.find(p => p.key === m.provider_key))), presets: poolProviders.map((p) => ({ key: p.key, display_name: p.display_name, base_url: p.base_url, default_model: p.default_model, provider_access: p.provider_access, uncensored: Boolean(p.uncensored), models: p.models })), credit_estimates: estimates, session_credentials: cookies, session_balances: balances };
        }
        if (section === 'models') {
            const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
            const providers = await registry.listProviders();
            return { models: (await registry.listModels({ provider })).map(m => modelView(m, providers.find(p => p.key === m.provider_key))),
                provider: provider || null, sync_log: modelSync ? await modelSync.read(provider) : [] };
        }
        if (section === 'sync') return { sync_log: modelSync ? await modelSync.read() : [] };
        if (section === 'runs') {
            const { filters, form, bad } = q.parseRunFilters(req.query);
            const list = await q.listRuns(db, filters);
            return { rows: list.rows, next: list.next, filters: form, invalid_filters: bad, facets: await q.runFacets(db) };
        }
        if (section === 'run') {
            const run = await runs.explained(await runs.get(req.query.id));
            if (!run) return { run: null };
            return { run, citations: await runs.citations(run.id), requests: await runs.requestsFor(run.id), input: q.preview(run.input), output: q.preview(run.output) };
        }
        if (section === 'quotas') return { quotas: await quotas.list(), current: await quotas.counters() };
        if (section === 'usage') {
            const { filters, form, bad } = q.parseUsageFilters(req.query, clock.now());
            return { ...await q.usageReport(quotas, filters), filters: form, invalid_filters: bad };
        }
        if (section === 'cache') return { cache: await cache.stats() };
        if (section === 'audit') {
            const { filters, form, bad } = q.parseAuditFilters(req.query);
            const result = await q.listAudit(db, filters);
            return { rows: result.rows, next: result.next, filters: form, invalid_filters: bad, kinds: q.AUDIT_KINDS };
        }
        if (section === 'gpus') return { state: gpus ? await gpus.state() : null, ...await marketPayload() };
        if (section === 'pricebook') return { report: priceBook ? priceBook.last : null, state: priceBook ? await priceBook.state.read() : null,
            pending: priceBook ? await priceBook.pending(50) : [], recent: priceBook ? await priceBook.changes({ status: 'applied', limit: 50 }) : [] };
        if (section === 'exchange') return { credits: await q.settleQueue(db, clock.now()), routing: await q.routingEvidence(db) };
        if (section === 'abuse') return { report: abuse ? await abuse.overview() : null };
        if (section === 'glossary') return { providers: await registry.listProviders(), models: await registry.listModels() };
        if (section === 'owner-inference') {
            const providers = await registry.listProviders();
            const caps = await ownerConfig.getCaps();
            const spend = await Promise.all(caps.map(async (c) => ({ provider_key: c.provider_key, ...(await ownerConfig.spendFor(c.provider_key)) })));
            const prices = {};
            for (const m of await registry.listModels()) prices[`${m.provider_key}/${m.model_key}`] = m.cost;
            const kinds = {};
            for (const cap of ['chat', 'uncensored', 'embed', 'image', 'transcribe', 'batch']) kinds[cap] = { savings: await ownerConfig.savings(cap) };
            return {
                providers: providers.map((p) => ({ key: p.key, display_name: p.display_name, kind: p.kind, status: p.status, base_url: p.base_url,
                    priority: p.priority, capabilities: p.capabilities, uncensored: Boolean(p.metadata && p.metadata.uncensored),
                    key_state: p.auth_mode === 'none' ? 'not_required' : (providerSecret(p, env) ? 'configured' : 'missing'),
                    last_check: p.metadata?.last_check || null,
                    spend_cap: caps.find((c) => c.provider_key === p.key) || null,
                    spend: spend.find((s) => s.provider_key === p.key) || null })),
                models: (await registry.listModels()).map((m) => { const p = providers.find((x) => x.key === m.provider_key); return modelView(m, p); }),
                prices, caps, routing: await ownerConfig.getRouting(), economy: await ownerConfig.getEconomy(),
                costs_24h: await ownerConfig.costs('24h'), costs_7d: await ownerConfig.costs('7d'), kinds,
            };
        }
        throw Object.assign(new Error('no such console section'), { status: 404 });
    }));
    r.get('/api/v1/admin/console/gpus/:model/quote', read, wrap(async (req) => {
        if (!gpus) throw new AiError(409, 'ai.conflict', 'GPU quotes are off on this host');
        return await gpus.preview(String(req.params.model), { strategy: req.query.strategy || undefined });
    }));
    // Read the public marketplace pages now instead of waiting for the due tick. It still never rents anything.
    r.post('/api/v1/admin/console/gpus/prices/refresh', write, wrap(async () => {
        if (!gpuMarket) throw new AiError(409, 'ai.conflict', 'GPU price sources are off on this host');
        return { ...await gpuMarket.refresh(), ...await marketPayload() };
    }));
    r.post('/api/v1/admin/console/supply/quotes', json, write, wrap(async req => ({ recorded: await require('../pricebook/gpus').recordGpuQuotes(db, JSON.stringify(req.body.quotes)), dry_run: true })));
    r.post('/api/v1/admin/console/supply', json, write, wrap(req => supply.save(req.body || {}, actor(req))));
    r.post('/api/v1/admin/console/owner-inference/spend-caps', json, write, wrap(async (req) => ({ cap: await ownerConfig.setCap(req.body || {}, { actor: actor(req), trace: req.ov && req.ov.traceId }) })));
    r.post('/api/v1/admin/console/owner-inference/routing', json, write, wrap(async (req) => ({ routing: await ownerConfig.setRouting(req.body || {}, { actor: actor(req), trace: req.ov && req.ov.traceId }) })));
    r.post('/api/v1/admin/console/owner-inference/economy', json, write, wrap(async (req) => ({ economy: await ownerConfig.setEconomy(req.body || {}, { actor: actor(req), trace: req.ov && req.ov.traceId }) })));
    r.post('/api/v1/admin/console/providers/:key/key', json, write, wrap(async (req) => {
        if (!vault || !settings) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be stored on this host');
        const provider = await registry.getProvider(req.params.key);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        const value = String((req.body || {}).api_key || '');
        if (value.length < 8 || value.length > 400) throw new AiError(422, 'ai.invalid', 'the provider key must be 8-400 characters');
        const who = { actor: actor(req), trace: req.ov && req.ov.traceId };
        await vault.put(provider.key, value, who);
        await registry.upsertProvider({ key: provider.key, secret_ref: `vault:${provider.key}`, metadata: { ...provider.metadata, last_check: null } }, { ...who, origin: 'admin' });
        await registry.audit(who.actor, 'provider.key_replaced', 'provider', provider.key, { trace: who.trace });
        return { ok: true, provider: provider.key };
    }));
    r.delete('/api/v1/admin/console/providers/:key/key', write, wrap(async (req) => {
        if (!vault || !settings) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be stored on this host');
        const provider = await registry.getProvider(req.params.key);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        const who = { actor: actor(req), trace: req.ov && req.ov.traceId };
        // Disable first: a request racing the store deletion must not fall back to an environment key.
        await registry.upsertProvider({ key: provider.key, status: 'disabled', secret_ref: null,
            metadata: { ...provider.metadata, last_check: null } }, { ...who, origin: 'admin' });
        await vault.remove(provider.key);
        await registry.audit(who.actor, 'provider.key_removed', 'provider', provider.key, { trace: who.trace });
        return { ok: true, provider: provider.key };
    }));
    r.post('/api/v1/admin/console/providers/:key/check', write, wrap(async (req) => {
        const provider = await registry.getProvider(req.params.key);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        const { checkProvider } = require('../providers/check');
        const result = await checkProvider(provider, { env, now: clock.now,
            fetchImpl: fetchImpl === globalThis.fetch ? require('../providers/guarded-fetch').guardedFetch : fetchImpl });
        // A check does not enable a provider or overwrite settings changed while its request was in flight.
        const current = await registry.getProvider(provider.key);
        if (current.updated_at === provider.updated_at) await registry.upsertProvider({ key: provider.key, metadata: { ...current.metadata, last_check: result } }, { actor: actor(req), origin: current.origin });
        return { provider: provider.key, ...result };
    }));
    r.post('/api/v1/admin/console/providers/:key/sync', write, wrap(async (req) => {
        if (!modelSync) throw new AiError(503, 'ai.unavailable', 'model sync is unavailable');
        return modelSync.run(req.params.key, { actor: actor(req) });
    }));
    r.post('/api/v1/admin/console/providers/:key/model-settings', json, write, wrap(async (req) => {
        const provider = await registry.getProvider(req.params.key);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        const b = req.body || {};
        if (typeof b.auto_list_new_models !== 'boolean' || ![0, 60, 360, 1440].includes(b.model_sync_interval_minutes)) throw new AiError(422, 'ai.invalid', 'choose a model sync interval and automatic listing preference');
        await registry.upsertProvider({ key: provider.key, metadata: { ...provider.metadata,
            auto_list_new_models: b.auto_list_new_models, model_sync_interval_minutes: b.model_sync_interval_minutes } }, { actor: actor(req), origin: 'admin' });
        return { ok: true, provider: provider.key };
    }));
    r.post('/api/v1/admin/console/providers', json, write, wrap(async (req) => {
        if (!vault || !settings) throw new AiError(503, 'vault.unavailable', 'provider keys cannot be stored on this host');
        const b = req.body || {};
        const preset = providerPresets.byId(String(b.preset || 'custom')) || providerPresets.byId('custom');
        const key = String(b.key || preset.id).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(key)) throw new AiError(422, 'ai.invalid', 'the provider name must be 2-41 lowercase letters, digits, dots and dashes');
        if (await registry.getProvider(key)) throw new AiError(409, 'ai.conflict', 'a provider with that name already exists');
        const apiKey = String(b.api_key || '');
        if (apiKey.length < 8 || apiKey.length > 400) throw new AiError(422, 'ai.invalid', 'the provider key must be 8-400 characters');
        const baseUrl = String(b.base_url || preset.base_url || '').trim();
        if (!/^https:\/\/[^\s]+$/i.test(baseUrl)) throw new AiError(422, 'ai.invalid', 'the base URL must use https');
        const actorInfo = { actor: actor(req), trace: req.ov && req.ov.traceId };
        const provider = await registry.upsertProvider({ key, display_name: String(b.display_name || preset.name || key).slice(0, 80),
            kind: preset.kind, status: 'active', base_url: baseUrl.replace(/\/+$/, ''),
            auth_mode: preset.kind === 'anthropic' ? 'x-api-key' : 'bearer', secret_ref: `vault:${key}`,
            default_model: String(b.default_model || preset.model || '').trim() || null,
            capabilities: [...providerPresets.TEXT_CAPS, ...(b.vision === true ? ['vision'] : [])],
            timeout_ms: 60000, priority: 50, billing_profile: 'metered', metadata: { added_from: 'exchange-console', preset: preset.id },
        }, { ...actorInfo, origin: 'admin' });
        await vault.put(key, apiKey, actorInfo);
        if (settings.providerKeys && settings.providerKeys.setOrigin) await settings.providerKeys.setOrigin(key, baseUrl, { actor: { type: 'service', id: 'ai' }, reason: 'provider added' });
        await providerCatalog.sync({ registry, provider, apiKey, fetchImpl, actor: actorInfo.actor }).catch(() => null);
        await poolSeed.applyCatalogPrices({ registry, provider, actor: actorInfo.actor }).catch(() => null);
        return { ok: true, provider: await ops.providerView(provider) };
    }));
    r.post('/api/v1/admin/console/provider-credits', json, write, wrap(async (req) => {
        if (!creditGrants) throw new AiError(503, 'ai.unavailable', 'provider credit records are not configured');
        const b = req.body || {};
        const provider = ['anthropic', 'openai'].includes(String(b.provider)) ? String(b.provider) : 'anthropic';
        const grant = await creditGrants.add({ provider_key: provider, kind: String(b.kind || 'promotional'), amount_usd: Number(b.amount_usd),
            as_of: String(b.as_of || ''), received_at: String(b.received_at || b.as_of || ''),
            remaining_as_of_usd: b.remaining_as_of_usd == null ? Number(b.amount_usd) : Number(b.remaining_as_of_usd),
            remaining_as_of: String(b.remaining_as_of || b.as_of || ''),
            expires_at: b.expires_at ? new Date(`${b.expires_at}T23:59:59Z`).toISOString() : null,
            applies_to: String(b.applies_to || '').slice(0, 200) || null });
        return { grant };
    }));
    r.post('/api/v1/admin/console/provider-credit-preference', json, write, wrap(async (req) => {
        if (!creditGrants) throw new AiError(503, 'ai.unavailable', 'provider credit preferences are not configured');
        const b = req.body || {};
        const provider = ['anthropic', 'openai'].includes(String(b.provider)) ? String(b.provider) : 'anthropic';
        return { preference: await creditGrants.setPreference({ provider_key: provider, enabled: b.enabled === true, floor_usd: Number(b.floor_usd) }) };
    }));
    r.post('/api/v1/admin/console/provider-session-credentials', json, write, wrap(async (req) => {
        if (!sessionCookies) throw new AiError(503, 'ai.unavailable', 'provider session credentials are not configured');
        const b = req.body || {};
        return { credential: await sessionCookies.add('operator', 'owner', { provider: b.provider, cookie: String(b.cookie || ''), label: b.label, expires_at: b.expires_at || null, org_id: b.org_id }) };
    }));
    r.delete('/api/v1/admin/console/provider-session-credentials/:id', write, wrap(async (req) => {
        if (!sessionCookies) throw new AiError(503, 'ai.unavailable', 'provider session credentials are not configured');
        return { removed: await sessionCookies.remove('operator', 'owner', req.params.id) };
    }));
    r.post('/api/v1/admin/console/gpus/:model/:action', write, wrap(async (req) => {
        if (!gpus) throw new AiError(409, 'ai.conflict', 'GPU controls are off on this host');
        const action = String(req.params.action);
        if (!['launch', 'stop'].includes(action)) throw new AiError(404, 'ai.not_found', 'no such GPU action');
        await gpus.request(String(req.params.model || ''), action, actor(req));
        return { ok: true };
    }));
    r.post('/api/v1/admin/console/pricebook/changes/:id', write, wrap(async (req) => {
        if (!priceBook) throw new AiError(409, 'ai.conflict', 'the price book is off on this host');
        const decision = String((req.body || {}).decision) === 'approve' ? 'approve' : 'reject';
        const id = String(req.params.id).slice(0, 60);
        const out = await priceBook.decide(id, { decision, actor: actor(req) });
        if (!out.ok) throw new AiError(409, 'ai.conflict', out.error);
        await registry.audit(actor(req), decision === 'approve' ? 'price_change.approved' : 'price_change.rejected', 'price_change', id, { trace: req.ov && req.ov.traceId, metadata: { decision } });
        return { ok: true, decision, change: out.change };
    }));
    r.post('/api/v1/admin/console/pricebook/run', write, wrap(async (req) => {
        if (!priceBook) throw new AiError(409, 'ai.conflict', 'the price book is off on this host');
        const report = await priceBook.runOnce({ force: true });
        await registry.audit(actor(req), 'pricebook.run', 'pricebook', 'run', { trace: req.ov && req.ov.traceId, metadata: { sources: (report.sources || []).length, applied: (report.applied || []).length, pending: (report.pending || []).length } });
        return report;
    }));
    // A reviewed reading goes into the log as pending; only the owner's approve writes the live price. This is how
    // a provider or a model the weekly job has not read yet gets in front of the owner.
    r.post('/api/v1/admin/console/pricebook/proposals', write, json, wrap(async (req) => {
        if (!priceBook) throw new AiError(409, 'ai.conflict', 'the price book is off on this host');
        const body = req.body || {};
        const proposals = Array.isArray(body) ? body : body.proposals;
        const out = await priceBook.propose(proposals, { actor: actor(req) });
        await registry.audit(actor(req), 'price_changes.proposed', 'price_book', 'propose', { trace: req.ov && req.ov.traceId,
            metadata: { proposed: out.proposed.length, unchanged: out.unchanged.length, models_created: out.models_created.length } });
        return out;
    }));
    r.post('/api/v1/admin/console/runs/:id/cancel', workflowWrite, wrap(async (req) => {
        const subject = actor(req);
        const run = await runs.cancel(req.params.id, { sub: subject, subject: { type: 'user', id: subject } }, {
            trace: req.ov && req.ov.traceId, principalHas: (cap) => cap === CAPS.workflowManage,
        });
        return { run };
    }));
    r.post('/api/v1/admin/console/exchange/credits/:id/resolve', workflowWrite, wrap(async (req) => {
        const id = String(req.params.id || '').slice(0, 300);
        const row = id ? await db.prepare('SELECT id, hold_id, request_id, status FROM credit_settle_queue WHERE id = ?').get(id) : null;
        if (!row) throw new AiError(404, 'ai.not_found', 'no such settle queue row');
        if (row.status !== 'review') throw new AiError(409, 'ai.conflict', 'only a row in review can be marked resolved');
        const now = new Date(clock.now()).toISOString();
        await db.prepare(`UPDATE credit_settle_queue SET status = 'resolved', resolved_at = ?::timestamptz, resolved_by = ?, updated_at = ?::timestamptz WHERE id = ? AND status = 'review'`)
            .run(now, actor(req), now, id);
        return { ok: true, id };
    }));
    return r;
}

module.exports = { consoleDataRouter };
