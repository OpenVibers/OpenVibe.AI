'use strict';
/**
 * The workflow engine: executes a workflow version's steps for one run.
 *
 * Step kinds
 *   llm          render a versioned template (prepare hook -> vars), call the route's provider for
 *                the step's operation (chat/generate/summarize/classify/extract/enrich), parse the
 *                answer (structured JSON, or prose repaired like Live did), postprocess hook
 *   passthrough  the caller supplies system/messages (Live features whose prompt Live still renders);
 *                routed by role (route_prefix.role) or a fixed route
 *   transcribe   fetch the media (allow-listed hosts only), or take inline audio (a data URL, written to a
 *                private temp file deleted in the same call), and run speech-to-text
 *   embed        embeddings
 *   media_analysis  local-first media analysis: FFmpeg signals, scenes, local speech-to-text, highlights and
 *                an overview from a local model (or extractive; paid only with a budget). See media-analysis.js.
 *   research     MegaSource (server/research/): Wikipedia, the topic's Fandom wiki, Wikidata, DeepSeek web search,
 *                Commons and Openverse, merged into numbered sources, licensed pictures and facts. No model call.
 *
 * The final output is validated against the workflow's output schema. An empty or invalid answer
 * fails the run (output.empty / output.invalid); nothing is ever filled in. input.sources become
 * citation rows, marked cited when the output's `citations` arrays point at them.
 *
 * Every run also gets `grounding` { cited, gaps } (roadmap WS-O task 3): the source ordinals the
 * output cites, and what it cannot back up. Gaps come from the output's own `gaps` arrays; an output
 * that cites nothing and names no gap gets one written for it (no sources, or sources not cited), so
 * no output ever reads as verified when it is not.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiError, sha256, parseJsonLoose } = require('../util');
const { render } = require('../templates');
const { preferenceLines } = require('../user-modules');
const schemas = require('../schemas');
const { PREPARE, POSTPROCESS } = require('./hooks');
const modelCatalog = require('../providers/model-catalog');
const { buildBody, buildCompleteBody } = require('../providers/openai');
const { PROVIDERS: ENGINES } = require('../research');
const fileInputs = require('../file-inputs');
const filesOut = require('../artifacts');

/** The last user message's text, for the queue's own record of what one item asks (never sent as-is). */
function lastUserText(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user' && typeof m.content === 'string') return m.content.slice(0, 20000);
    }
    return '';
}

const ROLE_TIMEOUT = { chat: 20000, vision: 30000, director: 25000, summary: 30000, legacy: 30000 };
const INLINE_AUDIO_MAX = 1024 * 1024;

/**
 * Inline audio ({ audio: { data_url } }) -> a private temp file the transcribe step deletes. Chat's short spoken
 * messages come this way, so the bytes never need a URL (and never touch storage beyond this call).
 */
function inlineAudioFile(audio) {
    const raw = audio && audio.data_url;
    const mm = /^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(raw || ''));
    if (!mm) throw new AiError(422, 'input.invalid', 'audio.data_url must be a base64 data:audio/* URL');
    const bytes = Buffer.from(mm[2], 'base64');
    if (!bytes.length) throw new AiError(422, 'input.invalid', 'the inline audio is empty');
    if (bytes.length > INLINE_AUDIO_MAX) throw new AiError(413, 'source.too_large', 'inline audio is too large');
    // An unguessable name, created only if nothing is there yet (never through a planted file or link).
    const file = path.join(os.tmpdir(), `openvibe-ai-audio-${require('crypto').randomBytes(12).toString('hex')}`);
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    return file;
}

/** Every string in every `gaps` array of an output, in order, without repeats. */
function collectGaps(v, out = []) {
    if (Array.isArray(v)) { v.forEach((x) => collectGaps(x, out)); return out; }
    if (!v || typeof v !== 'object') return out;
    for (const [k, x] of Object.entries(v)) {
        if (k === 'gaps' && Array.isArray(x)) x.forEach((g) => { const s = typeof g === 'string' ? g.trim() : ''; if (s && !out.includes(s)) out.push(s.slice(0, 300)); });
        else collectGaps(x, out);
    }
    return out;
}

/** { cited, gaps } for one output: never empty-handed, so nothing reads as verified by default. */
function groundingOf(output, sourceCount, citeStep) {
    const cited = citeStep ? [...collectCited(output)].filter((i) => i < sourceCount).sort((a, b) => a - b) : [];
    const gaps = collectGaps(output).slice(0, 20);
    if (!cited.length && !gaps.length) {
        gaps.push(sourceCount === 0
            ? 'No sources were given: this is based on the input alone, and nothing in it is independently verified.'
            : citeStep ? 'None of the given sources is cited: nothing in this is backed by them.' : 'Sources were given but this workflow does not cite them: nothing in this is backed by them.');
    }
    return { cited, gaps };
}

/** Deep copy of a schema with every `citations` array narrowed to valid source indices. */
function narrowCitations(schema, count) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => narrowCitations(s, count));
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'properties' && v && typeof v === 'object') {
            out.properties = {};
            for (const [pk, pv] of Object.entries(v)) {
                if (pk === 'citations' && pv && pv.type === 'array') {
                    out.properties.citations = count > 0
                        ? { ...pv, items: { type: 'integer', minimum: 0, maximum: count - 1 } }
                        : { ...pv, items: { type: 'integer', minimum: 0 }, maxItems: 0 };
                } else out.properties[pk] = narrowCitations(pv, count);
            }
        } else out[k] = narrowCitations(v, count);
    }
    return out;
}

function collectCited(value, set = new Set()) {
    if (Array.isArray(value)) { for (const v of value) collectCited(v, set); return set; }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (k === 'citations' && Array.isArray(v)) v.forEach(i => Number.isInteger(i) && set.add(i));
            else collectCited(v, set);
        }
    }
    return set;
}

function normMessages(messages, user) {
    const out = [];
    for (const m of messages || []) {
        if (!m || !m.role) continue;
        out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    if (user) out.push({ role: 'user', content: user });
    if (!out.length) out.push({ role: 'user', content: '' });
    return out;
}

/**
 * BA3: the answer of a provider's own batch API, when it is resuming the step that asked for it. The
 * batcher says `resume: true` and which kind of step the request was; the step then shapes the stored
 * answer exactly as it shapes a live one.
 */
function batchAnswerFor(ctx, stepKind) {
    const b = ctx && ctx.batchAnswer;
    return b && b.ok === true && b.resume === true && b.stepKind === stepKind ? b : null;
}

/** The exec shape the steps use, built from a batch answer (no provider call, the batch cost). */
function batchExec(b, result) {
    const usage = b.usage || {};
    return {
        result,
        provider: b.provider || null, model: b.model || null,
        usage: { input: Number(usage.input || 0), output: Number(usage.output || 0), cached: Number(usage.cached || 0) },
        cost: Number(b.cost) || 0, serviceTier: 'batch', savedUsd: 0,
        explain: b.explain || null, synthetic: false, fallbackUsed: false,
    };
}

function createEngine({ registry, pool, fetcher, quotas = null, config = {}, spawnImpl, log = console, research = null }) {
    pool = require('../effort/pool').wrapPool(pool);
    // One loopback reader for everything that streams media (server/media-proxy.js): transcripts and media.analyze.
    let proxy = null;
    const reader = () => proxy || (proxy = require('../media-proxy').createMediaProxy({ fetcher, log }));
    const mediaAnalysis = require('./media-analysis').createMediaAnalysis({ registry, pool, fetcher, quotas, config, spawnImpl, log, reader });
    let researcher = research;
    const megasource = () => researcher || (researcher = require('../research').createResearch({ config: config.research || {}, log }));
    async function routeFor(key) {
        const r = await registry.resolveRoute(key);
        if (!r) throw new AiError(503, 'route.unavailable', `no route ${key}`);
        if (r.disabled) throw new AiError(503, 'route.unavailable', `route ${key} is disabled`);
        return r;
    }

    /**
     * Everything an llm step needs before its provider call: the template it pinned, the rendered system and
     * user prompts, the route, the optional image and the request the pool would send. BA3 splits this out of
     * llmStep so the same request can be sent to a provider's own batch API (prepareBatch) and so a batch
     * answer can finish the step on the ordinary path (batchAnswer) without calling a provider again.
     */
    async function prepareLlm(step, input, wf, run, ctx) {
        // The run pinned its template version when it was created; later steps use the active one.
        const template = run.template_key === step.template && run.template_version
            ? await registry.getTemplate(step.template, run.template_version)
            : await registry.activeTemplate(step.template);
        if (!template) throw new AiError(500, 'workflow.broken', `template ${step.template} is missing`);
        const prep = step.prepare ? PREPARE[step.prepare](input) : { vars: input };
        if (!prep) throw new AiError(500, 'workflow.broken', `prepare hook ${step.prepare} is missing`);
        if (prep.output !== undefined) {
            if (prep.output === null) throw new AiError(422, 'input.insufficient', 'the input has nothing this workflow can work from');
            return { output: prep.output, noProvider: true, template };
        }
        const vars = prep.vars || {};
        // The person's ai.preferences (runs on their behalf; server/user-modules.js), after the template's own rules.
        const asked = preferenceLines(ctx && ctx.preferences);
        const rules = render(template.system_prompt, vars).trim();
        const system = [rules, asked].filter(Boolean).join('\n\n');
        // Two system blocks, not one: the template's rules are the same for every run of this version, while a
        // person's preferences change per person and whenever they edit them. The cache breakpoint sits on the rules
        // block only (Anthropic's cache_control on the last stable block; tools → system → messages, so everything
        // before it is the cached prefix), and an OpenAI-compatible endpoint joins the blocks back into one message.
        // Anthropic, "Prompt caching": a breakpoint goes on the last block that stays identical, because a block
        // that changes every request writes a fresh entry and never hits.
        // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
        const systemBlocks = [...(rules ? [{ text: rules, cache: true }] : []), ...(asked ? [{ text: `${rules ? "\n\n" : ""}${asked}` }] : [])];
        const user = render(template.user_prompt, vars);
        const routeKey = step.route || template.default_route || wf.default_route || 'default.chat';
        const route = await routeFor(routeKey);
        const sources = Array.isArray(input.sources) ? input.sources : [];
        let jsonSchema = null;
        if (step.output === 'json') {
            const base = prep.jsonSchema || (template.output_schema && template.output_schema.properties ? template.output_schema : wf.output_schema);
            jsonSchema = step.cite ? narrowCitations(base, sources.length) : base;
            if (prep.jsonSchema) {
                try { schemas.assertSchema(jsonSchema, 'schema'); } catch (e) { throw new AiError(422, 'input.invalid', e.message); }
            }
        }
        const image = step.image && input[step.image] ? await fetcher.loadImage({ ...input[step.image], max_width: input[step.image].max_width || step.image_max_width || 1024 }, { signal: ctx.signal }) : null;
        const p = { ...(route.options || {}), ...(step.params || {}), ...(prep.params || {}) };
        const req = {
            system: systemBlocks,
            messages: [{ role: 'user', content: user }],
            image,
            json: jsonSchema ? { name: (template.metadata && template.metadata.json_name) || 'result', schema: jsonSchema, strict: !prep.jsonSchema } : null,
            maxTokens: Math.max(1, Math.round((prep.params && prep.params.max_tokens) || input.max_tokens || p.max_tokens || route.max_output_tokens || 400)),
            temperature: input.temperature !== undefined ? input.temperature : (p.temperature !== undefined ? p.temperature : null),
            timeoutMs: p.timeout_ms || route.timeout_ms || 30000,
            cacheKey: `${wf.key}:${wf.version}`,
        };
        return { template, prep, vars, system, user, route, jsonSchema, image, req };
    }

    async function llmStep(step, input, wf, run, ctx) {
        const p = await prepareLlm(step, input, wf, run, ctx);
        if (p.output !== undefined) return { output: p.output, noProvider: true, template: p.template };
        const { template, system, user, route, jsonSchema, image, req } = p;
        // BA3: the answer came from the provider's own batch API. The step shapes it as it shapes a live
        // answer (JSON parse, postprocess, citations); no provider is called again.
        const batch = batchAnswerFor(ctx, 'llm');
        const exec = batch
            ? batchExec(batch, { text: (batch.output && batch.output.text) || '' })
            : await pool.execute(route, step.operation || 'chat', req, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: sha256({ s: system, u: user, i: image ? image.base64.length : 0 }) });
        // synthetic: the stub answered (no provider configured, or a test); a postprocess that checks an answer's
        // substance (a space needs a real index.html) lets a synthetic answer through in the right shape.
        const r = { text: exec.result.text || '', json: exec.result.json || null, synthetic: Boolean(exec.synthetic) };
        if (step.output === 'json' && !r.json) r.json = parseJsonLoose(r.text);
        let output;
        if (step.postprocess) {
            const post = POSTPROCESS[step.postprocess];
            if (!post) throw new AiError(500, 'workflow.broken', `postprocess hook ${step.postprocess} is missing`);
            output = post(r, input);
        } else if (step.wrap) {
            const v = step.output === 'json' ? r.json : r.text;
            output = v == null || v === '' ? null : { [step.wrap]: v };
        } else {
            output = step.output === 'json' ? r.json : (r.text ? { text: r.text } : null);
        }
        if (output == null) throw new AiError(502, 'output.empty', 'the provider answered, but not with anything usable');
        return { output, exec, template, route, jsonSchema };
    }

    async function passthroughStep(step, input, wf, run, ctx) {
        const routeKey = step.route || `${step.route_prefix || 'live'}.${input.role || 'legacy'}`;
        const route = await routeFor(routeKey);
        const sys = typeof input.system === 'string' ? (input.system.trim() ? [{ text: input.system, cache: false }] : [])
            : Array.isArray(input.system) ? input.system.filter(x => x && String(x.text || '').trim()).map(x => ({ text: String(x.text), cache: Boolean(x.cache) })) : [];
        const base = { ...input, messages: normMessages(input.messages, input.user) };
        // Files on the turn (ai.file@1) become text or image content for this call only.
        const turn = Array.isArray(input.files) && input.files.length
            ? await fileInputs.attachFiles(base, fetcher, { signal: ctx.signal, format: 'openai', vision: true })
            : base;
        const messages = turn.messages;
        const image = input.image ? await fetcher.loadImage({ ...input.image, max_width: input.image.max_width || 1024 }, { signal: ctx.signal }) : null;
        const req = {
            system: sys, messages, image,
            ...(turn.hasImage ? { vision: true } : {}),
            json: input.json ? { name: input.json.name || 'result', schema: input.json.schema, strict: input.json.strict !== false, description: input.json.description } : null,
            maxTokens: Math.max(1, Math.round(input.max_tokens || 400)),
            temperature: input.temperature == null ? null : input.temperature,
            timeoutMs: input.timeout_ms || route.timeout_ms || ROLE_TIMEOUT[input.role] || 25000,
            cacheKey: input.cache_key || null,
            prefer: ctx.prefer || null,
        };
        const batch = batchAnswerFor(ctx, 'passthrough');
        const exec = batch
            ? batchExec(batch, { text: (batch.output && batch.output.text) || '' })
            : await pool.execute(route, 'chat', req, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: sha256({ s: sys, m: messages }) });
        let json = exec.result.json || null;
        if (input.json && !json) json = parseJsonLoose(exec.result.text);
        return { output: { text: exec.result.text || '', json }, exec, route };
    }

    /**
     * The model the caller named (AI Exchange D3/D4, AI_MODEL_CATALOG): an exact id runs only its own artifact, a
     * dynamic alias turns into the same route with that policy's placement constraints. With the flag off this is
     * never called, so today's route selection is unchanged.
     */
    async function selectedRoute(base, input) {
        if (input.compat_routing) {
            const routing = require('../exchange/compat-routing');
            const source = input.compat_routing;
            if (!Array.isArray(source.entries) || !source.entries.length || source.entries.length > 8)
                throw new AiError(400, 'input.invalid', 'One to eight routing models are required');
            const entries = source.entries.map(e => routing.modelName(e.model + (e.variant ? ':' + e.variant : '')));
            const policy = routing.normalize(source.policy);
            const providers = new Map((await registry.listProviders()).map(p => [p.key, p]));
            const rows = await registry.listModels();
            const offers = [];
            for (const [group, entry] of entries.entries()) {
                const dynamic = ['openvibe', 'openvibe/auto'].includes(entry.model);
                for (const row of rows) {
                    const provider = providers.get(row.provider_key);
                    if (!provider || row.status !== 'active' || provider.status !== 'active') continue;
                    const wantedType = base.capability === 'embed' ? 'embedding' : base.capability === 'image' ? 'image' : 'chat';
                    if (row.type !== wantedType && !(wantedType === 'chat' && row.type === 'vision')) continue;
                    if (!modelCatalog.managedAccessAllowed(provider) || provider.metadata?.hidden || provider.metadata?.synthetic) continue;
                    if (!dynamic && require('../exchange/catalog').canonicalOf(row, provider) !== entry.model && row.metadata?.id !== entry.model) continue;
                    if (row.metadata?.hidden || row.metadata?.synthetic || row.metadata?.restricted || row.metadata?.byok) continue;
                    if (['CUSTOMER_BYOK', 'RESTRICTED'].includes(row.provider_access || row.metadata?.provider_access)) continue;
                    offers.push({ provider: row.provider_key, model: row.model_key, group, variant: entry.variant });
                }
            }
            if (!offers.length) throw new AiError(404, 'ai.model_not_found', 'No requested model is available');
            return { route: base, selection: { kind: 'compat', offers, policy } };
        }
        if (!(config.modelCatalog && config.modelCatalog.enabled) || typeof input.model !== 'string' || !input.model.trim()) return { route: base, selection: null };
        const selection = await modelCatalog.select({ registry, model: input.model.trim(), route: base });
        return { route: selection.route, selection };
    }

    function selectionCtx(selection) {
        if (!selection) return {};
        if (selection.kind === 'compat') return { compatRouting: selection,
            exact: { id: 'requested model fallbacks', offers: selection.offers } };
        return selection.kind === 'exact'
            ? { policy: 'exact', exact: { id: selection.id, offers: selection.offers.map((o) => ({ provider: o.provider, model: o.model })) } }
            : { policy: selection.policy, aliasPolicy: selection.policy };
    }

    /**
     * BA3: the provider request of a run that may wait for a provider's own batch. Only a workflow with a
     * single provider step can be batched: a batch API answers one request, not a workflow's later steps.
     * The body is built for the model the run is placed on (the batcher knows it after the money check).
     *
     * → { stepKind, operation, route, maxTokens, prompt, bodyFor(model) } or null.
     */
    async function prepareBatch(wf, run, input, ctx = {}) {
        if (!wf || !Array.isArray(wf.steps) || wf.steps.length !== 1) return null;
        // Attachments are read from Media at execution time; a provider batch request cannot carry them.
        if (Array.isArray(input && input.files) && input.files.length) return null;
        const step = wf.steps[0];
        if (step.kind === 'llm') {
            // An image cannot travel in a provider batch request here: the answer would need the media file.
            if (step.image && input && input[step.image]) return null;
            const p = await prepareLlm(step, input, wf, run, ctx);
            if (!p || p.output !== undefined || p.image) return null;
            const bodyFor = (model) => buildBody({
                model, system: p.req.system, messages: p.req.messages, image: null,
                json: p.req.json, maxTokens: p.req.maxTokens, temperature: p.req.temperature,
                cacheKey: null, baseUrl: '', serviceTier: null,
            }, 'schema');
            return { stepKind: 'llm', operation: step.operation || 'chat', route: p.route, maxTokens: p.req.maxTokens, bodyFor, prompt: lastUserText(p.req.messages) };
        }
        if (step.kind === 'complete') {
            const { route } = await selectedRoute(await routeFor(step.route || 'default.chat'), input);
            const openai = {};
            for (const k of ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'seed', 'top_p', 'presence_penalty', 'frequency_penalty']) {
                if (input[k] !== undefined) openai[k] = input[k];
            }
            if (!Array.isArray(openai.messages) || !openai.messages.length) return null;
            const maxTokens = Math.max(1, Math.round(input.max_tokens || route.max_output_tokens || 1024));
            const temperature = input.temperature == null ? null : input.temperature;
            return {
                stepKind: 'complete', operation: 'complete', route, maxTokens, prompt: lastUserText(openai.messages),
                bodyFor: (model) => buildCompleteBody({ model, openai, maxTokens, temperature }),
            };
        }
        if (step.kind === 'passthrough') {
            if (input.image) return null;
            const route = await routeFor(step.route || `${step.route_prefix || 'live'}.${input.role || 'legacy'}`);
            const sys = typeof input.system === 'string' ? (input.system.trim() ? [{ text: input.system, cache: false }] : [])
                : Array.isArray(input.system) ? input.system.filter(x => x && String(x.text || '').trim()).map(x => ({ text: String(x.text), cache: Boolean(x.cache) })) : [];
            const messages = normMessages(input.messages, input.user);
            const json = input.json ? { name: input.json.name || 'result', schema: input.json.schema, strict: input.json.strict !== false, description: input.json.description } : null;
            const maxTokens = Math.max(1, Math.round(input.max_tokens || 400));
            const temperature = input.temperature == null ? null : input.temperature;
            return {
                stepKind: 'passthrough', operation: 'chat', route, maxTokens, prompt: lastUserText(messages),
                bodyFor: (model) => buildBody({ model, system: sys, messages, image: null, json, maxTokens, temperature, cacheKey: null, baseUrl: '', serviceTier: null }, 'schema'),
            };
        }
        return null;
    }

    /** complete: the OpenAI Chat Completions request as the caller wrote it (ai.complete), to an upstream that speaks it. */
    async function completeStep(step, input, wf, run, ctx) {
        const { route, selection } = await selectedRoute(await routeFor(step.route || 'default.chat'), input);
        // Media-backed files on the turn (ai.file@1) become text or image content for this call only.
        const turn = Array.isArray(input.files) && input.files.length
            ? await fileInputs.attachFiles(input, fetcher, { signal: ctx.signal, format: 'openai', vision: true })
            : input;
        const openai = {};
        for (const k of ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'seed', 'top_p', 'presence_penalty', 'frequency_penalty']) {
            if (turn[k] !== undefined) openai[k] = turn[k];
        }
        const req = {
            openai,
            maxTokens: Math.max(1, Math.round(input.max_tokens || route.max_output_tokens || 1024)),
            temperature: input.temperature == null ? null : input.temperature,
            timeoutMs: Math.max(route.timeout_ms || 0, 120000),
            prefer: ctx.prefer || null,
            ...(turn.hasImage ? { vision: true } : {}),
            ...(typeof ctx.onDelta === 'function' ? { onDelta: ctx.onDelta } : {}),
        };
        const batch = batchAnswerFor(ctx, 'complete');
        const exec = batch
            ? batchExec(batch, { completion: (batch.output && batch.output.completion) || null })
            : await pool.execute(route, 'complete', req, { ...ctx, ...selectionCtx(selection), routeKey: route.key, routeVersion: route.version, promptHash: sha256({ m: openai.messages, t: openai.tools || null }) });
        const c = exec.result.completion;
        if (!c || !Array.isArray(c.choices) || !c.choices.length) throw new AiError(502, 'output.empty', 'the provider answered, but with no choices');
        // Files the model produced beside its text: Media references pass through; inline bytes need the
        // configured Media store (server/artifacts.js), never the run's output.
        const subject = ctx.onBehalfOf && ctx.onBehalfOf.id ? ctx.onBehalfOf.id : null;
        const artifacts = await filesOut.collectArtifacts(c.choices[0] && c.choices[0].message, { store: filesOut.storeOf(config), subject });
        return { output: { choices: c.choices, system_fingerprint: c.system_fingerprint || null, model: exec.model, ...(artifacts.length ? { artifacts } : {}) }, exec, route };
    }

    /**
     * messages: the caller's Anthropic Messages API request as they wrote it (ai.messages, POST /v1/messages), to an
     * upstream that speaks that format. The run's output is the message (consumed by server/api/messages.js).
     */
    async function messagesStep(step, input, wf, run, ctx) {
        const { route, selection } = await selectedRoute(await routeFor(step.route || 'default.messages'), input);
        // Media-backed files on the turn (ai.file@1): text parts, or base64 image sources for a vision model.
        const turn = Array.isArray(input.files) && input.files.length
            ? await fileInputs.attachFiles(input, fetcher, { signal: ctx.signal, format: 'anthropic', vision: true })
            : input;
        const req = {
            messages: turn.messages,
            maxTokens: Math.max(1, Math.round(input.max_tokens || route.max_output_tokens || 1024)),
            timeoutMs: Math.max(route.timeout_ms || 0, 120000),
            prefer: ctx.prefer || null,
            ...(turn.hasImage ? { vision: true } : {}),
            ...(typeof ctx.onDelta === 'function' ? { onDelta: ctx.onDelta } : {}),
        };
        for (const k of ['system', 'tools', 'tool_choice', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'metadata']) {
            if (input[k] !== undefined) req[k] = input[k];
        }
        const exec = await pool.execute(route, 'messages', req, { ...ctx, ...selectionCtx(selection), routeKey: route.key, routeVersion: route.version, promptHash: sha256({ m: turn.messages, t: input.tools || null }) });
        const m = exec.result.message;
        if (!m || !Array.isArray(m.content)) throw new AiError(502, 'output.empty', 'the provider answered, but not with a message');
        const subject = ctx.onBehalfOf && ctx.onBehalfOf.id ? ctx.onBehalfOf.id : null;
        const artifacts = await filesOut.collectArtifacts(m, { store: filesOut.storeOf(config), subject });
        return { output: { ...m, model: m.model || exec.model, ...(artifacts.length ? { artifacts } : {}) }, exec, route };
    }

    async function transcribeStep(step, input, wf, run, ctx) {
        const route = await routeFor(step.route || 'live.stt');
        // Read where it lies (the loopback reader), one window at a time: start_sec seeks with a range request, and
        // timestamps are offset by start_sec unless offset_sec says otherwise. AI_MEDIA_STREAM=0 downloads first.
        // Inline audio (a short spoken message) needs no fetch: it becomes a private temp file, deleted below.
        const inline = input.audio && input.audio.data_url ? inlineAudioFile(input.audio) : null;
        const streamed = !inline && (!config.mediaAnalysis || config.mediaAnalysis.stream !== false);
        const handle = streamed ? await reader().register(fetcher.mediaUrlOf(input)) : null;
        const file = inline || (handle ? handle.url : (await fetcher.loadMediaToFile(input, { signal: ctx.signal })).file);
        try {
            const startSec = Number(input.start_sec) || 0;
            const offsetSec = input.offset_sec != null ? Number(input.offset_sec) : startSec;
            const exec = await pool.execute(route, 'transcribe', { filePath: file, language: input.language || 'en', seconds: input.seconds || 0, startSec, offsetSec, lowPower: input.low_power === true, words: input.words === true, timeoutMs: 3600000 }, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: null });
            const r = exec.result;
            return { output: { text: r.text || '', language: r.language || input.language || 'en', segments: r.segments || [] }, exec, route };
        } finally {
            if (handle) handle.release();
            else { try { fs.unlinkSync(file); } catch { /* */ } }
        }
    }

    async function embedStep(step, input, wf, run, ctx) {
        const { route, selection } = await selectedRoute(await routeFor(step.route || 'default.embedding'), input);
        const inputs = Array.isArray(input.input) ? input.input : [input.input];
        const exec = await pool.execute(route, 'embed', { input: inputs, timeoutMs: route.timeout_ms || 30000 }, { ...ctx, ...selectionCtx(selection), routeKey: route.key, routeVersion: route.version, promptHash: null });
        const vectors = exec.result.vectors || [];
        if (vectors.length !== inputs.length) throw new AiError(502, 'output.invalid', 'embedding count does not match the input');
        return { output: { vectors, dimensions: vectors[0] ? vectors[0].length : 0 }, exec, route };
    }

    async function imageStep(step, input, wf, run, ctx) {
        const { route, selection } = await selectedRoute(await routeFor(step.route || 'default.image'), input);
        const prompt = String(input.prompt || '').trim();
        if (!prompt) throw new AiError(422, 'input.invalid', 'image needs a prompt');
        const req = { prompt, size: input.size || (step.params && step.params.size) || (config.image && config.image.size) || null, n: Math.max(1, Math.min(Number(input.n) || 1, 4)), timeoutMs: route.timeout_ms || 120000 };
        const exec = await pool.execute(route, 'image', req, { ...ctx, ...(input.compat_routing ? { freeOnly: true } : {}), ...selectionCtx(selection), routeKey: route.key, routeVersion: route.version, promptHash: sha256({ p: prompt }) });
        const images = (exec.result.images || []).filter(i => i && (i.b64 || i.url));
        if (!images.length) throw new AiError(502, 'output.invalid', 'no image was returned');
        return { output: { images: images.map(i => ({ b64: i.b64 || null, url: i.url || null })), count: images.length }, exec, route };
    }

    /** research: no model call. A developer app's run leaves the paid web search out (its DeepSeek calls are ours). */
    async function researchStep(step, input, wf, run, ctx) {
        let output, answered = null, engineIndex = 0, candidates = [];
        try {
            // Search's own web ladder calls this endpoint for DeepSeek and Wikipedia. It must not be asked back
            // (Search -> AI research -> Search): every other caller gets the fabric first, Search keeps DeepSeek.
            const fromSearch = ctx.requesterType === 'service' && ctx.requesterId === 'search';
            if (ctx.taskChoice?.task.kind === 'search') {
                // A search task runs the engines its choice names, in order: the owner's saved order when the owner's
                // default won, else the chosen engine and the task's fallbacks. A disabled engine is never called, and
                // DeepSeek (the one paid engine) is skipped under a cost ceiling, which has no per-run bound for it.
                const plan = ctx.taskChoice;
                if (plan.choice.source !== 'openvibe') throw new AiError(422, 'choice.unsupported', 'search uses OpenVibe search engines only');
                const engineOf = (model) => String(model).replace(/^search\//, '');
                const asked = engineOf(plan.choice.model);
                const ordered = plan.why === 'owner' && plan.search_engines.length
                    ? plan.search_engines.filter((e) => e.enabled).map((e) => e.engine)
                    : [...new Set([asked, ...plan.fallbacks.map((c) => engineOf(c.model))])];
                if (!ordered.length) throw new AiError(422, 'choice.unavailable', 'no search engine is enabled for this task');
                candidates = ordered.map((engine) => ({
                    provider: engine, model: `search/${engine}`,
                    eligible: engine !== 'deepseek' || plan.max_cost_usd == null,
                    excluded_reason: engine === 'deepseek' && plan.max_cost_usd != null ? 'cost ceiling has no per-run bound' : null,
                }));
                const images = plan.task.kind === 'search' && plan.task.name !== 'search.web';
                for (const engine of ordered) {
                    if (ENGINES.includes(engine) === false) throw new AiError(422, 'choice.unavailable', `unknown search engine ${engine}`);
                    if (engine === 'deepseek' && plan.max_cost_usd != null) continue;
                    const got = await megasource().gather({ ...input, providers: [engine], images }, { signal: ctx.signal, allowPaid: !ctx.appRun && plan.max_cost_usd == null, allowFabric: false });
                    if (images ? got.images.length : got.sources.length) { output = got; answered = engine; engineIndex = ordered.indexOf(engine); break; }
                    output = got;
                }
                if (answered == null) throw new AiError(402, 'choice.cost_ceiling', 'no enabled search engine answered within this task’s ceiling');
            } else output = await megasource().gather(input, { signal: ctx.signal, allowPaid: !ctx.appRun, allowFabric: !fromSearch });
        } catch (err) {
            if (err && err.status === 422) throw new AiError(422, 'input.invalid', err.message);
            throw err;
        }
        if (!output.sources.length && !output.images.length) {
            // A writer already has its article's sources: web search finding nothing new is not a failed run.
            if (Array.isArray(input.sources) && input.sources.length) output = { ...output, sources: input.sources };
            else throw new AiError(502, 'source.unavailable', `no source answered for "${output.query}"`, { providers: output.providers });
        }
        // Recorded like a provider call: DeepSeek's per-call price counts against the cost quotas and the daily usage.
        const exec = { provider: 'research', model: 'megasource', usage: { input: 0, output: 0, cached: 0 }, cost: Number(output.usage && output.usage.cost_usd) || 0, synthetic: false, fallbackUsed: false, explain: ctx.taskChoice ? {
            // The contract's explain needs an objective, a reason, what was selected and the candidates; a search
            // task's candidates are its engines, and the one that answered is the selection.
            objective: 'exact',
            reasons: [`search task ${ctx.taskChoice.task.name}: ${answered} answered`],
            selected: `search/${answered}`, candidates,
            task_choice: { task: ctx.taskChoice.task.name, requested: ctx.taskChoice.choice, answered: { model: `search/${answered}`, source: 'openvibe' }, why: ctx.taskChoice.why, fallback_index: engineIndex },
        } : null };
        return { output, exec };
    }

    /** A research run's grounding: what it read is the output itself; the gaps are the sources that did not answer. */
    function researchGrounding(output) {
        const gaps = Object.entries((output && output.providers) || {}).filter(([, p]) => p && !p.ok)
            .map(([name, p]) => `${name}: ${p.skipped || p.error || 'did not answer'}`.slice(0, 300));
        return { cited: [], gaps: gaps.slice(0, 20), read: (output && output.sources ? output.sources.length : 0) };
    }

    async function devblogStep(step, input, wf, run, ctx) {
        const usage = { input: 0, output: 0, cached: 0 };
        let cost = 0, savedUsd = 0, last;
        const output = await require('./devblog').execute({ input, call: async (phase, payload) => {
            last = await llmStep({ kind: 'llm', template: `content.devblog.${phase}`, output: 'json', operation: 'generate', params: { max_tokens: 6000, temperature: 0.3 } }, { payload: JSON.stringify(payload) }, wf, run, ctx);
            const valid = schemas.validate(last.jsonSchema, last.output);
            if (!valid.valid) throw new AiError(502, 'output.invalid', 'Invalid devblog agent response');
            for (const key of Object.keys(usage)) usage[key] += last.exec.usage[key] || 0;
            cost += last.exec.cost || 0; savedUsd += Number(last.exec.savedUsd) || 0;
            return last.output;
        } });
        return { output, exec: { ...last.exec, usage, cost, savedUsd }, route: last.route };
    }

    const STEP = { devblog: devblogStep, llm: llmStep, passthrough: passthroughStep, complete: completeStep, messages: messagesStep, transcribe: transcribeStep, embed: embedStep, image: imageStep, media_analysis: mediaAnalysis.step, research: researchStep };

    /**
     * Run a workflow. ctx: { signal, logRequest, debugRaw, inputHash }
     * Returns { output, citations, synthetic, provider, model, fallbackUsed, usage, cost, template, route }.
     */
    async function execute(wf, run, input, ctx) {
        let last = null;
        const usage = { input: 0, output: 0, cached: 0 };
        let cost = 0;
        // BA1: what the wait earned, over every call the run made (a run may call a provider more than once).
        let saved = 0;
        let exec = null;
        let jsonSchema = null;
        let researchOut = null;
        for (const step of wf.steps) {
            const fn = STEP[step.kind];
            if (!fn) throw new AiError(500, 'workflow.broken', `unknown step kind ${step.kind}`);
            last = await fn(step, input, wf, run, ctx);
            // A research step feeds the steps after it: what it read joins input.sources, with the caller's own
            // sources first and no URL twice, so the writer cites the numbered list it was shown.
            if (step.kind === 'research' && last && last.output) {
                researchOut = last.output;
                const before = Array.isArray(input.sources) ? input.sources : [];
                const seen = new Set(before.map((s) => s && s.url).filter(Boolean));
                const added = (Array.isArray(last.output.sources) ? last.output.sources : []).filter((s) => s && s.url && !seen.has(s.url));
                if (added.length) input = { ...input, sources: [...before, ...added] };
                // The structured facts research read (Wikidata and the sources) fill a wiki article's infobox.
                if (Array.isArray(last.output.facts) && last.output.facts.length) input = { ...input, facts: last.output.facts };
            }
            if (last.exec) {
                exec = last.exec;
                usage.input += exec.usage.input || 0;
                usage.output += exec.usage.output || 0;
                usage.cached += exec.usage.cached || 0;
                cost += exec.cost || 0;
                saved += Number(exec.savedUsd) || 0;
            }
            if (last.jsonSchema) jsonSchema = last.jsonSchema;
        }
        const sources = Array.isArray(input.sources) ? input.sources : [];
        const citeStep = wf.steps.some(s => s.cite);
        const outSchema = citeStep ? narrowCitations(wf.output_schema, sources.length) : wf.output_schema;
        const v = schemas.validate(outSchema, last.output);
        if (!v.valid) throw new AiError(502, 'output.invalid', `output does not match ${wf.key} v${wf.version}: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`, { errors: v.errors });
        const cited = collectCited(last.output);
        const citations = sources.map((s, i) => ({
            ordinal: i, source_type: s.source_type, source_id: s.source_id || null, url: s.url || null, title: s.title || null, author: s.author || null,
            published_at: s.published_at || null, retrieved_at: s.retrieved_at || s.observed_at || null, snippet: s.snippet ? String(s.snippet).slice(0, 1000) : null,
            content_hash: s.content ? sha256(String(s.content)) : null, trust: s.trust || {}, provenance: { ...(s.provenance || {}), cited: citeStep ? cited.has(i) : null },
        }));
        return {
            output: last.output, citations, jsonSchema,
            grounding: researchOut
                ? (wf.steps.length === 1
                    ? researchGrounding(researchOut)
                    : (() => {
                        // A workflow that researches and then writes: what was read, and what the answer cites.
                        const read = researchGrounding(researchOut);
                        const wrote = groundingOf(last.output, sources.length, citeStep);
                        return { ...read, cited: wrote.cited, gaps: [...read.gaps, ...wrote.gaps].slice(0, 20) };
                    })())
                : groundingOf(last.output, sources.length, citeStep),
            synthetic: Boolean(exec && exec.synthetic),
            provider: exec ? exec.provider : null, model: exec ? exec.model : null, fallbackUsed: Boolean(exec && exec.fallbackUsed),
            ...(exec && exec.result && exec.result.label ? { contentPolicy: exec.result.policy || 'uncensored', label: exec.result.label } : {}),
            usage, cost,
            // BA1: the tier the answer really ran on, and what waiting for it earned.
            serviceTier: exec ? exec.serviceTier || null : null, savedUsd: saved,
            route: last.route || null,
            explain: exec ? exec.explain || null : null,
        };
    }

    return { execute, prepareBatch, narrowCitations, research: () => megasource() };
}

module.exports = { createEngine, narrowCitations, collectCited, collectGaps, groundingOf };
