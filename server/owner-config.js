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
const { AiError, parseJson } = require('./util');
const { isUncensored } = require('./providers/pool-providers');

const KINDS = ['chat', 'uncensored', 'embed', 'image', 'transcribe', 'batch'];
const STRATEGIES = ['auto', 'cheapest', 'fastest', 'fixed'];

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
        return rows.map((r) => ({ capability: r.capability, batches: !!r.batches, prompt_cache: !!r.prompt_cache, small_first: !!r.small_first, output_limit: r.output_limit, answer_cache: !!r.answer_cache, updated_by: r.updated_by, updated_at: r.updated_at }));
    }
    async function setEconomy(input, { actor = 'system', trace = null } = {}) {
        const capability = kind((input || {}).capability);
        const num = (v) => (v == null || v === '' ? null : Number(v));
        const output_limit = num((input || {}).output_limit);
        if (output_limit != null && !(Number.isFinite(output_limit) && output_limit > 0)) throw new AiError(422, 'ai.invalid', 'output_limit is a positive token count');
        const t = now();
        await db.prepare(`INSERT INTO owner_economy (capability, batches, prompt_cache, small_first, output_limit, answer_cache, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(capability) DO UPDATE SET batches = excluded.batches, prompt_cache = excluded.prompt_cache, small_first = excluded.small_first, output_limit = excluded.output_limit, answer_cache = excluded.answer_cache, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(capability, (input || {}).batches === true, (input || {}).prompt_cache === true, (input || {}).small_first === true, output_limit, (input || {}).answer_cache === true, actor, t);
        await registry.audit(actor, 'owner_economy.update', 'owner_economy', capability, { trace, metadata: { batches: (input || {}).batches === true, prompt_cache: (input || {}).prompt_cache === true, small_first: (input || {}).small_first === true, output_limit, answer_cache: (input || {}).answer_cache === true } });
        return (await getEconomy()).find((r) => r.capability === capability);
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
        const req = await db.prepare(`SELECT COALESCE(SUM(tokens_cached), 0)::bigint AS cached, COALESCE(SUM(tokens_in), 0)::bigint AS tin, COALESCE(SUM(tokens_out), 0)::bigint AS tout, COUNT(*)::bigint AS calls
            FROM requests WHERE created_at >= ?`).get(since).catch(() => ({ cached: 0, tin: 0, tout: 0, calls: 0 }));
        const cachedRuns = await db.prepare(`SELECT COUNT(*)::bigint AS n FROM runs WHERE created_at >= ? AND status = 'cached'`).get(since).catch(() => ({ n: 0 }));
        // Batch savings are measurable: a batch run's cost is at the batch price; the retail card is
        // the model's list price. Where the model row has no price, the row reports the batch count
        // so the number stays honest (no invented savings).
        const batchRuns = await db.prepare(`SELECT m.provider_key, m.model_key, r.cost_usd, m.cost_in_per_mtok, m.cost_out_per_mtok, r.tokens_in, r.tokens_out
            FROM runs r LEFT JOIN models m ON m.provider_key = r.provider_key AND m.model_key = r.model_key
            WHERE r.created_at >= ? AND r.options LIKE '%"batch"%' LIMIT 1000`).all(since).catch(() => []);
        let batchSaved = 0, batchPriced = 0;
        for (const b of batchRuns) {
            const retail = (Number(b.tokens_in || 0) / 1e6) * Number(b.cost_in_per_mtok || 0) + (Number(b.tokens_out || 0) / 1e6) * Number(b.cost_out_per_mtok || 0);
            if (retail > 0) { batchSaved += retail - Number(b.cost_usd || 0); batchPriced++; }
        }
        return {
            capability, window: '7d', since: sinceDay,
            prompt_cache: { cached_tokens: Number(req.cached || 0), calls: Number(req.calls || 0) },
            answer_cache: { cached_runs: Number(cachedRuns.n || 0) },
            batches: { runs: batchRuns.length, priced: batchPriced, saved_usd: batchSaved ? Number(batchSaved.toFixed(6)) : null },
        };
    }

    return { KINDS, STRATEGIES, getCaps, setCap, capHit, spendFor, getRouting, setRouting, routingFor, getEconomy, setEconomy, costs, savings };
}

module.exports = { createOwnerConfig, KINDS, STRATEGIES };
