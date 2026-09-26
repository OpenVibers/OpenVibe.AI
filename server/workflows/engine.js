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
 *   transcribe   fetch the media (allow-listed hosts only) and run speech-to-text
 *   embed        embeddings
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
const { AiError, sha256, parseJsonLoose } = require('../util');
const { render } = require('../templates');
const { preferenceLines } = require('../user-modules');
const schemas = require('../schemas');
const { PREPARE, POSTPROCESS } = require('./hooks');

const ROLE_TIMEOUT = { chat: 20000, vision: 30000, director: 25000, summary: 30000, legacy: 30000 };

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

function createEngine({ registry, pool, fetcher }) {
    function routeFor(key) {
        const r = registry.resolveRoute(key);
        if (!r) throw new AiError(503, 'route.unavailable', `no route ${key}`);
        if (r.disabled) throw new AiError(503, 'route.unavailable', `route ${key} is disabled`);
        return r;
    }

    async function llmStep(step, input, wf, run, ctx) {
        // The run pinned its template version when it was created; later steps use the active one.
        const template = run.template_key === step.template && run.template_version
            ? registry.getTemplate(step.template, run.template_version)
            : registry.activeTemplate(step.template);
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
        const system = [render(template.system_prompt, vars).trim(), asked].filter(Boolean).join('\n\n');
        const user = render(template.user_prompt, vars);
        const routeKey = step.route || template.default_route || wf.default_route || 'default.chat';
        const route = routeFor(routeKey);
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
            system: system ? [{ text: system, cache: true }] : [],
            messages: [{ role: 'user', content: user }],
            image,
            json: jsonSchema ? { name: (template.metadata && template.metadata.json_name) || 'result', schema: jsonSchema, strict: !prep.jsonSchema } : null,
            maxTokens: Math.max(1, Math.round((prep.params && prep.params.max_tokens) || input.max_tokens || p.max_tokens || route.max_output_tokens || 400)),
            temperature: input.temperature !== undefined ? input.temperature : (p.temperature !== undefined ? p.temperature : null),
            timeoutMs: p.timeout_ms || route.timeout_ms || 30000,
            cacheKey: `${wf.key}:${wf.version}`,
        };
        const exec = await pool.execute(route, step.operation || 'chat', req, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: sha256({ s: system, u: user, i: image ? image.base64.length : 0 }) });
        const r = { text: exec.result.text || '', json: exec.result.json || null };
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
        const route = routeFor(routeKey);
        const sys = typeof input.system === 'string' ? (input.system.trim() ? [{ text: input.system, cache: false }] : [])
            : Array.isArray(input.system) ? input.system.filter(x => x && String(x.text || '').trim()).map(x => ({ text: String(x.text), cache: Boolean(x.cache) })) : [];
        const messages = normMessages(input.messages, input.user);
        const image = input.image ? await fetcher.loadImage({ ...input.image, max_width: input.image.max_width || 1024 }, { signal: ctx.signal }) : null;
        const req = {
            system: sys, messages, image,
            json: input.json ? { name: input.json.name || 'result', schema: input.json.schema, strict: input.json.strict !== false, description: input.json.description } : null,
            maxTokens: Math.max(1, Math.round(input.max_tokens || 400)),
            temperature: input.temperature == null ? null : input.temperature,
            timeoutMs: input.timeout_ms || route.timeout_ms || ROLE_TIMEOUT[input.role] || 25000,
            cacheKey: input.cache_key || null,
        };
        const exec = await pool.execute(route, 'chat', req, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: sha256({ s: sys, m: messages }) });
        let json = exec.result.json || null;
        if (input.json && !json) json = parseJsonLoose(exec.result.text);
        return { output: { text: exec.result.text || '', json }, exec, route };
    }

    async function transcribeStep(step, input, wf, run, ctx) {
        const route = routeFor(step.route || 'live.stt');
        const { file } = await fetcher.loadMediaToFile(input, { signal: ctx.signal });
        try {
            const exec = await pool.execute(route, 'transcribe', { filePath: file, language: input.language || 'en', seconds: input.seconds || 0, offsetSec: input.offset_sec || 0, timeoutMs: 3600000 }, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: null });
            const r = exec.result;
            return { output: { text: r.text || '', language: r.language || input.language || 'en', segments: r.segments || [] }, exec, route };
        } finally {
            try { fs.unlinkSync(file); } catch { /* */ }
        }
    }

    async function embedStep(step, input, wf, run, ctx) {
        const route = routeFor(step.route || 'default.embedding');
        const inputs = Array.isArray(input.input) ? input.input : [input.input];
        const exec = await pool.execute(route, 'embed', { input: inputs, timeoutMs: route.timeout_ms || 30000 }, { ...ctx, routeKey: route.key, routeVersion: route.version, promptHash: null });
        const vectors = exec.result.vectors || [];
        if (vectors.length !== inputs.length) throw new AiError(502, 'output.invalid', 'embedding count does not match the input');
        return { output: { vectors, dimensions: vectors[0] ? vectors[0].length : 0 }, exec, route };
    }

    const STEP = { llm: llmStep, passthrough: passthroughStep, transcribe: transcribeStep, embed: embedStep };

    /**
     * Run a workflow. ctx: { signal, logRequest, debugRaw, inputHash }
     * Returns { output, citations, synthetic, provider, model, fallbackUsed, usage, cost, template, route }.
     */
    async function execute(wf, run, input, ctx) {
        let last = null;
        const usage = { input: 0, output: 0, cached: 0 };
        let cost = 0;
        let exec = null;
        let jsonSchema = null;
        for (const step of wf.steps) {
            const fn = STEP[step.kind];
            if (!fn) throw new AiError(500, 'workflow.broken', `unknown step kind ${step.kind}`);
            last = await fn(step, input, wf, run, ctx);
            if (last.exec) {
                exec = last.exec;
                usage.input += exec.usage.input || 0;
                usage.output += exec.usage.output || 0;
                usage.cached += exec.usage.cached || 0;
                cost += exec.cost || 0;
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
            grounding: groundingOf(last.output, sources.length, citeStep),
            synthetic: Boolean(exec && exec.synthetic),
            provider: exec ? exec.provider : null, model: exec ? exec.model : null, fallbackUsed: Boolean(exec && exec.fallbackUsed),
            usage, cost,
            route: last.route || null,
        };
    }

    return { execute, narrowCitations };
}

module.exports = { createEngine, narrowCitations, collectCited, collectGaps, groundingOf };
