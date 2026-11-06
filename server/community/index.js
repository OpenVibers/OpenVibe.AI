'use strict';
/**
 * Community AI offers (the design's "Offer to the network"; plan E4): a person's Node runs a local model server and
 * advertises models, hours, concurrency, a price in credits per million tokens and who may use it. OpenVibe.Network's
 * resource registry holds the offer (a user-owned provider offer whose detail.kind is `ai`); this module reads that
 * internal list, checks trust before traffic, places only requests that opt in to community capacity, and records what
 * the machine served.
 *
 * Trust before traffic (plan §3):
 *   - canaries: known-answer prompts; any wrong answer marks the offer failed and stops traffic;
 *   - a model fingerprint: the model id the machine's own server reports must be the one the owner declared;
 *   - spot re-runs: about 1% of answers are re-run on a trusted machine serving the same model and compared;
 *   - reputation: canaries, spot runs and observed uptime, 0-100.
 * A new machine serves only the free tier (a run with no Balance payer, ctx.creditsRequired) until verified; only
 * verified tokens earn credits. The answer always carries `openvibe.community`, so a caller can see it came from a
 * person's machine. The prompt is visible to that machine, which is why only opted-in requests ever go there.
 *
 *   createCommunity({ db, config, env, machines, clock, fetchImpl, log, tokens, random })
 *     .enabled
 *     .offers()                         the live offers (refreshed from Network at most refreshMs)
 *     .choose({ ctx, operation })       one eligible {offer, model, key}, or null
 *     .execute({ route, operation, req, ctx })  one answer from a community machine, or null when none is eligible
 *     .sell(owner)                      the /sell dashboard: tokens served, credits, verification and reputation
 *     .publicOffers()                   what Exchange may show (never the owner subject)
 *     .verify(offer, model)             run a canary round now (execute does it when the last one is stale)
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { AiError, sha256 } = require('../util');

const TEXT_OPS = new Set(['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'complete', 'messages']);
const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const CANARY_PROMPTS = [
    { messages: [{ role: 'user', content: 'Reply with exactly this and nothing else: OPENVIBE-CANARY-7F3A' }], expect: 'OPENVIBE-CANARY-7F3A' },
    { messages: [{ role: 'user', content: 'What is 17 + 25? Reply with just the number.' }], expect: '42' },
    { messages: [{ role: 'user', content: 'Repeat this exact word: canary-ok' }], expect: 'canary-ok' },
];
const MAX_MESSAGES = 200;
const MAX_CONTENT = 65536;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n') : '').slice(0, MAX_CONTENT);
const nowIso = (clock) => new Date(clock.now()).toISOString();

/** A conversation as the machine's ai command takes it; text only, first two and newest kept when long. */
function messagesOf(req, operation) {
    let list;
    if (operation === 'complete' && req.openai && Array.isArray(req.openai.messages)) list = req.openai.messages;
    else {
        const system = typeof req.system === 'string' ? [{ role: 'system', content: req.system }]
            : Array.isArray(req.system) ? req.system.map((x) => ({ role: 'system', content: typeof x === 'string' ? x : textOf(x && (x.text != null ? x.text : x.content)) })) : [];
        list = [...system, ...(req.messages || [])];
    }
    const out = list.filter((m) => m && typeof m === 'object').map((m) => {
        const role = ['system', 'user', 'assistant', 'tool'].includes(m.role) ? m.role : m.role === 'developer' ? 'system' : 'user';
        const one = { role, content: textOf(m.content) };
        if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            one.tool_calls = m.tool_calls.slice(0, 32).map((c, i) => ({ id: String((c && c.id) || `call_${i + 1}`).slice(0, 200), type: 'function',
                function: { name: String((c && c.function && c.function.name) || ''), arguments: typeof (c && c.function && c.function.arguments) === 'string' ? c.function.arguments.slice(0, MAX_CONTENT) : JSON.stringify((c && c.function && c.function.arguments) || {}) } }));
        }
        if (role === 'tool') one.tool_call_id = String(m.tool_call_id || 'call_1').slice(0, 200);
        return one;
    });
    if (out.length <= MAX_MESSAGES) return out;
    let tail = out.slice(-(MAX_MESSAGES - 2));
    while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);
    return [...out.slice(0, 2), ...tail];
}

/** The functions a completion may ask for, in the machine's shape (the plugin passes them through, runs none). */
function toolsOf(req) {
    const tools = req.openai && Array.isArray(req.openai.tools) ? req.openai.tools : null;
    if (!tools) return null;
    const out = tools.filter((t) => t && t.type === 'function' && t.function && /^[A-Za-z0-9_.-]{1,64}$/.test(String(t.function.name || '')))
        .slice(0, 64).map((t) => ({ type: 'function', function: { name: t.function.name,
            ...(typeof t.function.description === 'string' ? { description: t.function.description.slice(0, 4096) } : {}),
            ...(t.function.parameters && typeof t.function.parameters === 'object' ? { parameters: t.function.parameters } : {}) } }));
    return out.length ? out : null;
}

/** Is an offer open now, in its own time zone? start == end is all day; an overnight window wraps. */
function withinHours(offer, now = Date.now()) {
    const h = offer && offer.hours;
    if (!h || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(h.start)) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(h.end))) return false;
    let clock;
    try {
        clock = new Intl.DateTimeFormat('en-GB', { timeZone: h.tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
    } catch { return false; }
    const minute = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
    const start = Number(h.start.slice(0, 2)) * 60 + Number(h.start.slice(3, 5));
    const end = Number(h.end.slice(0, 2)) * 60 + Number(h.end.slice(3, 5));
    if (start === end) return true;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The model id a server reports matches the declared one, allowing a quantization suffix the server adds. */
function fingerprintMatches(reported, declared) {
    const a = norm(reported), b = norm(declared);
    if (!a || !b) return false;
    if (a === b) return true;
    const base = (s) => s.replace(/[:\-](q[0-9].*|gguf|awq|gptq|instruct)$/i, '').trim();
    return base(a) === base(b);
}

/** Token-overlap similarity for a spot re-run: a different sampling of the same model still shares most words. */
function similar(a, b) {
    const words = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter(Boolean));
    const x = words(a), y = words(b);
    if (!x.size || !y.size) return false;
    let same = 0;
    for (const w of x) if (y.has(w)) same++;
    return same / Math.max(x.size, y.size) >= 0.5;
}

function createCommunity({ db, config, env = process.env, machines = null, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, tokens = null, random = Math.random }) {
    const cfg = (config && config.community) || {};
    const network = String((config && config.networkInternalUrl) || '').replace(/\/+$/, '');
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const clientId = (config && config.console && config.console.clientId) || env.OV_OAUTH_CLIENT_ID || 'ai';
    let registryTokens = tokens;
    if (!registryTokens && secret && network) {
        registryTokens = createServiceTokenClient({ tokenUrl: `${network}/oauth/token`, clientId, clientSecret: secret, scope: { 'openvibe.network': 'network.registry.read' }, fetch: fetchImpl });
    }
    let followTokens = tokens;
    if (!followTokens && secret && network) {
        followTokens = createServiceTokenClient({ tokenUrl: `${network}/oauth/token`, clientId, clientSecret: secret, scope: { 'openvibe.network': 'network.follows.read' }, fetch: fetchImpl });
    }
    const enabled = Boolean(cfg.enabled && db && machines && network && registryTokens);
    let cache = { at: 0, offers: [] };
    let refreshing = null;
    const followersCache = new Map();

    const keyOf = (offer, model) => `${offer.offer_id}|${model}`;

    /** One Network offer doc as this module uses it. Null for anything that is not a complete AI offer. */
    function normalize(doc) {
        if (!doc || typeof doc !== 'object') return null;
        // Network's /internal/ai/offers returns the offer whole; accept a platform.resource-offer@1 wrapper too, for a
        // reader of the older shape (the doc's detail.kind identifies it).
        const d = doc.detail && doc.detail.kind === 'ai' ? doc.detail : doc;
        if (d.kind && d.kind !== 'ai') return null;
        const owner = doc.owner || d.owner;
        if (typeof d.machine_id !== 'string' || typeof owner !== 'string' || !USR.test(owner)) return null;
        if (!Array.isArray(d.models) || !d.models.length || !d.hours || !d.price) return null;
        const price = d.price;
        return {
            offer_id: String(doc.offer_id || d.offer_id), machine_id: d.machine_id, owner,
            models: d.models.filter((m) => typeof m === 'string' && m).slice(0, 40),
            hours: { start: String(d.hours.start || ''), end: String(d.hours.end || ''), tz: String(d.hours.tz || 'UTC') },
            concurrency: Number(d.concurrency) || 1,
            price: { in_per_million: Number(price.in_per_million) || 0, out_per_million: Number(price.out_per_million) || 0 },
            audience: d.audience, group: d.group || null, ready: d.ready === true,
            health: (doc.health && doc.health.status) || 'down',
        };
    }

    async function fetchOffers() {
        if (!enabled) return [];
        const token = await registryTokens.getToken({ audience: 'openvibe.network' });
        let res;
        try {
            res = await fetchImpl(`${network}/internal/ai/offers`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        } catch (err) {
            throw new AiError(503, 'community.unavailable', `Network did not answer for community offers: ${String(err && err.message || err).slice(0, 200)}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new AiError(503, 'community.unavailable', `Network answered ${res.status} for community offers`);
        const offers = ((body && body.offers) || []).map(normalize).filter(Boolean);
        await noteHealth(offers);
        return offers;
    }

    /** Keep a simple uptime denominator: each refresh is one observation of each offer and model. */
    async function noteHealth(offers) {
        for (const offer of offers) {
            for (const model of offer.models) {
                try {
                    const key = keyOf(offer, model);
                    await db.prepare(`INSERT INTO community_offers (offer_key, offer_id, machine_id, owner_subject, model, models, price_in, price_out, status, checks, up_checks, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?)
                        ON CONFLICT (offer_key) DO UPDATE SET models = excluded.models, price_in = excluded.price_in, price_out = excluded.price_out,
                            checks = community_offers.checks + 1, up_checks = community_offers.up_checks + excluded.up_checks, updated_at = excluded.updated_at`)
                        .run(key, offer.offer_id, offer.machine_id, offer.owner, model, JSON.stringify(offer.models), offer.price.in_per_million, offer.price.out_per_million,
                            offer.health === 'up' ? 1 : 0, nowIso(clock), nowIso(clock));
                    await refreshReputation(key);
                } catch (err) { log.warn(`[community] health ${keyOf(offer, model)}: ${err.message}`); }
            }
        }
    }

    /** The live community offers, from the last Network read (no more than refreshMs old). */
    async function offers({ force = false } = {}) {
        if (!enabled) return [];
        if (!force && cache.offers.length && clock.now() - cache.at < (cfg.refreshMs || 30000)) return cache.offers;
        if (!refreshing) {
            refreshing = fetchOffers().then((list) => { cache = { at: clock.now(), offers: list }; return list; })
                .catch((err) => { log.warn(`[community] ${err.message}`); return cache.offers; })
                .finally(() => { refreshing = null; });
        }
        return await refreshing;
    }

    async function stateOf(key) {
        return await db.prepare('SELECT * FROM community_offers WHERE offer_key = ?').get(key);
    }

    /** The reputation: canaries 40, spot re-runs 40, observed uptime 20; a failed offer is 0. */
    async function refreshReputation(key) {
        const s = await stateOf(key);
        if (!s) return;
        let score = 0;
        if (s.status !== 'failed') {
            score += s.status === 'verified' ? 40 : 10;
            const spots = Number(s.spot_runs) || 0;
            score += spots ? Math.round(40 * (1 - (Number(s.spot_failures) || 0) / spots)) : 20;
            const checks = Number(s.checks) || 0;
            score += checks ? Math.round(20 * (Number(s.up_checks) || 0) / checks) : 0;
        }
        score = clamp(score, 0, 100);
        await db.prepare('UPDATE community_offers SET reputation = ?, updated_at = ? WHERE offer_key = ?').run(score, nowIso(clock), key);
    }

    /** Record one canary round. Successful: verified; a wrong answer: failed, traffic stops. */
    async function markCanary(key, { ok, reason = null }) {
        const at = nowIso(clock);
        if (ok) {
            await db.prepare(`UPDATE community_offers SET canary_passes = canary_passes + 1, last_canary_at = ?, status = CASE WHEN status = 'failed' THEN status ELSE 'verified' END,
                failure_reason = NULL, updated_at = ? WHERE offer_key = ?`).run(at, at, key);
        } else {
            await db.prepare(`UPDATE community_offers SET canary_failures = canary_failures + 1, last_canary_at = ?, status = 'failed', reputation = 0, failure_reason = ?, updated_at = ?
                WHERE offer_key = ?`).run(at, String(reason || 'canary_failed').slice(0, 300), at, key);
        }
        await refreshReputation(key);
    }

    /** Low-level: one chat completion on the person's machine, through Bot, as its owner. */
    async function dispatch(offer, model, messages, { maxTokens = 512, temperature = null, tools = null, timeoutMs = 60000, requestId = null } = {}) {
        if (!machines || !machines.enabled) throw new AiError(503, 'community.unavailable', 'OpenVibe.Bot is not configured, so a community machine cannot be reached');
        try {
            return await machines.chat({
                machine: offer.machine_id, subject: offer.owner, model, messages, maxTokens, temperature, tools,
                toolChoice: tools ? 'auto' : null, community: true,
                timeoutMs: Math.max(5000, Math.min(300000, timeoutMs)), signal: AbortSignal.timeout(Math.max(5000, timeoutMs) + 10000),
            });
        } catch (err) {
            const code = err && err.code;
            if (code === 'not_ready' || code === 'machine.busy') throw new AiError(503, 'community.busy', String(err.message || 'the machine is busy'));
            if (code === 'not_allowed') throw new AiError(409, 'community.not_open', String(err.message || 'the machine is not offering its models now'));
            throw err;
        }
    }

    /** A canary round and the model fingerprint: the model the machine's server reports must be the one declared. */
    async function verify(offer, model) {
        const key = keyOf(offer, model);
        await db.prepare(`INSERT INTO community_offers (offer_key, offer_id, machine_id, owner_subject, model, models, price_in, price_out, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?) ON CONFLICT (offer_key) DO NOTHING`)
            .run(key, offer.offer_id, offer.machine_id, offer.owner, model, JSON.stringify(offer.models), offer.price.in_per_million, offer.price.out_per_million, nowIso(clock), nowIso(clock));
        let lastModel = null;
        for (const canary of CANARY_PROMPTS) {
            let answer;
            try {
                answer = await dispatch(offer, model, canary.messages, { maxTokens: 64, temperature: 0, timeoutMs: cfg.canaryTimeoutMs || 30000, requestId: `canary-${key}` });
            } catch (err) {
                if (err && (err.code === 'community.busy' || err.code === 'community.not_open')) throw err;
                await markCanary(key, { ok: false, reason: `canary_call: ${String(err && err.message || err).slice(0, 200)}` });
                throw new AiError(502, 'community.verification_failed', `community machine ${offer.machine_id} failed its canary: ${String(err && err.message || err).slice(0, 200)}`);
            }
            lastModel = answer.model || lastModel;
            if (!norm(answer.text).includes(norm(canary.expect))) {
                await markCanary(key, { ok: false, reason: `canary_answer: expected ${canary.expect}` });
                throw new AiError(502, 'community.verification_failed', `community machine ${offer.machine_id} failed its canary prompt`);
            }
        }
        if (!fingerprintMatches(lastModel, model)) {
            await markCanary(key, { ok: false, reason: `fingerprint: ${String(lastModel).slice(0, 100)} is not ${model}` });
            throw new AiError(502, 'community.verification_failed', `community machine ${offer.machine_id} answers as ${String(lastModel).slice(0, 100)}, not ${model}`);
        }
        await markCanary(key, { ok: true });
        return true;
    }

    /** Verify when there is no recent successful canary; a failed offer is never retried by traffic. */
    async function ensure(offer, model) {
        const key = keyOf(offer, model);
        const s = await stateOf(key);
        if (s && s.status === 'failed') throw new AiError(503, 'community.verification_failed', `community machine ${offer.machine_id} failed verification: ${s.failure_reason || 'no reason recorded'}`);
        if (s && s.status === 'verified' && s.last_canary_at && clock.now() - Date.parse(s.last_canary_at) < (cfg.canaryMaxAgeMs || 6 * 60 * 60 * 1000)) return;
        await verify(offer, model);
    }

    async function followers(owner) {
        const hit = followersCache.get(owner);
        if (hit && clock.now() - hit.at < 60000) return hit.subjects;
        if (!followTokens) return new Set();
        const token = await followTokens.getToken({ audience: 'openvibe.network' });
        const subjects = new Set();
        let cursor = null;
        for (let page = 0; page < 20; page++) {
            const url = `${network}/api/v1/follows/channel/${encodeURIComponent(owner)}/followers?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            let res;
            try { res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }); } catch { break; }
            if (!res.ok) break;
            const body = await res.json().catch(() => null);
            for (const f of (body && body.follows) || []) if (f && f.follower) subjects.add(String(f.follower));
            cursor = (body && body.next_cursor) || null;
            if (!cursor) break;
        }
        followersCache.set(owner, { at: clock.now(), subjects });
        return subjects;
    }

    /** Who may use this offer: everyone, the owner's followers, or the caller's group. */
    async function audienceAllows(offer, ctx = {}) {
        if (offer.audience === 'everyone') return true;
        if (offer.audience === 'group') return Boolean(ctx.communityGroup && String(ctx.communityGroup) === String(offer.group));
        const person = ctx.onBehalfOf || null;
        if (!person || !USR.test(String(person))) return false;
        return (await followers(offer.owner)).has(String(person));
    }

    /** The free tier: a run no Balance payer holds (a first-party service, a guest-free run). New machines serve only it. */
    const freeTier = (ctx = {}) => Boolean(ctx.creditsRequired || ctx.communityFree === true);

    /** The eligible offers for one request, cheapest first within the objective, new machines only for the free tier. */
    async function eligible({ ctx = {}, operation = 'chat', route = null } = {}) {
        if (!enabled || !ctx.communityOptIn) return [];
        if (!TEXT_OPS.has(operation)) return [];
        if (ctx.exact) return [];
        const list = await offers();
        const out = [];
        for (const offer of list) {
            // The Node's own ready flag may be a few minutes stale (status is sent on changes); the hours are read here
            // too, so a request outside the owner's window never reaches the machine.
            if (offer.health === 'down' || offer.ready !== true || !withinHours(offer, clock.now())) continue;
            for (const model of offer.models) {
                const key = keyOf(offer, model);
                const s = await stateOf(key);
                if (s && s.status === 'failed') continue;
                if ((!s || s.status === 'new') && !freeTier(ctx)) continue;
                if (ctx.communityModel && String(ctx.communityModel) !== model) continue;
                if (!(await audienceAllows(offer, ctx))) continue;
                if (ctx.communityMaxPriceIn != null && offer.price.in_per_million > Number(ctx.communityMaxPriceIn)) continue;
                if (ctx.communityMaxPriceOut != null && offer.price.out_per_million > Number(ctx.communityMaxPriceOut)) continue;
                out.push({ offer, model, key, status: (s && s.status) || 'new', reputation: s ? Number(s.reputation) || 0 : 0 });
            }
        }
        const objective = ((route || ctx.route) && (route || ctx.route).constraints && (route || ctx.route).constraints.objective) || 'balanced';
        out.sort((a, b) => {
            if (objective === 'lowest-latency') return b.reputation - a.reputation;
            const pa = a.offer.price.in_per_million + a.offer.price.out_per_million;
            const pb = b.offer.price.in_per_million + b.offer.price.out_per_million;
            return pa - pb || b.reputation - a.reputation;
        });
        return out;
    }

    async function choose(args) {
        const list = await eligible(args);
        return list.length ? list[0] : null;
    }

    /** About 1%: the same prompt on a trusted machine with the same model, compared. No trusted peer, no spot. */
    async function spotCheck(chosen, messages, answer) {
        if (!(cfg.spotRate > 0) || random() >= cfg.spotRate) return;
        const peers = (await offers()).filter((o) => o.offer_id !== chosen.offer.offer_id && o.health === 'up' && o.ready && o.models.includes(chosen.model));
        const trusted = [];
        for (const peer of peers) {
            const s = await stateOf(keyOf(peer, chosen.model));
            if (s && s.status === 'verified') trusted.push(peer);
        }
        if (!trusted.length) return;
        const peer = trusted[0];
        let again;
        try { again = await dispatch(peer, chosen.model, messages, { maxTokens: 512, temperature: 0, timeoutMs: cfg.canaryTimeoutMs || 30000, requestId: `spot-${chosen.key}-${clock.now()}` }); }
        catch { return; }
        const at = nowIso(clock);
        if (!similar(answer.text, again.text)) {
            await db.prepare(`UPDATE community_offers SET spot_runs = spot_runs + 1, spot_failures = spot_failures + 1, last_spot_at = ?, status = 'failed', reputation = 0,
                failure_reason = ?, updated_at = ? WHERE offer_key = ?`).run(at, `spot_mismatch against ${peer.machine_id}`, at, chosen.key);
            throw new AiError(502, 'community.verification_failed', `community machine ${chosen.offer.machine_id} disagreed with a trusted machine on the spot re-run`);
        }
        await db.prepare(`UPDATE community_offers SET spot_runs = spot_runs + 1, last_spot_at = ?, updated_at = ? WHERE offer_key = ?`).run(at, at, chosen.key);
        await refreshReputation(chosen.key);
    }

    /** Record what a machine served. Verified tokens earn credits; a new (free-tier) machine's tokens do not. */
    async function recordUsage(chosen, { requestId, usage, verified }) {
        const tin = Math.max(0, Math.trunc(Number(usage && usage.input) || 0));
        const tout = Math.max(0, Math.trunc(Number(usage && usage.output) || 0));
        const micro = verified ? Math.round(tin * chosen.offer.price.in_per_million + tout * chosen.offer.price.out_per_million) : 0;
        const id = `cu_${sha256(`${chosen.key}|${requestId}`).slice(0, 26)}`;
        try {
            await db.prepare(`INSERT INTO community_usage (id, offer_key, offer_id, machine_id, owner_subject, model, request_id, tokens_in, tokens_out, credits_micro, verified, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (offer_key, request_id) DO NOTHING`)
                .run(id, chosen.key, chosen.offer.offer_id, chosen.offer.machine_id, chosen.offer.owner, chosen.model, String(requestId || id), tin, tout, micro, Boolean(verified), nowIso(clock));
        } catch (err) { log.warn(`[community] usage ${chosen.key}: ${err.message}`); }
        return { tokens_in: tin, tokens_out: tout, credits_micro: micro };
    }

    /**
     * One opted-in answer from a community machine: canaries first (unless recently verified), then the request, then
     * the spot check, then the seller's ledger. → the provider-pool result, or null when no offer is eligible.
     */
    async function execute({ route = null, operation = 'chat', req = {}, ctx = {} } = {}) {
        const chosen = await choose({ ctx, operation, route });
        if (!chosen) return null;
        await ensure(chosen.offer, chosen.model);
        // The canary round may just have verified it: this first answer already earns and is no longer free-tier only.
        const fresh = await stateOf(chosen.key);
        if (fresh) { chosen.status = fresh.status; chosen.reputation = Number(fresh.reputation) || 0; }
        const messages = messagesOf(req, operation);
        if (!messages.length) return null;
        const tools = operation === 'complete' ? toolsOf(req) : null;
        const timeoutMs = Math.max(5000, Math.min(Number(req.timeoutMs) || 60000, 300000));
        const requestId = String(ctx.runId || `community-${clock.now()}`);
        const facts = {
            resolved_model: `community/${chosen.model}`, revision: null, deployment: `community:${chosen.offer.machine_id}`,
            provider_access: 'COMMUNITY', rate_version: 'community', policy: 'community',
            community: { machine_id: chosen.offer.machine_id, owner: chosen.offer.owner, model: chosen.model, price: chosen.offer.price,
                verification: chosen.status, reputation: chosen.reputation, free_tier: freeTier(ctx) },
        };
        if (typeof ctx.onRoute === 'function') {
            const routed = await ctx.onRoute(facts, { model: chosen.model, maxTokens: req.maxTokens, paid: false, retail: null });
            if (routed && routed.skip) return null;
        }
        const t0 = clock.now();
        let answer;
        try {
            answer = await dispatch(chosen.offer, chosen.model, messages, {
                maxTokens: Math.max(1, Math.min(Number(req.maxTokens) || 1024, 32768)),
                temperature: req.temperature == null ? null : Number(req.temperature),
                tools, timeoutMs, requestId,
            });
        } catch (err) {
            if (err && (err.code === 'community.busy' || err.code === 'community.not_open')) return null;
            throw err;
        }
        const usage = answer.usage || { input: 0, output: 0, cached: 0 };
        await spotCheck(chosen, messages, answer);
        const recorded = await recordUsage(chosen, { requestId, usage, verified: chosen.status !== 'new' });
        const latencyMs = clock.now() - t0;
        const text = answer.text || '';
        const message = answer.message || { role: 'assistant', content: text };
        const result = operation === 'complete'
            ? { completion: { choices: [{ index: 0, message, finish_reason: answer.finish || (message.tool_calls ? 'tool_calls' : 'stop') }], system_fingerprint: null }, text, json: null, model: answer.model || chosen.model, usage }
            : operation === 'messages'
                ? { message: { role: 'assistant', content: [{ type: 'text', text }], model: answer.model || chosen.model, usage }, model: answer.model || chosen.model, usage }
                : { text, json: null, model: answer.model || chosen.model, usage };
        const community = { ...facts.community, verification: chosen.status, reputation: chosen.reputation, credits_micro: recorded.credits_micro };
        const explain = {
            objective: 'community', reasons: [`a community machine offered ${chosen.model}${chosen.offer.price.in_per_million || chosen.offer.price.out_per_million ? ` at ${chosen.offer.price.in_per_million}/${chosen.offer.price.out_per_million} credits per million` : ' for free'}`],
            selected: `community:${chosen.offer.machine_id}/${chosen.model}`, paid_by: 'community', candidates: [],
            attempts: [{ key: 'community', provider: `community:${chosen.offer.machine_id}`, model: chosen.model, why: 'an opted-in request placed on a verified community machine', status: 'ok', error: null }],
            community, openvibe: facts,
        };
        return {
            result, provider: `community:${chosen.offer.machine_id}`, providerKind: 'community', model: answer.model || chosen.model,
            fallbackUsed: false, usage, cost: 0, latencyMs, ttftMs: null, synthetic: false, tried: [], startedAt: t0, explain,
        };
    }

    /** The /sell dashboard: this owner's offers, what they served, what they earned (credits, never cash). */
    async function sell(owner) {
        if (!USR.test(String(owner))) throw new AiError(422, 'input.invalid', 'owner must be a usr_ subject');
        const list = (await offers({ force: true })).filter((o) => o.owner === owner);
        const rows = await db.prepare(`SELECT offer_key, offer_id, machine_id, models, price_in, price_out, status, canary_passes, canary_failures, spot_runs, spot_failures,
            reputation, last_canary_at, last_spot_at, failure_reason, checks, up_checks
            FROM community_offers WHERE owner_subject = ? ORDER BY updated_at DESC`).all(owner);
        const byKey = new Map(rows.map((r) => [r.offer_key, r]));
        // The dashboard keeps answering from the ledger when Network is unreachable: an offer with state but no live
        // doc is shown from its last recorded settings, marked unknown health.
        const seen = new Set(list.map((o) => o.offer_id));
        for (const r of rows) {
            if (seen.has(r.offer_id)) continue;
            seen.add(r.offer_id);
            const models = Array.isArray(r.models) ? r.models : (() => { try { return JSON.parse(r.models); } catch { return []; } })();
            list.push({ offer_id: r.offer_id, machine_id: r.machine_id, models, hours: null, concurrency: null,
                price: { in_per_million: Number(r.price_in), out_per_million: Number(r.price_out) }, audience: null, group: null, health: 'unknown', ready: false });
        }
        const usage = await db.prepare(`SELECT offer_key, model, COUNT(*)::int AS requests, COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
            COALESCE(SUM(tokens_out),0)::bigint AS tokens_out, COALESCE(SUM(credits_micro),0)::bigint AS credits_micro
            FROM community_usage WHERE owner_subject = ? GROUP BY offer_key, model ORDER BY offer_key`).all(owner);
        const totals = { requests: 0, tokens_in: 0, tokens_out: 0, credits_micro: 0 };
        const served = usage.map((u) => {
            const tokensIn = Number(u.tokens_in), tokensOut = Number(u.tokens_out), credits = Number(u.credits_micro);
            totals.requests += Number(u.requests); totals.tokens_in += tokensIn; totals.tokens_out += tokensOut; totals.credits_micro += credits;
            return { offer_key: u.offer_key, model: u.model, requests: Number(u.requests), tokens_in: tokensIn, tokens_out: tokensOut, credits_micro: credits };
        });
        const offerViews = list.map((o) => {
            const openNow = o.hours ? withinHours(o, clock.now()) : null;
            const out = { offer_id: o.offer_id, machine_id: o.machine_id, models: o.models, hours: o.hours, concurrency: o.concurrency,
                price: o.price, audience: o.audience, group: o.group, health: o.health, open_now: openNow, ready: o.ready && openNow !== false,
                verification: null, reputation: 0, free_only: true };
            const verified = o.models.map((m) => byKey.get(`${o.offer_id}|${m}`)).filter(Boolean);
            if (verified.length) {
                const s = verified.find((x) => x.status === 'verified') || verified[0];
                const canaries = verified.reduce((n, x) => n + Number(x.canary_passes), 0);
                const failures = verified.reduce((n, x) => n + Number(x.canary_failures), 0);
                const spots = verified.reduce((n, x) => n + Number(x.spot_runs), 0);
                const spotFails = verified.reduce((n, x) => n + Number(x.spot_failures), 0);
                const checks = verified.reduce((n, x) => n + Number(x.checks), 0);
                const up = verified.reduce((n, x) => n + Number(x.up_checks), 0);
                out.verification = { status: s.status, canary_passes: canaries, canary_failures: failures, spot_runs: spots, spot_failures: spotFails,
                    last_canary_at: s.last_canary_at, last_spot_at: s.last_spot_at, failure_reason: s.failure_reason };
                out.reputation = Number(s.reputation) || 0;
                out.free_only = s.status !== 'verified';
                out.uptime_pct = checks ? Math.round((up / checks) * 1000) / 10 : null;
            }
            return out;
        });
        return {
            owner, generated_at: nowIso(clock), offers: offerViews,
            totals: { ...totals, credits: totals.credits_micro / 1e6 },
            note: 'Earnings are recorded in credits (1 credit = 1,000,000 micro). Cash payouts come when the owner turns money on; nothing here moves money.',
        };
    }

    /** What Exchange may show about community capacity: no owner subject, no machine id, no prompt. */
    async function publicOffers() {
        const list = await offers();
        return list.map((o) => {
            const openNow = withinHours(o, clock.now());
            return {
                // The public id is a stable hash: Exchange can list and link an offer without publishing which machine it is.
                offer_id: `community_${sha256(o.offer_id).slice(0, 16)}`, models: o.models, hours: o.hours, concurrency: o.concurrency,
                price: o.price, audience: o.audience, health: o.health, open_now: openNow, ready: o.ready && openNow,
            };
        });
    }

    return { enabled, offers, choose, execute, verify, sell, publicOffers, _test: { normalize, withinHours, fingerprintMatches, similar, messagesOf, freeTier } };
}

module.exports = { createCommunity, CANARY_PROMPTS, withinHours, fingerprintMatches, similar, messagesOf };
