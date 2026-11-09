'use strict';
const express = require('express');
const { CAPS } = require('../auth');
const { AiError, sendError } = require('../util');
function accounting(run) {
    return { cost: Number(run.usage.cost_usd || 0), latency: Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at || run.created_at)) || 0,
        provider: run.provenance?.provider || null };
}
function compatExtra({ runs, auth, config, log }) {
    const r = express.Router();
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (err) { sendError(res, err, req.ov, log); } };
    r.get('/v1/generation', allow, wrap(async (req, res) => {
        const id = String(req.query.id || '').replace(/^(chatcmpl-|msg_)/, '');
        const run = await runs.get(id);
        const p = req.principal;
        // Never use an on_behalf_of claim to widen access to another requester's history.
        const owner = p.subject?.id;
        const type = p.subject?.type;
        if (!run || run.requester.type !== type || run.requester.id !== owner)
            throw new AiError(404, 'generation.not_found', 'Generation not found');
        res.set('Cache-Control', 'no-store').json({ data: { id: run.id, model: run.provenance.model,
            ...accounting(run), total_cost: Number(run.usage.cost_usd || 0),
            tokens_prompt: run.usage.tokens_in, tokens_completion: run.usage.tokens_out, created_at: run.created_at } });
    }));
    r.post('/v1/embeddings', allow, wrap(async (req, res) => {
        const b = req.body || {};
        if (b.encoding_format && b.encoding_format !== 'float') throw new AiError(400, 'input.invalid', 'Only float embeddings are supported');
        if (b.dimensions !== undefined) throw new AiError(400, 'input.invalid', 'Custom dimensions are not supported');
        const input = { input: b.input, max_cost_usd: b.max_cost_usd };
        if (b.model || b.provider || b.models) input.compat_routing = require('../exchange/compat-routing').request(b);
        const created = await runs.create({ workflow: 'ai.embed', input, idempotency_key: req.get('idempotency-key') || undefined }, req.principal, { trace: req.ov?.traceId });
        if (!created.created) res.set('x-openvibe-replayed', '1');
        const run = await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000));
        if (['succeeded', 'cached', 'failed', 'cancelled'].includes(run.status)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (!['succeeded', 'cached'].includes(run.status)) throw new AiError(503, run.error?.code || 'run.failed', run.error?.detail || 'Embedding unavailable');
        res.json({ id: run.id, object: 'list', model: run.provenance.model,
            data: run.output.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
            usage: { prompt_tokens: run.usage.tokens_in, total_tokens: run.usage.tokens_in, ...(b.usage?.include ? accounting(run) : {}) },
            x_openvibe: { run_id: run.id, cost_usd: run.usage.cost_usd, provider: run.provenance.provider } });
    }));
    r.post('/v1/images/generations', allow, wrap(async (req, res) => {
        const b = req.body || {};
        if (b.response_format && !['url', 'b64_json'].includes(b.response_format)) throw new AiError(400, 'input.invalid', 'Unknown image response format');
        const input = { prompt: b.prompt, ...(b.size ? { size: b.size } : {}), ...(b.n ? { n: b.n } : {}), max_cost_usd: b.max_cost_usd };
        if (b.model || b.provider || b.models) input.compat_routing = require('../exchange/compat-routing').request(b);
        const created = await runs.create({ workflow: 'ai.image', input, idempotency_key: req.get('idempotency-key') || undefined }, req.principal, { trace: req.ov?.traceId });
        if (!created.created) res.set('x-openvibe-replayed', '1');
        const run = await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000));
        if (['succeeded', 'cached', 'failed', 'cancelled'].includes(run.status)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (!['succeeded', 'cached'].includes(run.status)) throw new AiError(503, run.error?.code || 'run.failed', run.error?.detail || 'Image provider unavailable');
        res.json({ id: run.id, created: Math.floor(Date.parse(run.created_at) / 1000),
            data: run.output.images.map(i => i.b64 ? { b64_json: i.b64 } : { url: i.url }),
            usage: { prompt_tokens: run.usage.tokens_in, completion_tokens: run.usage.tokens_out, ...(b.usage?.include ? accounting(run) : {}) },
            x_openvibe: { run_id: run.id, cost_usd: run.usage.cost_usd, provider: run.provenance.provider } });
    }));
    // Reuse the complete workflow and its single hold, including streaming and idempotency.
    r.post('/v1/completions', (req, res, next) => {
        if (typeof req.body?.prompt !== 'string' || !req.body.prompt.length)
            return res.status(400).json({ error: { code: 'input.invalid', message: 'prompt must be a non-empty string' } });
        const convert = v => v?.choices ? { ...v, object: 'text_completion', choices: v.choices.map(c => ({ index: c.index, text: c.message?.content || c.delta?.content || '', logprobs: c.logprobs || null, finish_reason: c.finish_reason })) } : v;
        const json = res.json.bind(res);
        res.json = v => json(convert(v));
        const write = res.write.bind(res);
        res.write = (chunk, ...args) => {
            const value = String(chunk);
            if (value.startsWith('data: ') && !value.startsWith('data: [DONE]')) {
                try { chunk = 'data: ' + JSON.stringify(convert(JSON.parse(value.slice(6)))) + '\n\n'; } catch {}
            }
            return write(chunk, ...args);
        };
        req.body = { ...req.body, messages: [{ role: 'user', content: req.body.prompt }] };
        delete req.body.prompt;
        req.url = '/v1/chat/completions';
        next();
    });
    return r;
}
module.exports = { compatExtra, accounting };
