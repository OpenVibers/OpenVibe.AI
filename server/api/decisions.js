'use strict';
/**
 * POST /api/v1/decisions (2026-11-12, the owner: "Add decisions using automatic scalable cost effective modular multi
 * provider intelligent routing solution on OpenVibe Exchange"). Closed-set questions about one input in one call: yes
 * or no (`noul`), one of a list (`choice`), a rubric level (`score`), each with probabilities and a confidence, for
 * routing, moderation checks, grading and tool choice without a full model writing an answer.
 *
 *   { "input": "…" | [{ "type": "text", "text": "…" }, { "type": "image", "uri": "https://…", "mime_type": "image/png" }],
 *     "questions": { "is_spam": { "type": "noul", "instructions": "Is this spam?" },
 *                    "kind": { "type": "choice", "instructions": "What is it?", "criteria": { "bug": "…", "idea": "…" } },
 *                    "severity": { "type": "score", "instructions": "How bad?", "criteria": ["fine", "minor", "major"] } },
 *     "prefer": "calibrated" | "cheap" }
 *   → { "answers": { "is_spam": { "type": "noul", "noul": 0.03, "confidence": 0.97 }, … }, "calibrated": true,
 *       "receipt": { "provider": "gemini", "model": "gemini-decision-1", "input_tokens": 120, "cost_usd": 0.000012 } }
 *
 * The providers, in order (modular: each is one function below; a new one is one more entry):
 *   gemini     Google's Decisions API, gemini-decision-1 (https://aistudio.google.com/docs/decisions-api): one forward pass,
 *              calibrated probabilities, up to 1,000 questions, pictures, audio, video and PDFs; $0.10 per 1M input
 *              tokens, nothing for output (Google's price, 2026-11-11). Used when the gemini provider's key resolves.
 *              Its free tier may train on what it reads: public or synthetic data only (the owner's note, 11-12).
 *   router     decide.fallback on the router's cheap structured-output route (default.json): text only, up to 100
 *              questions, estimated and not calibrated (calibrated: false). Used without a Gemini key, when Google is
 *              away, or with prefer: "cheap" for text when the router's offer is free.
 * Every call is metered like any request (provider_key, cost), so a credit plan pays for it and the owner sees it.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { AiError, sendError, providerSecret } = require('../util');
const decide = require('../workflows/decide');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const GEMINI_MODEL = 'gemini-decision-1';
const GEMINI_PER_MTOK = 0.10;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_GEMINI_QUESTIONS = 1000;
const WAIT_MS = 30000;

/** The request, checked: { parts, text, questions } or an AiError. */
function checked(body) {
    const b = body && typeof body === 'object' ? body : {};
    let parts;
    if (typeof b.input === 'string') parts = [{ type: 'text', text: b.input }];
    else if (Array.isArray(b.input)) parts = b.input;
    else throw new AiError(422, 'input.invalid', 'input is text, or a list of content parts');
    if (!parts.length || parts.length > 50) throw new AiError(422, 'input.invalid', 'input has 1 to 50 parts');
    for (const p of parts) {
        if (!p || typeof p !== 'object') throw new AiError(422, 'input.invalid', 'every input part is an object');
        if (p.type === 'text') { if (typeof p.text !== 'string' || !p.text.length || p.text.length > 200000) throw new AiError(422, 'input.invalid', 'a text part has 1 to 200,000 characters'); }
        else if (['image', 'audio', 'video', 'document'].includes(p.type)) { if (!/^https:\/\/\S{1,2000}$/.test(String(p.uri || ''))) throw new AiError(422, 'input.invalid', `a ${p.type} part names an https uri`); }
        else throw new AiError(422, 'input.invalid', 'a part is text, image, audio, video or document');
    }
    const qs = b.questions && typeof b.questions === 'object' && !Array.isArray(b.questions) ? b.questions : null;
    const names = qs ? Object.keys(qs) : [];
    if (!names.length || names.length > MAX_GEMINI_QUESTIONS) throw new AiError(422, 'input.invalid', `1 to ${MAX_GEMINI_QUESTIONS} questions, by name`);
    const questions = {};
    for (const name of names) {
        const q = qs[name] || {};
        if (!NAME_RE.test(name)) throw new AiError(422, 'input.invalid', `a question name is lowercase letters, digits and _ (${name.slice(0, 40)})`);
        if (!['noul', 'choice', 'score'].includes(q.type)) throw new AiError(422, 'input.invalid', `${name}: type is noul, choice or score`);
        if (typeof q.instructions !== 'string' || !q.instructions.trim() || q.instructions.length > 4000) throw new AiError(422, 'input.invalid', `${name}: instructions are 1 to 4,000 characters`);
        if (q.type === 'choice') {
            const keys = q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
            if (keys.length < 2 || keys.length > 255) throw new AiError(422, 'input.invalid', `${name}: a choice names 2 to 255 options in criteria`);
        }
        if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 20)) throw new AiError(422, 'input.invalid', `${name}: a score lists 2 to 20 rubric levels in criteria`);
        if (q.type === 'noul' && q.criteria != null && (typeof q.criteria !== 'object' || Array.isArray(q.criteria))) throw new AiError(422, 'input.invalid', `${name}: a yes/no criteria is { true_description, false_description }`);
        questions[name] = { type: q.type, instructions: q.instructions.trim(), ...(q.criteria != null ? { criteria: q.criteria } : {}) };
    }
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
    const prefer = b.prefer === 'cheap' ? 'cheap' : 'calibrated';
    return { parts, text, questions, prefer, onlyText: parts.every((p) => p.type === 'text') };
}

function decisionsRouter({ runs, auth, db, registry, env = process.env, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const r = express.Router();
    r.use(http.middleware());
    const guard = auth.personOrCap('ai.run.create');

    const meter = async (row) => {
        try {
            await db.prepare("INSERT INTO requests (operation, provider_key, model_key, status, cost_usd, created_at) VALUES ('classify', ?, ?, ?, ?, ?)")
                .run(row.provider, row.model, row.status, row.cost_usd || 0, new Date(now()).toISOString());
        } catch (err) { log.warn(`[ai] decisions meter: ${String(err && err.message || err).slice(0, 160)}`); }
    };

    /** Google's Decisions API with the gemini provider's own key, or null when there is no key. */
    async function viaGemini(req) {
        const row = registry && registry.getProvider ? await registry.getProvider('gemini').catch(() => null) : null;
        const key = row ? providerSecret(row, env) : (env.GEMINI_API_KEY || null);
        if (!key) return null;
        const input = req.onlyText ? req.text : req.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: p.type, uri: p.uri, ...(p.mime_type ? { mime_type: p.mime_type } : {}) }));
        const res = await fetchImpl(GEMINI_URL, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'x-goog-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ model: GEMINI_MODEL, input, questions: req.questions }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || typeof data.answers !== 'object') {
            await meter({ provider: 'gemini', model: GEMINI_MODEL, status: 'error' });
            const err = new Error(`gemini decisions ${res.status}`); err.status = res.status; throw err;
        }
        const tokens = Number(data.usage && data.usage.total_input_tokens) || 0;
        const cost = Math.round((tokens / 1e6) * GEMINI_PER_MTOK * 1e8) / 1e8;
        await meter({ provider: 'gemini', model: GEMINI_MODEL, status: 'ok', cost_usd: cost });
        return { answers: data.answers, calibrated: true, receipt: { provider: 'gemini', model: GEMINI_MODEL, input_tokens: tokens, cost_usd: cost } };
    }

    /** The router's cheap structured-output route (decide.fallback): text only, estimated probabilities. */
    async function viaRouter(req, http) {
        if (Object.keys(req.questions).length > decide.MAX_QUESTIONS) throw new AiError(422, 'input.invalid', `without the Decisions API, at most ${decide.MAX_QUESTIONS} questions`);
        const created = await runs.create({ workflow: 'decide.fallback', task: 'decide.fallback', input: { input: req.text, questions: req.questions } }, http.principal, {
            trace: http.ov && http.ov.traceId, requestId: http.ov && http.ov.requestId, callerWaitMs: WAIT_MS,
        });
        const run = await runs.explained(await runs.wait(created, WAIT_MS));
        if (run.status !== 'succeeded' || !run.output) throw new AiError(503, 'decisions.unavailable', (run.error && run.error.detail) || 'no route answered the questions');
        return { answers: run.output.answers, calibrated: false,
            receipt: { provider: String((run.provenance && run.provenance.provider) || 'router').slice(0, 100), model: String((run.provenance && run.provenance.model) || 'unknown').slice(0, 200), run_id: String(run.id), cost_usd: Number(run.usage && run.usage.cost_usd) || 0 } };
    }

    r.post('/api/v1/decisions', guard, async (req, res) => {
        try {
            const q = checked(req.body);
            let out = null;
            // Calibrated first (Google's Decisions API) unless the caller asked for the cheapest text answer.
            if (q.prefer === 'calibrated' || !q.onlyText) {
                try { out = await viaGemini(q); } catch (err) { log.warn(`[ai] decisions via gemini failed: ${String(err && err.message || err).slice(0, 160)}`); out = null; }
            }
            if (!out) {
                if (!q.onlyText) throw new AiError(503, 'decisions.unavailable', 'pictures, audio, video and documents need the Decisions API (a Gemini key on OpenVibe.AI)');
                out = await viaRouter(q, req);
            }
            res.json(out);
        } catch (err) { sendError(res, err, req); }
    });
    return r;
}

module.exports = { decisionsRouter, checked };
