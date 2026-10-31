'use strict';
/**
 * The task-aware router (plan L33 P3 "the router picks for the task", L36 Y7 "a smarter router").
 *
 *   detectTask({ operation, req, ctx, route })  → { vision, tools, json, min_context, reasoning, output, weight }
 *   capabilitiesOf(model, provider)             → what the catalogue knows about one model
 *   hardNeeds(capabilities, task)               → why a model cannot do this job ([] when it can)
 *   rank(candidates, { task, warm, preferred }) → the order the router tries, and why each one is there
 *
 * The requirement set is read off the request itself — a picture in, tools, a JSON schema, how much text,
 * what it wants out — and off the kind of work (the workflow and the route name it). No model is called
 * and nothing is guessed: what a model can do comes from the catalogue (server/providers/catalog.js) and
 * from the provider record, never from a hunch.
 *
 * The rules, in one place:
 *
 *   vision        an image in the request (or a vision operation)
 *   tools         the request carries tools (the OpenAI tools array, or the Messages API's own)
 *   json          the request asks for JSON out (a schema, or response_format)
 *   min_context   the prompt's own size (four characters a token) plus room for the answer
 *   reasoning     deep when the request asks to think (effort high/max, reasoning true), some for code
 *   output        text, image, audio or video
 *   weight        light (classify, short extraction), standard, heavy (code, deep reasoning, long text)
 */
const TIER_RANK = { fast: 0, balanced: 1, strong: 2, frontier: 3 };
const DEFAULT_TIER = 'balanced';

/** The kind of work a run does: the person's ai.me-preferences.defaults has one default per kind. */
function workKind(operation, req = {}, ctx = {}) {
    if (operation === 'image') return 'image';
    if (req && req.image) return 'vision';
    const hint = String(ctx.workflowKey || '') + ' ' + String(ctx.routeKey || '');
    return /\b(code|coding|codes|build|design|program|developer)\b/i.test(hint) ? 'code' : 'text';
}

/** Rough token count of a text: four characters a token. */
const tokensOf = (text) => Math.ceil(String(text || '').length / 4);

/** The prompt that leads a request: its system text, then its messages. */
function leadingText(req = {}) {
    const sys = Array.isArray(req.system) ? req.system.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('\n')
        : (typeof req.system === 'string' ? req.system : '');
    const msgs = Array.isArray(req.messages) ? req.messages.map((m) => {
        if (!m) return '';
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join(' ');
        return '';
    }).join('\n') : '';
    return sys + '\n' + msgs;
}

/** The tools a request carries (the OpenAI tools array, or the Messages API's own). */
function toolCount(req = {}) {
    const openai = req.openai && Array.isArray(req.openai.tools) ? req.openai.tools.length : 0;
    const direct = Array.isArray(req.tools) ? req.tools.length : 0;
    return Math.max(openai, direct);
}

/** Does the request ask for JSON out? (a schema, or the OpenAI response_format) */
function wantsJson(req = {}, route = null) {
    if (req.json) return true;
    const rf = req.openai && req.openai.response_format;
    if (rf && (rf.type === 'json_object' || rf.type === 'json_schema')) return true;
    if (route && route.response_format === 'json') return true;
    return false;
}

/** The reasoning effort the request asks for: 'none' | 'some' | 'deep' ('' when it says nothing). */
function effortOf(req = {}) {
    const raw = String(req.effort || (req.reasoning && typeof req.reasoning === 'object' ? req.reasoning.effort : '') || '').toLowerCase();
    if (['high', 'max', 'xhigh', 'deep', 'maximum'].includes(raw)) return 'deep';
    if (['medium', 'some', 'standard'].includes(raw)) return 'some';
    if (['low', 'minimal', 'none', 'off'].includes(raw)) return 'none';
    if (req.reasoning === true || req.thinking === true) return 'deep';
    return '';
}

/** What the request wants out. */
function outputOf(operation, req = {}) {
    if (operation === 'image' || req.image_out) return 'image';
    if (operation === 'video' || req.video) return 'video';
    if (operation === 'speak' || operation === 'tts' || req.audio) return 'audio';
    return 'text';
}

/** How heavy the work is: light, standard or heavy. */
function weightOf({ operation, kind, reasoning, tools, min_context, maxTokens }) {
    // Code, deep reasoning, a long context or a long answer: the strong models.
    if (reasoning === 'deep' || kind === 'code' || min_context > 32000 || (Number(maxTokens) || 0) > 4000) return 'heavy';
    // A short classification or extraction: the cheapest model that can do it.
    if (!tools && kind !== 'code' && min_context <= 4000 && ['classify', 'extract', 'summarize', 'enrich'].includes(operation)) return 'light';
    return 'standard';
}

/**
 * The requirement set of one request, read without a model call.
 * { vision, tools, json, min_context, reasoning: none|some|deep, output: text|image|audio|video, weight: light|standard|heavy }
 */
function detectTask({ operation = 'chat', req = {}, ctx = {}, route = null } = {}) {
    const kind = workKind(operation, req, ctx);
    const vision = Boolean(req.image) || operation === 'vision';
    const tools = toolCount(req) > 0;
    const json = wantsJson(req, route);
    const min_context = Math.max(1024, tokensOf(leadingText(req)) + (vision ? 1024 : 0) + 512);
    const effort = effortOf(req);
    const reasoning = effort === 'deep' ? 'deep' : (effort === 'some' || kind === 'code' ? 'some' : 'none');
    const output = outputOf(operation, req);
    const weight = weightOf({ operation, kind, reasoning, tools, min_context, maxTokens: req.maxTokens });
    return { vision, tools, json, min_context, reasoning, output, weight };
}

/**
 * What the catalogue knows about one model. The model row is the authority; the provider record's declared
 * capabilities are the fallback for a model the catalogue has not described yet (a model typed in by a
 * person, or a provider whose row carries no capabilities). What the catalogue does not say stays unknown:
 * an unknown context window is not a reason to refuse the work.
 */
function capabilitiesOf(model, provider) {
    const provCaps = new Set((provider && provider.capabilities) || []);
    const meta = (model && model.metadata) || {};
    const supports = (model && model.supports) || null;
    // A model the catalogue described (it synced it) says what it can do: its word beats the provider's
    // general claim. A model a person typed in keeps the provider's claim, so a provider that serves images
    // is not silenced by a row that never mentioned them.
    const described = Boolean(meta.synced_at || meta.listed);
    // true, false or null (nobody said). The catalogue's word on a model it described is the authority; a model
    // nobody described keeps the provider's word; what nobody said stays unknown, and unknown is not a refusal.
    const yes = (flag) => {
        const row = supports ? supports[flag] : null;
        if (row === true) return true;
        if (row === false) return described ? false : (provCaps.has(flag) ? true : null);
        return provCaps.has(flag) ? true : null;
    };
    const type = (model && model.type) || null;
    return {
        vision: yes('vision'),
        tools: yes('tools'),
        json: yes('json'),
        context_window: model && Number(model.context_window) > 0 ? Number(model.context_window) : null,
        reasoning: meta.reasoning === true ? true : (meta.reasoning === false ? false : null),
        tier: TIER_RANK[meta.tier] === undefined ? null : meta.tier,
        type,
        image: type === 'image' || provCaps.has('image'),
        video: type === 'video' || provCaps.has('video'),
        audio: type === 'audio' || type === 'speech' || provCaps.has('audio') || provCaps.has('speech'),
        timeout_ms: Number(meta.timeout_ms) > 0 ? Number(meta.timeout_ms) : null,
    };
}

/**
 * The hard needs: why a model cannot do this job ([] when it can). A model that misses one is never tried.
 */
function hardNeeds(c, task) {
    const missing = [];
    if (task.vision && c.vision === false) missing.push('no_vision');
    if (task.tools && c.tools === false) missing.push('no_tools');
    if (task.json && c.json === false) missing.push('no_json');
    if (task.reasoning === 'deep' && c.reasoning === false) missing.push('no_reasoning');
    if (task.min_context && c.context_window && c.context_window < task.min_context) missing.push('context_too_small');
    if (task.output === 'image' && !c.image) missing.push('no_image_out');
    if (task.output === 'video' && !c.video) missing.push('no_video_out');
    if (task.output === 'audio' && !c.audio) missing.push('no_audio_out');
    return missing;
}

/** The strength tier's rank; a model the catalogue has not tiered counts as balanced. */
const tierRank = (tier) => (TIER_RANK[tier] === undefined ? TIER_RANK[DEFAULT_TIER] : TIER_RANK[tier]);

/**
 * The order the router tries, and why each candidate is there.
 *
 *   light / standard   the cheapest model that can do the job (free capacity first: it costs nothing)
 *   heavy               the catalogue's strength tier first, then the price
 *   within a tier       the person's own default, then health, then latency, then price
 *
 * A warm prompt cache is worth up to 10 % of the price, so a near tie goes to the provider that already
 * has this prompt cached (L36 Y7). The order is stable: two candidates that tie keep the pool's order.
 */
function rank(candidates, { task, warm = null, preferred = null, authority = null, tierFirst = null, keepOrder = false } = {}) {
    const isAuthority = (c) => Boolean(authority && (authority === c.provider || authority === c.provider + ':' + (c.model || '')));
    const lead = tierFirst == null ? task.weight === 'heavy' : Boolean(tierFirst);
    const prepared = candidates.map((c, index) => {
        const price = Number(c.price) || 0;
        const isWarm = Boolean(warm && c.provider === warm);
        return { ...c, index, price, warm: isWarm, effective: isWarm ? price * 0.9 : price, tierRank: tierRank(c.tier), authority: isAuthority(c) };
    });
    const cmp = (a, b) => {
        if (keepOrder) return a.index - b.index;   // a pinned route keeps its own order
        if (a.authority !== b.authority) return a.authority ? -1 : 1;
        if (preferred && (a.model === preferred) !== (b.model === preferred)) return a.model === preferred ? -1 : 1;
        if (lead && a.tierRank !== b.tierRank) return b.tierRank - a.tierRank;
        if (a.effective !== b.effective) return a.effective - b.effective;
        if (a.tierRank !== b.tierRank) return b.tierRank - a.tierRank;
        if (a.health !== b.health) return (a.health || 0) - (b.health || 0);
        if (a.latency !== b.latency) return (a.latency == null ? Infinity : a.latency) - (b.latency == null ? Infinity : b.latency);
        return a.index - b.index;
    };
    const sorted = [...prepared].sort(cmp);
    return { order: sorted, ranked: sorted.slice(0, 5) };
}

/** Why a candidate is there, in a few words (the explain's 'ranked'). */
function reasonFor(entry, task) {
    if (entry.warm) return 'warm cache';
    const caps = [];
    if (task.vision) caps.push('vision');
    if (task.tools) caps.push('tools');
    if (task.json) caps.push('JSON');
    const withCaps = caps.length ? ' with ' + caps.join(' and ') : '';
    if (task.weight === 'heavy') return 'the ' + (entry.tier || 'strong') + ' tier' + withCaps;
    return 'the cheapest' + withCaps;
}


/**
 * The soft preference a request may carry (L37): { provider, model }. The model may be left out, and a string
 * "provider/model" is read as the same thing. Nothing here fails: an unknown id is simply never matched.
 */
function preferredTarget(raw) {
    if (!raw) return null;
    let provider = null;
    let model = null;
    if (typeof raw === 'string') {
        const at = raw.indexOf('/');
        provider = (at === -1 ? raw : raw.slice(0, at)).trim();
        model = at === -1 ? null : raw.slice(at + 1).trim();
    } else if (typeof raw === 'object') {
        provider = raw.provider != null ? String(raw.provider).trim() : null;
        model = raw.model != null ? String(raw.model).trim() : null;
    }
    if (!provider && !model) return null;
    return { provider: provider || null, model: model || null };
}

/** Does this candidate answer to the preference? The provider always, and the model when one was named. */
function preferMatches(provider, model, prefer) {
    if (!prefer) return false;
    if (prefer.provider && String(provider || '') !== prefer.provider) return false;
    if (prefer.model && String(model || '') !== prefer.model) return false;
    return Boolean(prefer.provider || prefer.model);
}

module.exports = { preferredTarget, preferMatches, detectTask, capabilitiesOf, hardNeeds, rank, reasonFor, workKind, leadingText, tokensOf, tierRank, TIER_RANK, DEFAULT_TIER };
