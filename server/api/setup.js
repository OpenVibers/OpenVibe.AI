'use strict';
/**
 * The guided AI setup API (OpenVibe.Network /admin/ai/setup).
 *
 *   GET    /api/v1/setup                              every step, its state, price, key page and spend
 *   PUT    /api/v1/setup/providers/:provider/key      write a provider key (ai.provider_keys) and turn it on
 *   POST   /api/v1/setup/providers/:provider/test     one tiny request with that provider
 *   POST   /api/v1/setup/test/:step                   one tiny request through the step's own route
 *   PUT    /api/v1/setup/routes/:step                 pin the model the route uses
 *   PUT    /api/v1/setup/caps/:step                   the monthly spend cap for the step
 *   POST   /api/v1/setup/recommended                  fill every route with its recommended model
 *
 * A provider key is written through the same sealed store the owner settings use and is never
 * returned, logged or put in an error: the answer carries only the last four characters. A test
 * goes through the route's placement (pool.execute) or, for web search, the engine adapter, and
 * returns the answer and what it cost. Everything here needs ai.provider.manage; Network's service
 * token holds it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError, providerSecret } = require('../util');
const { STEPS, stepById, offersOf, keyPageOf } = require('../setup/catalog');

const MONTH_MS = 30 * 24 * 3600 * 1000;
const MAX_KEY = 400;
const money = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** Split a route's choice into the provider and model it pins, if any. */
function currentOf(route) {
    if (!route) return { provider: null, model: null };
    const constraints = route.constraints || {};
    const authority = typeof constraints.authority === 'string' ? constraints.authority : '';
    const [authorityProvider, ...authorityRest] = authority.split(':');
    return {
        provider: (authorityProvider || (route.primary && route.primary.provider) || null),
        model: constraints.model || (authorityRest.length ? authorityRest.join(':') : null) || (route.primary && route.primary.model) || null,
    };
}

function priceOfModel(model, step) {
    if (!model) return null;
    const meta = model.metadata || {};
    if (step.modelType === 'image' && meta.price_per_image_usd != null) {
        return { kind: 'image', per_image_usd: Number(meta.price_per_image_usd), unit: 'picture', text: `$${Number(meta.price_per_image_usd)} per picture` };
    }
    if (step.modelType === 'speech' && model.cost && model.cost.in_per_mtok != null) {
        return { kind: 'characters', per_million_chars_usd: Number(model.cost.in_per_mtok), unit: '1M characters', text: `$${Number(model.cost.in_per_mtok)} per 1M characters` };
    }
    if (step.modelType === 'stt' && meta.price_per_minute_usd != null) {
        return { kind: 'minute', per_minute_usd: Number(meta.price_per_minute_usd), unit: 'minute', text: `$${Number(meta.price_per_minute_usd)} per minute` };
    }
    if (model.cost && model.cost.in_per_mtok != null) {
        const out = model.cost.out_per_mtok == null ? null : Number(model.cost.out_per_mtok);
        const cached = model.cost.cached_per_mtok == null ? null : Number(model.cost.cached_per_mtok);
        return { kind: 'tokens', in_per_mtok: Number(model.cost.in_per_mtok), out_per_mtok: out, cached_per_mtok: cached, unit: '1M tokens',
            text: out == null ? `$${model.cost.in_per_mtok} per 1M tokens` : `$${model.cost.in_per_mtok} in · $${out} out per 1M tokens` };
    }
    return null;
}

/** An offer with the registry's price and display name when it has them. */
function viewOffer(step, offer, { providers, models, configured, recommended = false }) {
    const provider = providers.get(offer.provider) || null;
    const model = models.get(`${offer.provider}/${offer.model}`) || null;
    const price = priceOfModel(model, step) || offer.price;
    return {
        provider: offer.provider,
        provider_name: (provider && provider.display_name) || offer.provider,
        model: offer.model,
        label: offer.label || (model && model.display_name) || offer.model,
        why: offer.why || null,
        note: offer.note || null,
        price,
        price_text: price ? price.text : 'price not published',
        source: offer.source || null,
        checked: offer.checked || null,
        recommended,
        keyless: Boolean(offer.keyless),
        configured: Boolean(configured),
        key_page: offer.key_page || keyPageOf(provider),
    };
}

function wavClip() {
    // A real two-second spoken clip for the speech-to-text test: ffmpeg's flite voice when the
    // host has it (the deploy host does), else a quiet tone. Written to a temp file for the adapter.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ai-setup-'));
    const file = path.join(dir, 'ready.wav');
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'flite=text=OpenVibe is ready:voice=slt', '-t', '2', '-ar', '16000', '-ac', '1', '-y', file];
    try {
        childProcess.execFileSync('ffmpeg', args, { timeout: 15000, stdio: 'ignore' });
    } catch {
        // A tone still proves the route; only the transcript is less interesting.
        childProcess.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', '-y', file], { timeout: 15000, stdio: 'ignore' });
    }
    return { file, dir };
}

function tinyPng() {
    return { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
}

async function shrinkImage(b64) {
    if (!b64) return null;
    try {
        const sharp = require('sharp');
        const buf = await sharp(Buffer.from(b64, 'base64')).resize(256, 256, { fit: 'cover' }).png().toBuffer();
        return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
        // sharp is optional; a provider that answered with a URL is shown as it is, and an inline
        // picture is shown only when it is small enough to travel.
        return b64.length <= 350000 ? `data:image/png;base64,${b64}` : null;
    }
}

function scrub(text, secret) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (secret) s = s.split(String(secret)).join('[hidden]');
    s = s.replace(/\b(sk|key|token)[-_][A-Za-z0-9_-]{8,}\b/gi, '[hidden]');
    return s.length > 400 ? `${s.slice(0, 399)}…` : s;
}

function setupRouter({ config = {}, db, registry, pool = null, runs = null, auth, settings = null, search = null, env = process.env, clock = { now: () => Date.now() }, log = console }) {
    const r = express.Router();
    const read = auth.requireCap(CAPS.providerManage, CAPS.usageRead);
    const write = auth.requireCap(CAPS.providerManage);
    const wrap = (fn) => async (req, res) => {
        try { const out = await fn(req); if (out !== undefined) res.json(out); }
        catch (err) { sendError(res, err, req.ov, log); }
    };
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
    const actorOf = (req) => ({ type: 'service', id: String((req.principal && req.principal.sub) || 'network').replace(/^svc:/, '') });
    const actorId = (req) => `service:${(req.principal && req.principal.sub) || 'network'}`;

    const providersOf = async () => new Map((await registry.listProviders()).map((p) => [p.key, p]));
    const modelsOf = async () => new Map((await registry.listModels()).map((m) => [`${m.provider_key}/${m.model_key}`, m]));
    const routesOf = async () => new Map((await registry.listRoutes()).map((x) => [x.key, x]));
    const configured = (provider) => Boolean(provider && provider.key !== 'stub' && provider.status === 'active' && (provider.auth_mode === 'none' || Boolean(providerSecret(provider, env))));

    async function hintOf(providerKey) {
        if (!settings || !settings.providerKeys) return null;
        try {
            const marker = await settings.providerKeys.store.secretMarker(`${providerKey}.key`);
            return marker && marker.hint ? { last4: marker.hint, set_at: marker.set_at || null, bound_to: marker.bound_to || null } : null;
        } catch { return null; }
    }

    async function healthOf() {
        const out = new Set();
        try {
            for (const row of await db.prepare("SELECT provider_key, model_key FROM provider_circuits WHERE state = 'open'").all()) out.add(`${row.provider_key}/${row.model_key || ''}`);
        } catch { /* no circuit table yet: not failing */ }
        try {
            for (const row of await db.prepare("SELECT provider_key FROM provider_health WHERE state = 'open'").all()) out.add(`${row.provider_key}/`);
        } catch { /* older database: no provider health */ }
        return out;
    }

    async function spendOf(routeKey) {
        const since = new Date(clock.now() - MONTH_MS).toISOString();
        const monthStart = new Date(clock.now());
        monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
        const aliases = (await registry.listRoutes()).filter((x) => x.alias_of === routeKey).map((x) => x.key);
        const keys = [routeKey, ...aliases];
        const marks = keys.map(() => '?').join(', ');
        try {
            const last30 = await db.prepare(`SELECT COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM runs
                WHERE created_at >= ? AND route_key IN (${marks}) AND status IN ('succeeded', 'cached')`).get(since, ...keys);
            const month = await db.prepare(`SELECT COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM runs
                WHERE created_at >= ? AND route_key IN (${marks}) AND status IN ('succeeded', 'cached')`).get(monthStart.toISOString(), ...keys);
            return { calls_30d: Number(last30 && last30.calls) || 0, cost_30d: money(last30 && last30.cost), calls_month: Number(month && month.calls) || 0, cost_month: money(month && month.cost) };
        } catch { return { calls_30d: 0, cost_30d: 0, calls_month: 0, cost_month: 0 }; }
    }

    async function capOf(kind) {
        const row = await db.prepare('SELECT monthly_cap_usd FROM task_kind_caps WHERE task_kind = ?').get(kind).catch(() => null);
        return row ? Number(row.monthly_cap_usd) : 0;
    }

    async function routeFor(step) {
        if (!step.route) return null;
        let route = await registry.getRoute(step.route);
        if (!route && step.id === 'image') {
            // The image route exists only once a model is chosen (AI_IMAGE_MODEL seeds it in production).
            route = await registry.createRouteVersion(step.route, {
                'capability': 'image', constraints: { objective: 'correctness', provider_scope: 'paid' },
                max_output_tokens: null, response_format: 'text', timeout_ms: 120000,
            }, { actor: 'service:network' });
        }
        return route;
    }

    async function ensureModel(step, providerKey, modelKey, { allowUnknown = false } = {}) {
        if (!step.modelType) return null;
        const existing = await registry.getModel(providerKey, modelKey);
        if (existing) {
            if (existing.status !== 'active') await registry.upsertModel({ provider_key: providerKey, model_key: modelKey, status: 'active' }, { actor: 'setup' });
            return await registry.getModel(providerKey, modelKey);
        }
        const offer = offersOf(step).find((o) => o.provider === providerKey && o.model === modelKey);
        if (!offer && !allowUnknown) throw new AiError(422, 'setup.model_unknown', `choose ${modelKey} from the list for ${step.name}`);
        if (!offer && allowUnknown) return await registry.upsertModel({ provider_key: providerKey, model_key: modelKey, display_name: modelKey, type: step.modelType, status: 'active' }, { actor: 'setup' });
        const price = offer.price || {};
        const cost = price.kind === 'tokens'
            ? { in_per_mtok: price.in_per_mtok, out_per_mtok: price.out_per_mtok, cached_per_mtok: price.cached_per_mtok == null ? null : price.cached_per_mtok, source: offer.source || null, verified_at: offer.checked || null, effective_from: offer.checked || null }
            : price.kind === 'characters'
                ? { in_per_mtok: price.per_million_chars_usd, out_per_mtok: 0, source: offer.source || null, verified_at: offer.checked || null }
                : { in_per_mtok: price.kind === 'minute' ? 0 : null, out_per_mtok: 0, source: offer.source || null, verified_at: offer.checked || null };
        const metadata = { setup_seeded: true, ...(price.kind === 'image' ? { price_per_image_usd: price.per_image_usd } : {}),
            ...(price.kind === 'minute' ? { price_per_minute_usd: price.per_minute_usd } : {}),
            ...(price.kind === 'characters' ? { unit: 'characters', price_per_million_chars_usd: price.per_million_chars_usd } : {}) };
        return await registry.upsertModel({
            provider_key: providerKey, model_key: modelKey, display_name: offer.label || modelKey, type: step.modelType, status: 'active',
            cost, supports: { json: step.id === 'vision', tools: step.id === 'code', streaming: step.modelType === 'chat', vision: step.id === 'vision' },
            metadata,
        }, { actor: 'setup' });
    }

    async function stepView(step, { providers, models, routes, health, searchEngines }) {
        const route = routes.get(step.route) || null;
        const current = currentOf(route);
        const offers = offersOf(step);
        const recommended = viewOffer(step, step.recommended, { providers, models, configured: configured(providers.get(step.recommended.provider)), recommended: true });
        const alternatives = step.alternatives.map((o) => viewOffer(step, o, { providers, models, configured: configured(providers.get(o.provider)) }));
        recommended.key_hint = await hintOf(recommended.provider);
        for (const o of alternatives) o.key_hint = await hintOf(o.provider);

        let routedOffers = [];
        if (route && pool) {
            try { routedOffers = await pool.offers(route, step.operation, {}); } catch { routedOffers = []; }
        }
        const offered = new Set(routedOffers.map((o) => `${o.provider}/${o.model || ''}`));
        const readyOffer = routedOffers.find((o) => configured(providers.get(o.provider)));
        const failing = Boolean(route && !route.disabled && routedOffers.length && routedOffers.some((o) => health.has(`${o.provider}/${o.model || ''}`) || health.has(`${o.provider}/`)))
            || Boolean(route && route.disabled);

        let searchState = null;
        if (step.id === 'search') {
            const available = (searchEngines || []).filter((e) => e.available && e.healthy !== false);
            searchState = { engines: available.map((e) => ({ id: e.id, price_per_1000: e.price_per_1000, byok: e.byok })), ready: available.length > 0 };
        }

        let state = 'not_set';
        if (step.id === 'search') state = searchState.ready ? 'ready' : failing ? 'failing' : 'not_set';
        else if (failing) state = 'failing';
        else if (route && !route.disabled && readyOffer) state = 'ready';
        else if (route && !route.disabled && routedOffers.length) state = 'not_set';

        const spend = step.route ? await spendOf(step.route) : { calls_30d: 0, cost_30d: 0, calls_month: 0, cost_month: 0 };
        const cap = await capOf(step.id);
        const hint = await hintOf(step.recommended.provider);

        // The options the defaults table offers: the curated ones first, then the registry's own
        // active models of this kind, so a model the owner synced is never hidden.
        const options = offers.map((o) => viewOffer(step, o, { providers, models, configured: configured(providers.get(o.provider)) }));
        for (const model of models.values()) {
            if (step.modelType && model.type !== step.modelType && !(step.modelType === 'chat' && model.type === 'vision')) continue;
            if (!providers.has(model.provider_key)) continue;
            const key = `${model.provider_key}/${model.model_key}`;
            if (options.some((o) => `${o.provider}/${o.model}` === key)) continue;
            options.push(viewOffer(step, { provider: model.provider_key, model: model.model_key, label: model.display_name, price: null, source: model.cost && model.cost.source }, {
                providers, models, configured: configured(providers.get(model.provider_key)),
            }));
        }
        return {
            id: step.id, name: step.name, short: step.short, what: step.what, uses: step.uses,
            route: step.route, state, ready: state === 'ready',
            recommended, alternatives, options,
            current, route_version: route ? route.version : null,
            offers: routedOffers,
            configured_offer: readyOffer ? { provider: readyOffer.provider, model: readyOffer.model } : null,
            key_hint: hint,
            key_page: recommended.key_page,
            price: recommended.price,
            spend, cap_usd: cap,
            estimated_month_usd: spend.cost_30d,
            month_usd: spend.cost_month,
            search: searchState,
        };
    }

    async function state() {
        const [providers, models, routes, health, searchEngines] = await Promise.all([
            providersOf(), modelsOf(), routesOf(), healthOf(),
            search ? search.engines().catch(() => []) : Promise.resolve([]),
        ]);
        const steps = [];
        for (const step of STEPS) steps.push(await stepView(step, { providers, models, routes, health, searchEngines }));
        return {
            ok: true, generated_at: new Date(clock.now()).toISOString(),
            steps,
            summary: { ready: steps.filter((s) => s.ready).length, total: steps.length },
            defaults: steps.map((s) => ({
                id: s.id, name: s.name, route: s.route, current: s.current, options: s.options,
                estimated_month_usd: s.estimated_month_usd, month_usd: s.month_usd, calls_30d: s.spend.calls_30d,
                cap_usd: s.cap_usd,
            })),
        };
    }

    r.get('/api/v1/setup', read, wrap(async () => await state()));

    r.put('/api/v1/setup/providers/:provider/key', write, wrap(async (req) => {
        const key = String((body(req).key) || '').trim();
        if (key.length < 8 || key.length > MAX_KEY) throw new AiError(422, 'setup.key_invalid', 'a key is 8 to 400 characters');
        if (/\s/.test(key)) throw new AiError(422, 'setup.key_invalid', 'a key has no spaces or line breaks');
        const provider = await registry.getProvider(req.params.provider);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        if (provider.auth_mode === 'none') throw new AiError(422, 'setup.key_unneeded', `${provider.display_name || provider.key} needs no key`);
        if (!settings || !settings.providerKeys) throw new AiError(503, 'config.unavailable', 'the provider key store is not ready');
        try { await settings.providerKeys.setKey(provider.key, key, { actor: actorOf(req), reason: 'provider setup page' }); }
        catch (err) { throw new AiError(err.status && Number.isInteger(err.status) ? err.status : 422, 'setup.key_rejected', scrub((err && err.message) || 'the key was not accepted', key)); }
        if (provider.status !== 'active') await registry.upsertProvider({ key: provider.key, status: 'active' }, { actor: actorId(req), origin: 'admin' });
        const hint = await hintOf(provider.key);
        return { ok: true, provider: provider.key, hint, configured: true };
    }));

    /** One tiny request through the step's route, pinned to the offer being tested. */
    async function runTest(step, { providerKey, modelKey, req }) {
        // The key is the one thing that must never appear in an answer, a log line or an error.
        const provider = step.id === 'search' ? null : await registry.getProvider(providerKey);
        if (step.id !== 'search' && !provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        const secret = provider ? providerSecret(provider, env) : '';

        if (step.id === 'search') {
            if (!search) throw new AiError(503, 'search.unavailable', 'search is not configured on this service');
            const out = await search.search('web', { q: 'OpenVibe network', limit: 3, engine: providerKey }).catch((err) => {
                throw new AiError(err.status || 502, 'setup.test_failed', scrub(err.message, secret));
            });
            return {
                ok: true, step: step.id, route: null, provider: providerKey, model: providerKey,
                answer: { title: (out.results[0] && out.results[0].title) || 'No results', url: (out.results[0] && out.results[0].url) || null, count: out.results.length },
                cost_usd: money(out.receipt && out.receipt.cost_usd), latency_ms: out.receipt && out.receipt.time_ms,
            };
        }

        const route = await routeFor(step);
        if (!route) throw new AiError(503, 'route.unavailable', `there is no route for ${step.name} yet`);
        if (!pool) throw new AiError(503, 'route.unavailable', 'routing is not available on this service');
        const testRoute = { ...route, constraints: { ...(route.constraints || {}), ...(modelKey ? { model: modelKey, authority: `${providerKey}:${modelKey}` } : { authority: providerKey }) } };
        const started = clock.now();
        let out;
        try {
            if (step.operation === 'chat') {
                out = await pool.execute(testRoute, 'chat', {
                    model: modelKey, maxTokens: 32, temperature: 0,
                    system: [{ text: 'Answer with one short sentence. Never repeat the prompt.' }],
                    messages: [{ role: 'user', content: step.id === 'vision' ? 'What is in this picture? Answer in one sentence.' : 'Say that the AI setup is ready, in one short sentence.' }],
                    ...(step.id === 'vision' ? { image: tinyPng() } : {}),
                }, { contentPolicy: 'standard' });
            } else if (step.operation === 'image') {
                const model = await registry.getModel(providerKey, modelKey);
                const perImage = model && model.metadata && Number(model.metadata.price_per_image_usd);
                out = await pool.execute(testRoute, 'image', {
                    model: modelKey, prompt: 'A small blue square on a plain white background, flat icon.', n: 1, size: '1024x1024',
                }, { contentPolicy: 'standard', ...(Number.isFinite(perImage) && perImage >= 0 ? { imagePriceUsd: perImage } : {}) });
            } else if (step.operation === 'embed') {
                out = await pool.execute(testRoute, 'embed', { model: modelKey, input: 'OpenVibe answers by meaning.' }, { contentPolicy: 'standard' });
            } else if (step.operation === 'speak') {
                out = await pool.execute(testRoute, 'speak', { model: modelKey, voice: providerKey === 'polly' ? 'pl_joanna_neural' : 'gc_neural_chad', text: 'OpenVibe is ready.', format: 'mp3' }, { contentPolicy: 'standard' });
            } else if (step.operation === 'transcribe') {
                const clip = wavClip();
                try {
                    out = await pool.execute(testRoute, 'transcribe', { model: modelKey, filePath: clip.file, language: 'en', live: false, timeoutMs: 120000 }, { contentPolicy: 'standard' });
                } finally { try { fs.rmSync(clip.dir, { recursive: true, force: true }); } catch { /* */ } }
            } else {
                throw new AiError(422, 'setup.test_unavailable', `there is no test for ${step.name}`);
            }
        } catch (err) {
            const status = err && err.status && Number.isInteger(err.status) ? err.status : 502;
            throw new AiError(status >= 400 && status < 600 ? status : 502, 'setup.test_failed', scrub((err && err.message) || 'the test did not answer', secret));
        }
        // The stub is the network's safety net, never proof that a key works: a test that fell back
        // to it says so instead of showing synthetic text as the provider's answer.
        if (out.provider === 'stub' || (out.synthetic && providerKey !== 'stub')) {
            throw new AiError(502, 'setup.test_failed', `no real ${providerKey} answer reached the route; it fell back to the stub. Check the key, the provider status and the model.`);
        }
        const latency = clock.now() - started;
        const result = out.result || {};
        let answer = null;
        if (step.operation === 'chat') answer = { text: String(result.text || '').slice(0, 800) };
        else if (step.operation === 'image') {
            const first = (result.images && result.images[0]) || {};
            answer = { image: first.url || await shrinkImage(first.b64), count: (result.images || []).length };
        } else if (step.operation === 'embed') answer = { dimensions: (result.vectors && result.vectors[0] && result.vectors[0].length) || 0, sample: (result.vectors && result.vectors[0] || []).slice(0, 8) };
        else if (step.operation === 'speak') answer = { characters: (out.usage && out.usage.characters) || String('OpenVibe is ready.').length, mime_type: result.mimeType || 'audio/mpeg' };
        else if (step.operation === 'transcribe') answer = { text: String(result.text || '(no words heard)').slice(0, 800), segments: (result.segments || []).length };
        return {
            ok: true, step: step.id, route: step.route, provider: out.provider, model: out.model,
            answer, cost_usd: money(out.cost), latency_ms: latency, synthetic: Boolean(out.synthetic),
        };
    }

    r.post('/api/v1/setup/test/:step', write, wrap(async (req) => {
        const step = stepById(req.params.step);
        if (!step) throw new AiError(404, 'setup.step_unknown', 'no such setup step');
        const b = body(req);
        const providerKey = String(b.provider || step.recommended.provider);
        if (step.id !== 'search') {
            const provider = await registry.getProvider(providerKey);
            if (!provider) throw new AiError(404, 'ai.not_found', `no provider ${providerKey}`);
            if (provider.auth_mode !== 'none' && !providerSecret(provider, env)) throw new AiError(409, 'setup.key_missing', `paste the ${provider.display_name || provider.key} key first`);
        }
        const modelKey = step.id === 'search' ? null : String(b.model || step.recommended.model);
        if (step.id !== 'search') await ensureModel(step, providerKey, modelKey);
        return await runTest(step, { providerKey, modelKey, req });
    }));

    r.post('/api/v1/setup/providers/:provider/test', write, wrap(async (req) => {
        const provider = await registry.getProvider(req.params.provider);
        if (!provider) throw new AiError(404, 'ai.not_found', 'no such provider');
        const searchOnly = Array.isArray(provider.capabilities) && provider.capabilities.includes('web-search') && !provider.capabilities.some((c) => ['chat', 'speak', 'transcribe', 'embed', 'image'].includes(c));
        const step = stepById(searchOnly ? 'search' : 'chat');
        const modelKey = searchOnly ? null : String(body(req).model || provider.default_model || step.recommended.model);
        if (!searchOnly) await ensureModel(step, provider.key, modelKey, { allowUnknown: true });
        return await runTest(step, { providerKey: provider.key, modelKey });
    }));

    r.put('/api/v1/setup/routes/:step', write, wrap(async (req) => {
        const step = stepById(req.params.step);
        if (!step) throw new AiError(404, 'setup.step_unknown', 'no such setup step');
        if (!step.route) throw new AiError(422, 'setup.route_absent', `${step.name} has no route to change`);
        const b = body(req);
        const providerKey = b.provider == null ? null : String(b.provider);
        const modelKey = b.model == null ? null : String(b.model);
        let route = await routeFor(step);
        if (!route) throw new AiError(503, 'route.unavailable', `there is no route for ${step.name} yet`);
        if (providerKey) {
            const provider = await registry.getProvider(providerKey);
            if (!provider) throw new AiError(404, 'ai.not_found', `no provider ${providerKey}`);
            if (provider.status !== 'active' && !providerSecret(provider, env)) throw new AiError(409, 'setup.key_missing', `paste the ${provider.display_name || provider.key} key first`);
            await ensureModel(step, providerKey, modelKey);
        }
        const constraints = { ...(route.constraints || {}) };
        if (providerKey && modelKey) { constraints.model = modelKey; constraints.authority = `${providerKey}:${modelKey}`; }
        else { delete constraints.model; delete constraints.authority; }
        route = await registry.createRouteVersion(step.route, {
            'capability': step.capability, constraints,
            options: route.options, max_output_tokens: route.max_output_tokens,
            response_format: route.response_format, timeout_ms: route.timeout_ms, alias_of: route.alias_of,
        }, { actor: actorId(req), trace: req.ov && req.ov.traceId });
        return { ok: true, step: step.id, route: route.key, version: route.version, current: currentOf(route) };
    }));

    r.put('/api/v1/setup/caps/:step', write, wrap(async (req) => {
        const step = stepById(req.params.step);
        if (!step) throw new AiError(404, 'setup.step_unknown', 'no such setup step');
        const cap = Number(body(req).cap_usd);
        if (!Number.isFinite(cap) || cap < 0 || cap > 100000) throw new AiError(422, 'setup.cap_invalid', 'the cap is a monthly amount from 0 to 100,000');
        const at = new Date(clock.now()).toISOString();
        await db.prepare(`INSERT INTO task_kind_caps (task_kind, monthly_cap_usd, updated_at, updated_by) VALUES (?, ?, ?, ?)
            ON CONFLICT (task_kind) DO UPDATE SET monthly_cap_usd = excluded.monthly_cap_usd, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
            .run(step.id, money(cap), at, actorOf(req).id);
        return { ok: true, step: step.id, cap_usd: money(cap), updated_at: at };
    }));

    r.post('/api/v1/setup/recommended', write, wrap(async (req) => {
        const applied = [];
        for (const step of STEPS) {
            if (!step.route) continue;
            const offer = step.recommended;
            try {
                await ensureModel(step, offer.provider, offer.model);
                const route = await routeFor(step);
                if (!route) { applied.push({ step: step.id, ok: false, error: 'no route' }); continue; }
                const constraints = { ...(route.constraints || {}), model: offer.model, authority: `${offer.provider}:${offer.model}` };
                const next = await registry.createRouteVersion(step.route, {
                    'capability': step.capability, constraints, options: route.options, max_output_tokens: route.max_output_tokens,
                    response_format: route.response_format, timeout_ms: route.timeout_ms, alias_of: route.alias_of,
                }, { actor: actorId(req), trace: req.ov && req.ov.traceId });
                applied.push({ step: step.id, ok: true, route: next.key, version: next.version, provider: offer.provider, model: offer.model });
            } catch (err) {
                applied.push({ step: step.id, ok: false, error: scrub(err.message) });
            }
        }
        return { ok: true, applied };
    }));

    return r;
}

module.exports = { setupRouter, currentOf, priceOfModel, scrub };
