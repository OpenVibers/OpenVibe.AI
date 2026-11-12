'use strict';
const express = require('express');
const { CAPS } = require('../auth');
const { appAttribution } = require('../apps');
const { AiError, sendError } = require('../util');
function accounting(run) {
    return { cost: Number(run.usage.cost_usd || 0), latency: Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at || run.created_at)) || 0,
        provider: run.provenance?.provider || null };
}

// POST /v1/audio/transcriptions: a run of ai.transcribe carries the audio as a data: URL, and a run's
// input is capped (AI_MAX_INPUT_BYTES, 6 MB by default), so the file is 3 MB at most.
const MAX_MULTIPART_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const AUDIO_TYPES = new Set(['audio/flac', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/mpga', 'audio/m4a', 'audio/x-m4a',
    'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/aac', 'audio/x-aac', 'video/mp4', 'video/mpeg']);
const AUDIO_EXTENSIONS = { flac: 'audio/flac', mp3: 'audio/mpeg', mp4: 'audio/mp4', mpeg: 'audio/mpeg', mpga: 'audio/mpga',
    m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', aac: 'audio/aac' };
const TRANSCRIBE_FORMATS = new Set(['json', 'text', 'verbose_json']);
const MODERATION_LABELS = ['threat', 'minors', 'doxxing', 'harassment', 'spam', 'sexual', 'self_harm', 'none'];
// OpenAI's moderation categories. OpenVibe's labels map onto them where they overlap; a label OpenAI has
// no category for (doxxing, spam) still flags the result and travels in x_openvibe.classification.
const MODERATION_CATEGORIES = ['hate', 'hate/threatening', 'harassment', 'harassment/threatening', 'self-harm', 'self-harm/intent',
    'self-harm/instructions', 'sexual', 'sexual/minors', 'violence', 'violence/graphic'];
const SEVERITY_SCORES = { none: 0, low: 0.25, medium: 0.6, high: 0.95 };

const gatewaySafe = (status) => (status === 502 || status === 504 ? 503 : status === 422 ? 400 : status);

function openaiError(res, status, message, code, type) {
    res.status(status).json({ error: { message: String(message || 'error').slice(0, 1000), type: type || (status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 402 ? 'insufficient_quota' : status >= 500 ? 'api_error' : 'invalid_request_error'), code: code || null, param: null } });
}

/** The raw bytes of a request nobody has parsed yet (multipart/form-data bypasses express.json). */
function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) { over = true; return; }
            chunks.push(chunk);
        });
        req.on('end', () => over ? reject(new AiError(413, 'input.too_large', `the upload is larger than ${limit} bytes`)) : resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** The one file and the small fields of a multipart form, as OpenAI's audio clients send them. */
function parseMultipart(buf, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
    if (!m) throw new AiError(400, 'input.invalid', 'the request is not a valid multipart/form-data form');
    const boundary = '--' + (m[1] || m[2]);
    const text = buf.toString('latin1');
    const fields = {};
    let file = null;
    let parts = 0;
    for (const chunk of text.split(boundary).slice(1)) {
        if (chunk.startsWith('--')) break;
        parts++;
        if (parts > 32) throw new AiError(400, 'input.invalid', 'the form has too many parts');
        const part = chunk.replace(/^\r\n/, '');
        const split = part.indexOf('\r\n\r\n');
        if (split < 0) continue;
        const head = part.slice(0, split);
        let body = part.slice(split + 4);
        if (body.endsWith('\r\n')) body = body.slice(0, -2);
        const name = /name="([^"]+)"/i.exec(head);
        if (!name) continue;
        const filename = /filename="([^"]*)"/i.exec(head);
        if (filename && filename[1]) {
            const type = /content-type:\s*([^\r\n;]+)/i.exec(head);
            file = { name: filename[1], type: (type ? type[1] : '').trim().toLowerCase(), data: Buffer.from(body, 'latin1') };
        } else {
            fields[name[1]] = Buffer.from(body, 'latin1').toString('utf8');
        }
    }
    return { fields, file };
}

/** The audio MIME type, from the part's own type or (when the client sent none) its extension. */
function audioTypeOf(file) {
    const type = String(file.type || '').split(';')[0].trim().toLowerCase();
    if (type) {
        if (!AUDIO_TYPES.has(type)) throw new AiError(400, 'input.invalid', `unsupported audio file type ${type.slice(0, 80)}; send audio/mpeg, audio/wav, audio/ogg, audio/webm or audio/mp4`);
        return type;
    }
    const ext = /\.([a-z0-9]+)$/i.exec(String(file.name || ''));
    const inferred = ext && AUDIO_EXTENSIONS[ext[1].toLowerCase()];
    if (!inferred) throw new AiError(400, 'input.invalid', 'the audio file has no content type; send audio/mpeg, audio/wav, audio/ogg, audio/webm or audio/mp4');
    return inferred;
}

/** Cosine similarity of two embedding vectors; zero when the vectors are empty or misaligned. */
function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = Number(a[i]) || 0;
        const y = Number(b[i]) || 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (!na || !nb) return 0;
    return Math.round(Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb))) * 1e6) / 1e6;
}

/** OpenAI's moderation result shape from the moderation.classify workflow's answer. */
function moderationResult(output) {
    const out = output && typeof output === 'object' ? output : {};
    const labels = new Set((Array.isArray(out.labels) ? out.labels : []).filter((l) => MODERATION_LABELS.includes(l)));
    const action = ['allow', 'review', 'block'].includes(out.action) ? out.action : 'review';
    const severity = Object.hasOwn(SEVERITY_SCORES, out.severity) ? out.severity : 'medium';
    const score = SEVERITY_SCORES[severity];
    const categories = Object.fromEntries(MODERATION_CATEGORIES.map((k) => [k, false]));
    const category_scores = Object.fromEntries(MODERATION_CATEGORIES.map((k) => [k, 0]));
    const mark = (...keys) => { for (const k of keys) { categories[k] = true; category_scores[k] = Math.max(category_scores[k], score); } };
    if (labels.has('threat')) mark('violence');
    if (labels.has('harassment')) mark('harassment');
    if (labels.has('threat') && labels.has('harassment')) mark('harassment/threatening');
    if (labels.has('minors')) mark('sexual/minors', 'sexual');
    if (labels.has('sexual')) mark('sexual');
    if (labels.has('self_harm')) mark('self-harm', 'self-harm/intent');
    if (labels.has('doxxing')) mark('harassment');
    return { flagged: action !== 'allow' || severity !== 'none', categories, category_scores };
}
function compatExtra({ runs, auth, config, log }) {
    const r = express.Router();
    const allow = auth.appOrCap(CAPS.appRun, CAPS.runCreate);
    const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (err) { sendError(res, err, req.ov, log); } };
    const openaiRoute = (label, fn) => async (req, res) => {
        try { await fn(req, res); } catch (err) {
            if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
            const status = gatewaySafe((err && err.status) || 500);
            if (status >= 500) log.warn(`[ai] ${label}: ${err && err.message}`);
            return openaiError(res, status, err && (err.detail || err.message), err && err.code);
        }
    };
    // The run the compatible route waits for, with the same admission and charge bookkeeping as the
    // chat and speech routes: the run path records the usage and the money.
    async function createRun(body, req, res) {
        const created = await runs.create(body, req.principal, { trace: req.ov?.traceId, requestId: req.ov?.requestId, abuse: req.abuse });
        res.locals.inferenceAdmitted = true;
        if (created.created === false) res.setHeader('x-openvibe-replayed', '1');
        const run = await runs.explained(await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000)));
        if (['succeeded', 'cached'].includes(run.status) || (['failed', 'cancelled'].includes(run.status) && run.usage.attempts === 0)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (!['succeeded', 'cached'].includes(run.status)) {
            const code = (run.error && run.error.code) || (run.status === 'failed' ? 'run.failed' : 'run.timeout');
            const status = code === 'run.timeout' ? 504
                : code === 'ai.run_budget_reached' || code === 'ai.allowance_spent' || code === 'billing.insufficient_funds' || code === 'billing.payer_required' ? 402
                : /^(input|validation)\./.test(code) ? 400 : /quota|allowance|budget/.test(code) ? 429
                : code === 'ai.model_not_found' ? 404 : code === 'ai.model_unavailable' ? 400 : 503;
            throw new AiError(status, code, (run.error && run.error.detail) || (code === 'run.timeout' ? `the run is still running; GET /api/v1/runs/${run.id}` : code));
        }
        return run;
    }
    const runBody = (req, workflow, input, extra = {}) => {
        const body = { workflow, input, ...extra };
        if (req.principal.kind === 'app') body.attribution = appAttribution(req.principal);
        return body;
    };
    const usageOf = (list) => {
        const t = list.reduce((a, run) => ({ in: a.in + Number(run.usage.tokens_in || 0), out: a.out + Number(run.usage.tokens_out || 0) }), { in: 0, out: 0 });
        return { prompt_tokens: t.in, completion_tokens: t.out, total_tokens: t.in + t.out };
    };
    const costOf = (list) => Math.round(list.reduce((n, run) => n + Number(run.usage.cost_usd || 0), 0) * 1e6) / 1e6;
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
        res.locals.inferenceAdmitted = true;
        if (!created.created) res.set('x-openvibe-replayed', '1');
        const run = await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000));
        if (['succeeded', 'cached'].includes(run.status) || (['failed', 'cancelled'].includes(run.status) && run.usage.attempts === 0)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
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
        input.compat_routing = require('../exchange/compat-routing').request(b);
        const created = await runs.create({ workflow: 'ai.image', input, idempotency_key: req.get('idempotency-key') || undefined }, req.principal, { trace: req.ov?.traceId });
        res.locals.inferenceAdmitted = true;
        if (!created.created) res.set('x-openvibe-replayed', '1');
        const run = await runs.wait(created, Math.max(config.runs.maxWaitMs, 120000));
        if (['succeeded', 'cached'].includes(run.status) || (['failed', 'cancelled'].includes(run.status) && run.usage.attempts === 0)) res.locals.inferenceCharge = Number(run.usage.cost_usd || 0);
        if (!['succeeded', 'cached'].includes(run.status)) throw new AiError(503, run.error?.code || 'run.failed', run.error?.detail || 'Image provider unavailable');
        res.json({ id: run.id, created: Math.floor(Date.parse(run.created_at) / 1000),
            data: run.output.images.map(i => i.b64 ? { b64_json: i.b64 } : { url: i.url }),
            usage: { prompt_tokens: run.usage.tokens_in, completion_tokens: run.usage.tokens_out, ...(b.usage?.include ? accounting(run) : {}) },
            x_openvibe: { run_id: run.id, cost_usd: run.usage.cost_usd, provider: run.provenance.provider } });
    }));
    // OpenAI's audio/transcriptions: multipart file + model, through the router's transcribe route
    // (workflow ai.transcribe, route live.stt). language, prompt and temperature go to the provider that
    // supports them; response_format is json (default), text or verbose_json.
    r.post('/v1/audio/transcriptions', allow, openaiRoute('/v1/audio/transcriptions', async (req, res) => {
        const contentType = String(req.get('content-type') || '');
        if (!/^multipart\/form-data/i.test(contentType)) return openaiError(res, 400, 'send multipart/form-data with a file field', 'input.invalid');
        const raw = await readRaw(req, MAX_MULTIPART_BYTES);
        const { fields, file } = parseMultipart(raw, contentType);
        if (!file) return openaiError(res, 400, 'file is required', 'input.invalid');
        const mime = audioTypeOf(file);
        if (!file.data.length) return openaiError(res, 400, 'the audio file is empty', 'input.invalid');
        if (file.data.length > MAX_AUDIO_BYTES) return openaiError(res, 413, `the audio file is larger than ${MAX_AUDIO_BYTES} bytes`, 'input.too_large');
        const model = String(fields.model == null ? '' : fields.model).trim();
        if (!model || model.length > 256) return openaiError(res, 400, 'model must name a transcription model', 'input.invalid');
        const language = fields.language == null || fields.language === '' ? null : String(fields.language).trim().toLowerCase();
        if (language && language !== 'auto' && !/^[a-z]{2}$/.test(language)) return openaiError(res, 400, 'language must be an ISO-639-1 code or auto', 'input.invalid');
        const prompt = fields.prompt == null || fields.prompt === '' ? null : String(fields.prompt);
        if (prompt && prompt.length > 1000) return openaiError(res, 400, 'prompt is longer than 1000 characters', 'input.invalid');
        const temperature = fields.temperature == null || fields.temperature === '' ? null : Number(fields.temperature);
        if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 1)) return openaiError(res, 400, 'temperature must be between 0 and 1', 'input.invalid');
        const format = fields.response_format == null || fields.response_format === '' ? 'json' : String(fields.response_format);
        if (!TRANSCRIBE_FORMATS.has(format)) return openaiError(res, 400, 'response_format must be json, text or verbose_json', 'input.invalid');

        const input = { audio: { data_url: `data:${mime};base64,${file.data.toString('base64')}`, mime }, language: language || 'auto' };
        if (prompt) input.prompt = prompt;
        if (temperature != null) input.temperature = temperature;
        if (fields.max_cost_usd != null && fields.max_cost_usd !== '') input.max_cost_usd = fields.max_cost_usd;
        const run = await createRun(runBody(req, 'ai.transcribe', input, { idempotency_key: req.get('idempotency-key') || undefined }), req, res);

        const output = run.output || {};
        const text = String(output.text == null ? '' : output.text);
        const detected = output.language || language || 'en';
        const segments = Array.isArray(output.segments) ? output.segments : [];
        const usage = usageOf([run]);
        const x = { run_id: run.id, provider: run.provenance?.provider || null, model: run.provenance?.model || null,
            requested_model: model, response_format: format, cost_usd: costOf([run]), synthetic: Boolean(run.synthetic) };
        res.setHeader('X-OpenVibe-Run-Id', run.id);
        if (format === 'text') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.status(200).send(text);
        }
        if (format === 'verbose_json') {
            const mapped = segments.map((s, i) => ({ id: i, seek: 0, start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || ''),
                tokens: [], temperature: temperature == null ? 0 : temperature, avg_logprob: null, compression_ratio: null, no_speech_prob: null }));
            return res.json({ task: 'transcribe', language: detected, duration: mapped.length ? mapped[mapped.length - 1].end : 0,
                text, segments: mapped, usage, x_openvibe: x });
        }
        return res.json({ text, usage, x_openvibe: x });
    }));

    // OpenAI's moderations: no provider here offers a moderation endpoint, so a structured model answers
    // the fixed moderation.classify prompt (workflow ai.moderate) and the answer says so in x_openvibe.
    r.post('/v1/moderations', allow, openaiRoute('/v1/moderations', async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const requested = b.model == null ? 'omni-moderation-latest' : String(b.model).trim();
        if (!requested || requested.length > 256) return openaiError(res, 400, 'model must name a moderation model', 'input.invalid');
        const inputs = Array.isArray(b.input) ? b.input : [b.input];
        if (!inputs.length || inputs.length > 16) return openaiError(res, 400, 'input must be a string or an array of at most 16 strings', 'input.invalid');
        const texts = [];
        for (const value of inputs) {
            if (typeof value !== 'string' || !value.trim()) return openaiError(res, 400, 'input must be a string or an array of non-empty strings', 'input.invalid');
            if (value.length > 8000) return openaiError(res, 400, 'each input is at most 8000 characters', 'input.invalid');
            texts.push(value);
        }
        const list = [];
        for (const text of texts) list.push(await createRun(runBody(req, 'ai.moderate', { text }), req, res));
        // The charge is every run's, not the last one's.
        res.locals.inferenceCharge = costOf(list);
        const first = list[0];
        return res.json({
            id: `modr-${first.id}`,
            model: first.provenance?.model || requested,
            results: list.map((run) => moderationResult(run.output)),
            usage: usageOf(list),
            x_openvibe: {
                method: 'structured_model', route: 'moderation.classify',
                note: 'no provider moderation endpoint is configured; a structured model answered the fixed moderation.classify prompt',
                run_ids: list.map((run) => run.id),
                classification: list.map((run) => ({ labels: (run.output && run.output.labels) || [], action: (run.output && run.output.action) || null, severity: (run.output && run.output.severity) || null })),
                requested_model: requested, provider: first.provenance?.provider || null, cost_usd: costOf(list), synthetic: list.some((run) => run.synthetic),
            },
        });
    }));

    // Cohere/Jina-shaped rerank: no reranker adapter exists here, so the answer is the cosine similarity
    // of ai.embed's vectors and x_openvibe.method says exactly that.
    r.post('/v1/rerank', allow, openaiRoute('/v1/rerank', async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const requested = b.model == null ? null : String(b.model).trim();
        if (b.model != null && (!requested || requested.length > 256)) return openaiError(res, 400, 'model must be a model id', 'input.invalid');
        if (typeof b.query !== 'string' || !b.query.trim()) return openaiError(res, 400, 'query must be a non-empty string', 'input.invalid');
        if (b.query.length > 32000) return openaiError(res, 400, 'query is longer than 32000 characters', 'input.invalid');
        if (!Array.isArray(b.documents) || !b.documents.length) return openaiError(res, 400, 'documents must be a non-empty array', 'input.invalid');
        if (b.documents.length > 63) return openaiError(res, 400, 'documents is at most 63 (the embedding workflow carries 64 inputs including the query)', 'input.invalid');
        const docs = b.documents.map((d, i) => {
            if (typeof d === 'string') {
                if (!d.trim()) throw new AiError(400, 'input.invalid', `document ${i} is empty`);
                if (d.length > 32000) throw new AiError(400, 'input.invalid', `document ${i} is longer than 32000 characters`);
                return { text: d, original: d };
            }
            if (d && typeof d === 'object' && typeof d.text === 'string') {
                if (!d.text.trim()) throw new AiError(400, 'input.invalid', `document ${i} is empty`);
                if (d.text.length > 32000) throw new AiError(400, 'input.invalid', `document ${i} is longer than 32000 characters`);
                return { text: d.text, original: d };
            }
            throw new AiError(400, 'input.invalid', `document ${i} must be a string or { text }`);
        });
        const topN = b.top_n == null ? docs.length : Number(b.top_n);
        if (!Number.isInteger(topN) || topN < 1 || topN > docs.length) return openaiError(res, 400, `top_n must be an integer between 1 and ${docs.length}`, 'input.invalid');
        const input = { input: [b.query, ...docs.map((d) => d.text)] };
        if (b.max_cost_usd != null) input.max_cost_usd = b.max_cost_usd;
        const run = await createRun(runBody(req, 'ai.embed', input, { idempotency_key: req.get('idempotency-key') || undefined }), req, res);
        const vectors = run.output && Array.isArray(run.output.vectors) ? run.output.vectors : [];
        if (vectors.length !== docs.length + 1) return openaiError(res, 502, 'the embedding provider did not answer for every document', 'provider.output');
        const results = docs.map((d, i) => ({ index: i, relevance_score: cosine(vectors[0], vectors[i + 1]),
            ...(b.return_documents === true ? { document: d.original } : {}) }));
        results.sort((a, z) => z.relevance_score - a.relevance_score || a.index - z.index);
        const model = run.provenance?.model || requested || 'openvibe';
        res.setHeader('X-OpenVibe-Run-Id', run.id);
        return res.json({
            id: `rerank-${run.id}`,
            model,
            results: results.slice(0, topN),
            meta: { billed_units: { search_units: 1 }, method: 'embeddings_cosine', model, provider: run.provenance?.provider || null,
                tokens: { input_tokens: Number(run.usage.tokens_in || 0) } },
            usage: { prompt_tokens: Number(run.usage.tokens_in || 0), total_tokens: Number(run.usage.tokens_in || 0) },
            x_openvibe: { run_id: run.id, method: 'embeddings_cosine',
                note: 'no reranker adapter is configured; relevance_score is the cosine similarity of the query and document embeddings',
                requested_model: requested, provider: run.provenance?.provider || null, cost_usd: costOf([run]), synthetic: Boolean(run.synthetic) },
        });
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
        req.body = { ...req.body, messages: [...(req.body.messages || []), { role: 'user', content: req.body.prompt }] };
        delete req.body.prompt;
        req.url = '/v1/chat/completions';
        next();
    });
    return r;
}
module.exports = { compatExtra, accounting };
