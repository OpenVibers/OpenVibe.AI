'use strict';
/**
 * The owner's inference configuration (the owner 2026-11-10: "make it all configurable in admin
 * panel by owner"). One module for the three owners' choices, with the pool's enforcement reads:
 *
 *   - provider spend caps (migrations/0072): a provider over its day/month cap is skipped, with
 *     the reason in explain, from usage_daily (the same table quotas write).
 *   - routing strategy per capability: auto | cheapest | fastest | fixed array, plus a ceiling
 *     price per million output tokens and providers never to use (denylist). Uncensored is a
 *     capability like any other: its choices name the first and second provider per model.
 *   - economy toggles per capability: batches, prompt cache, small-model-first, output limit,
 *     answer cache. Each is surfaced with what it saved in the last seven days, measured from
 *     requests/runs/cache_entries; where no seam exists the value is reported, never faked.
 *
 * Nothing here holds or logs a secret. Every write calls registry.audit with who + what
 * (names and numbers, never a value). The floor (server/policy/floor.js) and the 18+ gate
 * (server/policy/tier.js) are not configurable here and have no switch: they run in the pool
 * before and after every attempt, including an owner's fixed order for uncensored.
 */
const fs = require('fs');
const path = require('path');
const { AiError, parseJson } = require('./util');
const { isUncensored } = require('./providers/pool-providers');
const traits = require('./providers/traits');
const computeProviders = require('./gpu/compute-providers');

const KINDS = ['chat', 'uncensored', 'embed', 'image', 'transcribe', 'batch'];
const STRATEGIES = ['auto', 'cheapest', 'fastest', 'fixed'];
/**
 * A kind with no row keeps the behaviour it had before the owner configured it: batches, prompt caching
 * and the answer cache are on, the small model first and the output limit are off. That is what the
 * columns' defaults say (migrations/0072); an owner row is only ever needed to turn a way of paying
 * less OFF. The uncensored kind never serves a stored answer, so its answer cache reads off.
 */
const ECONOMY_DEFAULTS = Object.freeze({ batches: true, prompt_cache: true, small_first: false, output_limit: null, answer_cache: true });
/**
 * The routing rules of the provider wave (migration 0075). Every one starts at its safe value; the owner may
 * change it on the inference page, and the pool reads the row before each placement.
 */
const RULE_DEFAULTS = Object.freeze({ private_training: false, flex_interactive: false, latency_limited_interactive: false, free_allowance_first: true });
const CONFIRMED_PRICES_FILE = path.join(__dirname, '..', 'scripts', 'pricebook-proposals-2026-11-10b.json');
const economyDefaultsFor = (capability) => ({ ...ECONOMY_DEFAULTS, ...(capability === 'uncensored' ? { answer_cache: false } : {}) });

/** The kind of work a workflow is, from its own steps (server/workflows). */
function workflowKind(wf) {
    const steps = (wf && Array.isArray(wf.steps)) ? wf.steps : [];
    if (steps.length && steps.every((s) => s && s.kind === 'embed')) return 'embed';
    if (steps.length && steps.every((s) => s && s.kind === 'transcribe')) return 'transcribe';
    if (steps.length && steps.every((s) => s && (s.kind === 'image' || s.kind === 'picture'))) return 'image';
    return 'chat';
}

/**
 * The economy kind of one run, as the router names it (server/providers/index.js ownerCapability):
 * uncensored is its own kind, an embedding/image/transcription workflow keeps its kind, a deferrable
 * run of any other workflow is 'batch' work, and everything else is chat. Batches of a kind are
 * switched on that capability's row.
 */
function capabilityOfRun(wf, { contentPolicy = 'standard', latencyClass = null } = {}) {
    if (contentPolicy === 'uncensored') return 'uncensored';
    const kind = workflowKind(wf);
    if (kind !== 'chat') return kind;
    if (latencyClass === 'batch') return 'batch';
    return 'chat';
}

/** The SQL for one run's economy kind, given aliases for runs and (optionally) requests. */
function capabilitySql(runAlias = 'r', requestAlias = null) {
    const r = runAlias;
    const q = requestAlias;
    const uncensored = `COALESCE(${r}.options, '') LIKE '%"policy":"uncensored"%'`;
    const batch = `${r}.latency_class = 'batch'`;
    const embed = q ? `${q}.operation = 'embed'` : `(${r}.workflow_key = 'ai.embed' OR ${r}.route_key LIKE '%embed%')`;
    const image = q ? `${q}.operation = 'image'` : `(${r}.workflow_key = 'ai.image' OR ${r}.workflow_key LIKE '%picture%' OR ${r}.route_key LIKE '%image%')`;
    const transcribe = q ? `${q}.operation = 'transcribe'` : `(${r}.workflow_key LIKE '%transcribe%' OR ${r}.route_key LIKE '%transcribe%')`;
    return `CASE WHEN ${uncensored} THEN 'uncensored' WHEN ${batch} THEN 'batch' WHEN ${embed} THEN 'embed' WHEN ${image} THEN 'image' WHEN ${transcribe} THEN 'transcribe' ELSE 'chat' END`;
}

function createOwnerConfig({ db, registry, clock = { now: () => Date.now() } } = {}) {
    const now = () => new Date(clock.now()).toISOString();

    const kind = (v) => {
        const c = String(v || '').trim().toLowerCase();
        if (c === 'speech') return 'transcribe';
        if (c === 'embeddings') return 'embed';
        if (c === 'images') return 'image';
        if (c === 'batches') return 'batch';
        if (!KINDS.includes(c)) throw new AiError(422, 'ai.invalid', `kind must be one of ${KINDS.join(', ')}`);
        return c;
    };
    const usd = (v) => (v == null || v === '' ? null : Number(v));
    const usdOk = (v) => (v == null || (Number.isFinite(v) && v >= 0 && v <= 1e9));

    // ── Spend caps ─────────────────────────────────────────────
    async function getCaps() {
        return await db.prepare('SELECT provider_key, daily_usd, monthly_usd, updated_by, updated_at FROM provider_spend_caps ORDER BY provider_key').all();
    }
    async function setCap(input, { actor = 'system', trace = null } = {}) {
        const key = String((input || {}).provider_key || '').trim();
        if (!key || !await registry.getProvider(key)) throw new AiError(404, 'ai.not_found', `no provider ${key || '(empty)'}`);
        const daily = usd(input.daily_usd);
        const monthly = usd(input.monthly_usd);
        if (!usdOk(daily) || !usdOk(monthly)) throw new AiError(422, 'ai.invalid', 'spend caps are dollar amounts between 0 and 1e9');
        const t = now();
        await db.prepare(`INSERT INTO provider_spend_caps (provider_key, daily_usd, monthly_usd, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET daily_usd = excluded.daily_usd, monthly_usd = excluded.monthly_usd, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(key, daily, monthly, actor, t);
        await registry.audit(actor, 'provider.spend_cap', 'provider', key, { trace, metadata: { daily_usd: daily, monthly_usd: monthly } });
        return (await getCaps()).find((r) => r.provider_key === key);
    }
    /** Spend on one provider today and this month, from usage_daily. */
    async function spendFor(providerKey) {
        const d = new Date(clock.now());
        const today = d.toISOString().slice(0, 10);
        const month = d.toISOString().slice(0, 7);
        const day = await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_daily WHERE provider_key = ? AND day = ?`).get(providerKey, today);
        const mon = await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_daily WHERE provider_key = ? AND substr(day, 1, 7) = ?`).get(providerKey, month);
        return { today: Number(day.c || 0), month: Number(mon.c || 0) };
    }
    /** The cap that would skip this provider now, or null. */
    async function capHit(providerKey) {
        const row = await db.prepare('SELECT daily_usd, monthly_usd FROM provider_spend_caps WHERE provider_key = ?').get(providerKey);
        if (!row || (row.daily_usd == null && row.monthly_usd == null)) return null;
        const s = await spendFor(providerKey);
        return { daily: row.daily_usd, monthly: row.monthly_usd, spent_today: s.today, spent_month: s.month, over: (row.daily_usd != null && s.today >= Number(row.daily_usd)) || (row.monthly_usd != null && s.month >= Number(row.monthly_usd)) };
    }

    // ── Routing strategy ───────────────────────────────────────
    async function getRouting() {
        const rows = await db.prepare('SELECT * FROM owner_routing ORDER BY capability').all();
        return rows.map((r) => ({ capability: r.capability, strategy: r.strategy, ceiling: r.ceiling_usd_per_mtok_out, denylist: parseJson(r.denylist, []), choices: parseJson(r.choices, []), enabled: !!r.enabled, updated_by: r.updated_by, updated_at: r.updated_at }));
    }
    async function setRouting(input, { actor = 'system', trace = null } = {}) {
        const capability = kind((input || {}).capability);
        const strategy = String((input || {}).strategy || 'auto');
        if (!STRATEGIES.includes(strategy)) throw new AiError(422, 'ai.invalid', `strategy must be one of ${STRATEGIES.join(', ')}`);
        const ceiling = usd((input || {}).ceiling_usd_per_mtok_out);
        if (ceiling != null && !(Number.isFinite(ceiling) && ceiling >= 0)) throw new AiError(422, 'ai.invalid', 'ceiling is a price per million output tokens');
        const list = (v) => {
            const a = Array.isArray(v) ? v : [];
            return a.map((x) => String((x && typeof x.provider === 'string' ? x.provider : x) || '').trim()).filter(Boolean);
        };
        const denylist = list((input || {}).denylist, 'denylist');
        for (const p of denylist) if (!await registry.getProvider(p)) throw new AiError(422, 'ai.invalid', `denylist names unknown provider ${p}`);
        const choicesIn = Array.isArray((input || {}).choices) ? (input || {}).choices : [];
        const choices = [];
        const seen = new Set();
        for (const c of choicesIn) {
            const provider = String(c && c.provider || '').trim();
            if (!provider || !await registry.getProvider(provider)) throw new AiError(422, 'ai.invalid', 'each choice needs a known provider');
            const model = c.model != null && c.model !== '' ? String(c.model) : (await registry.getProvider(provider)).default_model || null;
            if (!model || !await registry.getModel(provider, model)) throw new AiError(422, 'ai.invalid', `choice ${provider}/${model || ''} is not a registered model`);
            if (capability === 'uncensored') { const ok = isUncensored(await registry.getProvider(provider), await registry.getModel(provider, model)); if (!ok) throw new AiError(422, 'ai.invalid', `choice ${provider}/${model} is not an uncensored model`); }
            const id = `${provider}/${model}`;
            if (seen.has(id)) throw new AiError(422, 'ai.invalid', 'a choice is repeated');
            seen.add(id);
            choices.push({ provider, model });
        }
        if (strategy === 'fixed' && choices.length > 64) throw new AiError(422, 'ai.invalid', 'at most 64 choices');
        const enabled = (input || {}).enabled === true;
        const t = now();
        await db.prepare(`INSERT INTO owner_routing (capability, strategy, ceiling_usd_per_mtok_out, denylist, choices, enabled, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(capability) DO UPDATE SET strategy = excluded.strategy, ceiling_usd_per_mtok_out = excluded.ceiling_usd_per_mtok_out, denylist = excluded.denylist, choices = excluded.choices, enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(capability, strategy, ceiling, JSON.stringify(denylist), JSON.stringify(choices), enabled, actor, t);
        await registry.audit(actor, 'owner_routing.update', 'owner_routing', capability, { trace, metadata: { strategy, ceiling, denylist, choices: choices.map((c) => `${c.provider}/${c.model}`), enabled } });
        return (await getRouting()).find((r) => r.capability === capability);
    }
    async function routingFor(capability) {
        return (await getRouting()).find((r) => r.capability === capability) || null;
    }

    // ── Economy toggles ────────────────────────────────────────
    async function getEconomy() {
        const rows = await db.prepare('SELECT * FROM owner_economy ORDER BY capability').all();
        const saved = new Map(rows.map((r) => [r.capability, r]));
        return KINDS.map((capability) => {
            const r = saved.get(capability);
            return {
                capability,
                ...economyDefaultsFor(capability),
                ...(r ? { batches: !!r.batches, prompt_cache: !!r.prompt_cache, small_first: !!r.small_first, output_limit: r.output_limit, answer_cache: capability === 'uncensored' ? false : !!r.answer_cache } : {}),
                updated_by: r ? r.updated_by : null,
                updated_at: r ? r.updated_at : null,
            };
        });
    }
    async function economyFor(capability) {
        return (await getEconomy()).find((r) => r.capability === capability) || { capability, ...economyDefaultsFor(capability) };
    }
    async function setEconomy(input, { actor = 'system', trace = null } = {}) {
        const capability = kind((input || {}).capability);
        const num = (v) => (v == null || v === '' ? null : Number(v));
        const output_limit = num((input || {}).output_limit);
        if (output_limit != null && !(Number.isFinite(output_limit) && output_limit > 0)) throw new AiError(422, 'ai.invalid', 'output_limit is a positive token count');
        // The uncensored kind never serves a stored answer (server/runs.js), so its switch is recorded
        // off whatever is sent: a row must never read as if a reused adult answer were possible.
        const answer_cache = capability === 'uncensored' ? false : (input || {}).answer_cache === true;
        const t = now();
        await db.prepare(`INSERT INTO owner_economy (capability, batches, prompt_cache, small_first, output_limit, answer_cache, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(capability) DO UPDATE SET batches = excluded.batches, prompt_cache = excluded.prompt_cache, small_first = excluded.small_first, output_limit = excluded.output_limit, answer_cache = excluded.answer_cache, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(capability, (input || {}).batches === true, (input || {}).prompt_cache === true, (input || {}).small_first === true, output_limit, answer_cache, actor, t);
        await registry.audit(actor, 'owner_economy.update', 'owner_economy', capability, { trace, metadata: { batches: (input || {}).batches === true, prompt_cache: (input || {}).prompt_cache === true, small_first: (input || {}).small_first === true, output_limit, answer_cache } });
        return (await getEconomy()).find((r) => r.capability === capability);
    }

    // ── The provider wave's controls (migration 0075) ──────────
    /** The safe routing rules, merged with the owner's row when there is one. */
    async function getRules() {
        const row = await db.prepare("SELECT * FROM owner_inference_rules WHERE id = 'default'").get();
        return {
            ...RULE_DEFAULTS,
            ...(row ? {
                private_training: !!row.private_training, flex_interactive: !!row.flex_interactive,
                latency_limited_interactive: !!row.latency_limited_interactive, free_allowance_first: !!row.free_allowance_first,
            } : {}),
            updated_by: row ? row.updated_by : null,
            updated_at: row ? row.updated_at : null,
        };
    }
    async function setRules(input, { actor = 'system', trace = null } = {}) {
        const b = input || {};
        const val = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
        const prev = await getRules();
        const next = {
            private_training: val(b.private_training, prev.private_training),
            flex_interactive: val(b.flex_interactive, prev.flex_interactive),
            latency_limited_interactive: val(b.latency_limited_interactive, prev.latency_limited_interactive),
            free_allowance_first: val(b.free_allowance_first, prev.free_allowance_first),
        };
        const t = now();
        await db.prepare(`INSERT INTO owner_inference_rules (id, private_training, flex_interactive, latency_limited_interactive, free_allowance_first, updated_by, updated_at)
            VALUES ('default', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET private_training = excluded.private_training, flex_interactive = excluded.flex_interactive,
              latency_limited_interactive = excluded.latency_limited_interactive, free_allowance_first = excluded.free_allowance_first, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(next.private_training ? true : false, next.flex_interactive ? true : false, next.latency_limited_interactive ? true : false, next.free_allowance_first ? true : false, actor, t);
        await registry.audit(actor, 'owner_inference.rules', 'owner_inference', 'default', { trace, metadata: next });
        return await getRules();
    }
    async function controlFor(providerKey) {
        return await db.prepare('SELECT * FROM provider_controls WHERE provider_key = ?').get(providerKey);
    }
    async function controls() {
        return await db.prepare('SELECT * FROM provider_controls ORDER BY provider_key').all();
    }
    /** What a free allowance has used this period, from usage_daily. */
    async function allowanceUsedFor(providerKey, since = null) {
        const row = since
            ? await db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS t FROM usage_daily WHERE provider_key = ? AND day >= ?').get(providerKey, since)
            : await db.prepare('SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS t FROM usage_daily WHERE provider_key = ?').get(providerKey);
        return Number(row && row.t || 0);
    }
    /**
     * Every provider with a trait the wave added, the owner's control of it, and the allowance that is left.
     * A provider with no traits row is not repeated here: nothing about it changed.
     */
    async function providerState() {
        const seen = new Map((await controls()).map((r2) => [r2.provider_key, r2]));
        const out = [];
        for (const p of await registry.listProviders()) {
            const t = (p.metadata && p.metadata.traits) || null;
            if (!t && !seen.has(p.key)) continue;
            const c = seen.get(p.key) || null;
            let allowance = null;
            if (t && t.free_allowance) {
                const used = await allowanceUsedFor(p.key, traits.allowancePeriodStart(p, clock.now()));
                allowance = traits.allowanceLeft(p, { used, now: clock.now() });
            }
            let endpoint = null;
            if (c && c.base_url) {
                const hourly = Number(c.hourly_usd);
                const throughput = Number(c.throughput_tokens_per_hour);
                endpoint = {
                    base_url: c.base_url, model_key: c.model_key || null, hourly_usd: Number.isFinite(hourly) ? hourly : null,
                    throughput_tokens_per_hour: Number.isFinite(throughput) ? throughput : null,
                    usd_per_mtok: Number.isFinite(hourly) && hourly > 0 && Number.isFinite(throughput) && throughput > 0 ? (hourly * 1e6) / throughput : null,
                };
            }
            out.push({
                key: p.key, display_name: p.display_name, status: p.status, base_url: p.base_url,
                enabled: c && c.enabled != null ? !!c.enabled : p.status === 'active',
                tier: c && c.tier ? c.tier : null,
                traits: t, data_policy: (p.metadata && p.metadata.data_policy) || null, privacy: (p.metadata && p.metadata.privacy) || null,
                allowance, endpoint, updated_at: c ? c.updated_at : null,
            });
        }
        return out;
    }
    /** Turn one provider on or off, and choose the tier the owner wants it asked for. */
    async function setProvider(input, { actor = 'system', trace = null } = {}) {
        const key = String((input || {}).provider_key || '').trim();
        const p = key ? await registry.getProvider(key) : null;
        if (!p) throw new AiError(404, 'ai.not_found', `no provider ${key || '(empty)'}`);
        const tier = (input || {}).tier == null || (input || {}).tier === '' ? null : String((input || {}).tier);
        if (tier != null && !['standard', 'flex'].includes(tier)) throw new AiError(422, 'ai.invalid', 'tier must be standard or flex');
        const hasEnabled = typeof (input || {}).enabled === 'boolean';
        const prev = await controlFor(key);
        const t = now();
        await db.prepare(`INSERT INTO provider_controls (provider_key, enabled, tier, base_url, model_key, hourly_usd, throughput_tokens_per_hour, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET enabled = excluded.enabled, tier = excluded.tier, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(key, hasEnabled ? (input.enabled ? true : false) : (prev ? prev.enabled : null), tier,
                prev ? prev.base_url : null, prev ? prev.model_key : null, prev ? prev.hourly_usd : null, prev ? prev.throughput_tokens_per_hour : null, actor, t);
        if (hasEnabled) await registry.upsertProvider({ key, status: input.enabled ? 'active' : 'disabled' }, { actor, trace });
        await registry.audit(actor, 'provider.control', 'provider', key, { trace, metadata: { enabled: hasEnabled ? input.enabled === true : (prev ? prev.enabled : null), tier } });
        return (await providerState()).find((r2) => r2.key === key) || null;
    }
    /**
     * The owner's own OpenAI-compatible endpoint on a rented GPU: its URL, model, hourly price and measured
     * throughput. The key is saved in the provider's sealed key slot, never here. The model is priced per
     * million tokens from the hour and the throughput (server/gpu/token-cost.js does the same arithmetic).
     */
    async function setEndpoint(input, { actor = 'system', trace = null } = {}) {
        const b = input || {};
        let url = null;
        try { url = new URL(String(b.base_url || '')); } catch { /* refused below */ }
        if (!url || url.protocol !== 'https:' || url.username || url.password) throw new AiError(422, 'ai.invalid', 'base_url must be an https URL');
        const model = String(b.model_key || '').trim();
        if (!model || model.length > 200) throw new AiError(422, 'ai.invalid', 'model_key is required');
        const hourly = Number(b.hourly_usd);
        const throughput = Number(b.throughput_tokens_per_hour);
        if (!Number.isFinite(hourly) || hourly <= 0 || hourly > 1000) throw new AiError(422, 'ai.invalid', 'hourly_usd must be a positive dollar amount');
        if (!Number.isInteger(throughput) || throughput <= 0) throw new AiError(422, 'ai.invalid', 'throughput_tokens_per_hour must be a positive whole number of tokens an hour');
        const key = 'runpod-vllm';
        const provider = await registry.getProvider(key);
        if (!provider) throw new AiError(404, 'ai.not_found', `no provider ${key}`);
        await registry.upsertProvider({
            key, base_url: url.href.replace(/\/+$/, ''), default_model: model, status: 'disabled', auth_mode: 'bearer', secret_ref: `vault:${key}`,
            capabilities: ['chat', 'tools'],
        }, { actor, trace });
        const usdPerMtok = (hourly * 1e6) / throughput;
        await registry.upsertModel({
            provider_key: key, model_key: model, display_name: `${model} (my endpoint)`, type: 'chat', status: 'active',
            context_window: b.context_window ? Number(b.context_window) : null, max_output: b.max_output ? Number(b.max_output) : null,
            cost: { in_per_mtok: usdPerMtok, out_per_mtok: usdPerMtok, cached_per_mtok: null, source: url.href, verified_at: new Date(clock.now()).toISOString().slice(0, 10) },
            supports: { json: true, tools: true, streaming: true, vision: false },
            metadata: { catalog: 'owner-endpoint', hourly_usd: hourly, throughput_tokens_per_hour: throughput, compute_provider: 'runpod', throughput_source: 'owner-measured' },
        }, { actor, trace });
        const prev = await controlFor(key);
        const t = now();
        await db.prepare(`INSERT INTO provider_controls (provider_key, enabled, tier, base_url, model_key, hourly_usd, throughput_tokens_per_hour, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET base_url = excluded.base_url, model_key = excluded.model_key,
              hourly_usd = excluded.hourly_usd, throughput_tokens_per_hour = excluded.throughput_tokens_per_hour, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(key, prev ? prev.enabled : false, prev ? prev.tier : null, url.href, model, hourly, throughput, actor, t);
        await registry.audit(actor, 'provider.endpoint', 'provider', key, { trace, metadata: { base_url: url.href, model_key: model, hourly_usd: hourly, throughput_tokens_per_hour: throughput, usd_per_mtok: Number(usdPerMtok.toFixed(6)) } });
        return (await providerState()).find((r2) => r2.key === key) || null;
    }
    /** The capacity we rent ourselves and the owner's endpoint choice. */
    async function compute() {
        const c = await controlFor('runpod-vllm');
        const hourly = c ? Number(c.hourly_usd) : null;
        const throughput = c ? Number(c.throughput_tokens_per_hour) : null;
        return {
            providers: computeProviders.COMPUTE_PROVIDERS,
            endpoint: c && c.base_url ? {
                base_url: c.base_url, model_key: c.model_key || null,
                hourly_usd: Number.isFinite(hourly) ? hourly : null,
                throughput_tokens_per_hour: Number.isFinite(throughput) ? throughput : null,
                usd_per_mtok: Number.isFinite(hourly) && hourly > 0 && Number.isFinite(throughput) && throughput > 0 ? (hourly * 1e6) / throughput : null,
                key_state: 'see the provider key slot',
            } : null,
            checked: computeProviders.CHECKED,
        };
    }
    /** The confirmed readings bundled with this release, as pending price-book changes for the owner to accept. */
    async function confirmedPrices() {
        try { return JSON.parse(fs.readFileSync(CONFIRMED_PRICES_FILE, 'utf8')); }
        catch { return []; }
    }

    // ── Costs (24 h / 7 d) and savings (7 d) ───────────────────
    async function costs(window = '7d') {
        const days = window === '24h' ? 1 : 7;
        const sinceDay = new Date(clock.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
        const daily = await db.prepare(`SELECT provider_key, model_key, COALESCE(SUM(requests), 0)::bigint AS calls, COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in, COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out
            FROM usage_daily WHERE day >= ? GROUP BY provider_key, model_key ORDER BY cost DESC LIMIT 200`).all(sinceDay);
        const byProvider = new Map();
        for (const r of daily) {
            const p = byProvider.get(r.provider_key) || { provider: r.provider_key, calls: 0, cost: 0, tokens_in: 0, tokens_out: 0, failures: 0, by_model: [] };
            p.calls += Number(r.calls); p.cost += Number(r.cost); p.tokens_in += Number(r.tokens_in); p.tokens_out += Number(r.tokens_out);
            p.by_model.push({ model: r.model_key, calls: Number(r.calls), cost: Number(r.cost), tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out) });
            byProvider.set(r.provider_key, p);
        }
        const since = new Date(clock.now() - days * 86400000).toISOString();
        let failures = [];
        try {
            failures = await db.prepare(`SELECT provider_key, model_key, COUNT(*)::bigint AS n FROM requests WHERE created_at >= ? AND status IN ('error', 'timeout') GROUP BY provider_key, model_key`).all(since);
        } catch { failures = []; }
        for (const f of failures) {
            const p = byProvider.get(f.provider_key) || { provider: f.provider_key, calls: 0, cost: 0, tokens_in: 0, tokens_out: 0, failures: 0, by_model: [] };
            p.failures += Number(f.n);
            const m = p.by_model.find((x) => x.model === f.model_key);
            if (m) m.failures = (m.failures || 0) + Number(f.n); else p.by_model.push({ model: f.model_key, calls: 0, cost: 0, tokens_in: 0, tokens_out: 0, failures: Number(f.n) });
            byProvider.set(f.provider_key, p);
        }
        return { since: sinceDay, window: days === 1 ? '24h' : '7d', by_provider: [...byProvider.values()].map((p) => ({ ...p, by_model: p.by_model.sort((a, b) => b.cost - a.cost) })) };
    }
    async function savings(capability) {
        const since = new Date(clock.now() - 7 * 86400000).toISOString();
        const sinceDay = new Date(clock.now() - 6 * 86400000).toISOString().slice(0, 10);
        // ── Prompt cache: the cached reads really served, and what they cost against the input price.
        // The price book's cache-write price is part of the arithmetic: a write costs its premium, and
        // it is only a saving when the reads have paid for it back. A model with no card counts no
        // dollars (the tokens are still shown, never invented money).
        const promptRows = await db.prepare(`WITH x AS (
                SELECT ${capabilitySql('r', 'rq')} AS capability, rq.tokens_cached AS cached, rq.tokens_cache_write AS written, rq.tokens_in AS tin,
                    rq.provider_key, rq.model_key
                FROM requests rq LEFT JOIN runs r ON r.id = rq.run_id WHERE rq.created_at >= ?)
            SELECT capability, COALESCE(SUM(cached), 0)::bigint AS cached, COALESCE(SUM(tin), 0)::bigint AS tin, COUNT(*)::bigint AS calls,
                COALESCE(SUM(GREATEST(0,
                    COALESCE(cached, 0) * (COALESCE(m.cost_in_per_mtok, 0) - COALESCE(m.cost_cached_per_mtok, COALESCE(m.cost_in_per_mtok, 0) * 0.1, 0))
                    - COALESCE(written, 0) * (COALESCE(m.cost_cache_write_per_mtok, COALESCE(m.cost_in_per_mtok, 0)) - COALESCE(m.cost_in_per_mtok, 0))
                )), 0) / 1000000 AS saved_usd
            FROM x LEFT JOIN models m ON m.provider_key = x.provider_key AND m.model_key = x.model_key
            WHERE capability = ? GROUP BY capability`).get(since, capability).catch(() => null);
        // ── Answer cache: the reused runs, and the source run's cost that each one did not pay again.
        const answerRow = await db.prepare(`SELECT COUNT(*)::bigint AS n, COALESCE(SUM(src.cost_usd), 0) AS saved_usd
            FROM runs r JOIN runs src ON src.id = r.cached_from
            WHERE r.created_at >= ? AND r.status = 'cached' AND ${capabilitySql('r')} = ?`).get(since, capability).catch(() => null);
        // ── Batches: a batch run's cost is at the batch price; the retail card is the model's list
        // price. Where the model row has no price, the row reports the batch count so the number stays
        // honest (no invented savings).
        const batchRuns = await db.prepare(`SELECT m.provider_key, m.model_key, r.cost_usd, m.cost_in_per_mtok, m.cost_out_per_mtok, r.tokens_in, r.tokens_out
            FROM runs r LEFT JOIN models m ON m.provider_key = r.provider_key AND m.model_key = r.model_key
            WHERE r.created_at >= ? AND r.latency_class = 'batch' AND ${capabilitySql('r')} = ? LIMIT 1000`).all(since, capability).catch(() => []);
        let batchSaved = 0, batchPriced = 0;
        for (const b of batchRuns) {
            const retail = (Number(b.tokens_in || 0) / 1e6) * Number(b.cost_in_per_mtok || 0) + (Number(b.tokens_out || 0) / 1e6) * Number(b.cost_out_per_mtok || 0);
            if (retail > 0) { batchSaved += retail - Number(b.cost_usd || 0); batchPriced++; }
        }
        return {
            capability, window: '7d', since: sinceDay,
            prompt_cache: { cached_tokens: Number(promptRows && promptRows.cached || 0), calls: Number(promptRows && promptRows.calls || 0), saved_usd: promptRows ? Number(Number(promptRows.saved_usd || 0).toFixed(6)) : 0 },
            answer_cache: { cached_runs: Number(answerRow && answerRow.n || 0), saved_usd: answerRow ? Number(Number(answerRow.saved_usd || 0).toFixed(6)) : 0 },
            batches: { runs: batchRuns.length, priced: batchPriced, saved_usd: batchPriced ? Number(batchSaved.toFixed(6)) : null },
        };
    }

    return { KINDS, STRATEGIES, RULE_DEFAULTS, getCaps, setCap, capHit, spendFor, getRouting, setRouting, routingFor, getEconomy, economyFor, setEconomy,
        getRules, setRules, controlFor, controls, providerState, setProvider, setEndpoint, compute, confirmedPrices, costs, savings };
}

module.exports = { createOwnerConfig, KINDS, STRATEGIES, capabilityOfRun, workflowKind };
