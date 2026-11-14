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
 *     "model": "auto" | "<provider>/<model>", "kind": "routing" | "moderation" | "grading" | "tool_choice" | "other",
 *     "prefer": "calibrated" | "cheap" }
 *   → { "answers": { "is_spam": { "type": "noul", "noul": 0.03, "confidence": 0.97 }, … }, "calibrated": true,
 *       "receipt": { "provider": "gemini", "model": "gemini-decision-1", "input_tokens": 120, "cost_usd": 0.000012,
 *                     "steps": [{ "step": 1, "provider": "gemini", "model": "gemini-decision-1", "cost_usd": 0.000012 }] } }
 *
 * The model that answers (2026-11-14; "easy to switch, more providers, smarter routing"):
 *   model        "auto" (the default) is today's order; any other value is a model id from
 *               GET /api/v1/decisions/models ("<provider>/<model>"). An unknown id is a 400 in plain words.
 *   kind         routing | moderation | grading | tool_choice | other. It picks the model the owner set for that
 *               kind, the ladder to escalate along and the confidence below which an answer is escalated.
 *
 * The providers, in order (modular: each is one function below; a new one is one more entry):
 *   gemini     Google's Decisions API, gemini-decision-1 (https://aistudio.google.com/docs/decisions-api): one forward pass,
 *              calibrated probabilities, up to 1,000 questions, pictures, audio, video and PDFs; $0.10 per 1M input
 *              tokens, nothing for output (Google's price, 2026-11-11). Used when the gemini provider's key resolves.
 *              Its free tier may train on what it reads: public or synthetic data only (the owner's note, 11-12).
 *   router     decide.fallback on the router's cheap structured-output route (default.json): text only, up to 100
 *              questions, estimated and not calibrated (calibrated: false). Used without a Gemini key, when Google is
 *              away, or with prefer: "cheap" for text when the router's offer is free. With a named model the same
 *              route runs on that model alone (the router's exact pin), never on another one.
 * Every call is metered like any request (provider_key, cost), so a credit plan pays for it and the owner sees it.
 *
 * Escalation (2026-11-14): an answer from a model that is not calibrated is trusted when its confidence reaches the
 * kind's threshold (0.75 until the owner says otherwise). Below it, the questions that were unsure are asked again
 * of the next model in the kind's ladder — the owner's list, or the cheapest available structured models — at most
 * once. The receipt lists every step and what it cost.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { AiError, sendError, providerSecret } = require('../util');
const decide = require('../workflows/decide');
const { createDecisionModels } = require('../decisions/models');
const { KINDS, DEFAULT_THRESHOLD } = require('../decisions/config');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const GEMINI_MODEL = 'gemini-decision-1';
const GEMINI_PER_MTOK = 0.10;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_GEMINI_QUESTIONS = 1000;
const WAIT_MS = 30000;
/** The default answer: today's order (the router picks). */
const AUTO = 'auto';

/** The request, checked: { parts, text, questions, model, kind, prefer } or an AiError. */
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
    // The model the caller names: "auto" (today's order) or a model id from GET /api/v1/decisions/models.
    const model = b.model == null || b.model === '' ? AUTO : String(b.model).trim();
    if (model.length > 200) throw new AiError(422, 'input.invalid', 'a model id is at most 200 characters');
    const kind = b.kind == null || b.kind === '' ? 'other' : String(b.kind).trim();
    if (!KINDS.includes(kind)) throw new AiError(400, 'decisions.kind_unknown', `the kind is ${KINDS.join(', ')}`);
    return { parts, text, questions, prefer, onlyText: parts.every((p) => p.type === 'text'), model, kind };
}

/**
 * Google's Decisions API with the gemini provider's own key (calibrated, metered as a 'classify' request), shared by
 * POST /api/v1/decisions and Auto's routing step (server/routing/auto-decision.js). ask(req) → the answer, or null when
 * there is no key; it throws when Google does not answer.
 */
function createGeminiDecider({ db, registry, env = process.env, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const meter = async (row) => {
        try {
            await db.prepare("INSERT INTO requests (operation, provider_key, model_key, status, cost_usd, created_at) VALUES ('classify', ?, ?, ?, ?, ?)")
                .run(row.provider, row.model, row.status, row.cost_usd || 0, new Date(now()).toISOString());
        } catch (err) { log.warn(`[ai] decisions meter: ${String(err && err.message || err).slice(0, 160)}`); }
    };

    /** Is a key there at all (no call)? */
    async function available() {
        const row = registry && registry.getProvider ? await registry.getProvider('gemini').catch(() => null) : null;
        return Boolean(row ? providerSecret(row, env) : env.GEMINI_API_KEY);
    }

    /**
     * May a person's own words go to it (Auto's routing step, plan 16d)? Only when the gemini provider is active and its
     * recorded data policy says it does not train on what it reads: Google's free tier may (the owner's 11-12 note on
     * Google's free tier), so a key alone is never enough.
     */
    async function privateOk() {
        const row = registry && registry.getProvider ? await registry.getProvider('gemini').catch(() => null) : null;
        if (!row || row.status !== 'active' || !providerSecret(row, env)) return false;
        const policy = require('../exchange/privacy').dataPolicyOf(row);
        return Boolean(policy && policy.training === false);
    }

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
    return { ask: viaGemini, available, privateOk };
}

/** The confidence of an answer, or null when the model did not say. */
const confidenceOf = (a) => {
    const c = a && Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : null;
    return c == null ? null : Math.max(0, Math.min(1, c));
};

/** The questions an answer was not sure enough about (a missing confidence is not sure enough). */
function unsureNames(answers, questions, threshold) {
    return Object.keys(questions).filter((name) => {
        const c = confidenceOf(answers && answers[name]);
        return c == null || c < threshold;
    });
}

function decisionsRouter({ runs, auth, db, registry, pool = null, config = {}, env = process.env, fetchImpl = globalThis.fetch, log = console, clock = { now: () => Date.now() }, models = null, decisions = null }) {
    const r = express.Router();
    r.use(http.middleware());
    const guard = auth.personOrCap('ai.run.create');
    const decider = createGeminiDecider({ db, registry, env, fetchImpl, log, now: () => clock.now() });
    const viaGemini = decider.ask;
    const modelList = models || createDecisionModels({ registry, pool, db, config, env, clock, log });

    /** The router's cheap structured-output route (decide.fallback): text only, estimated probabilities. */
    async function viaRouter(req, http, { exact = null } = {}) {
        if (Object.keys(req.questions).length > decide.MAX_QUESTIONS) throw new AiError(422, 'input.invalid', `without the Decisions API, at most ${decide.MAX_QUESTIONS} questions`);
        const created = await runs.create({ workflow: 'decide.fallback', task: 'decide.fallback', input: { input: req.text, questions: req.questions } }, http.principal, {
            trace: http.ov && http.ov.traceId, requestId: http.ov && http.ov.requestId, callerWaitMs: WAIT_MS,
            ...(exact ? { exact } : {}),
        });
        const run = await runs.explained(await runs.wait(created, WAIT_MS));
        if (run.status !== 'succeeded' || !run.output) throw new AiError(503, 'decisions.unavailable', (run.error && run.error.detail) || 'no route answered the questions');
        const provider = String((run.provenance && run.provenance.provider) || (exact ? exact.offers[0].provider : 'router')).slice(0, 100);
        const model = String((run.provenance && run.provenance.model) || (exact ? exact.offers[0].model : 'unknown')).slice(0, 200);
        return { answers: run.output.answers, calibrated: false,
            receipt: { provider, model, run_id: String(run.id), cost_usd: Number(run.usage && run.usage.cost_usd) || 0 } };
    }

    /** Today's order: Google's Decisions API first (unless the caller asked for the cheapest text answer), the router after it. */
    async function viaAuto(req, http) {
        let out = null;
        // Calibrated first (Google's Decisions API) unless the caller asked for the cheapest text answer.
        if (req.prefer === 'calibrated' || !req.onlyText) {
            try { out = await viaGemini(req); } catch (err) { log.warn(`[ai] decisions via gemini failed: ${String(err && err.message || err).slice(0, 160)}`); out = null; }
        }
        if (!out) {
            if (!req.onlyText) throw new AiError(503, 'decisions.unavailable', 'pictures, audio, video and documents need the Decisions API (a Gemini key on OpenVibe.AI)');
            out = await viaRouter(req, http);
        }
        return out;
    }

    /** One named model: Google's own API, or the router's route pinned to that model alone. */
    async function viaModel(req, http, entry) {
        if (entry.id === modelList.GEMINI_ID) {
            const out = await viaGemini(req);
            if (!out) throw new AiError(503, 'decisions.model_unavailable', 'the model gemini/gemini-decision-1 has no key on OpenVibe.AI');
            return out;
        }
        const cut = entry.id.indexOf('/');
        const provider = entry.id.slice(0, cut);
        const model = entry.id.slice(cut + 1);
        return viaRouter(req, http, { exact: { id: entry.id, offers: [{ provider, model }] } });
    }

    /**
     * The model that answers: the one the caller named, else the kind's own default, else today's order.
     * An unknown id is a 400 in plain words.
     */
    async function resolveModel(req) {
        if (req.model && req.model !== AUTO) {
            const entry = await modelList.find(req.model);
            if (!entry) {
                const all = await modelList.list();
                throw new AiError(400, 'decisions.model_unknown', `no decision model called ${req.model}. GET /api/v1/decisions/models lists the ${all.count} that can answer.`);
            }
            if (!entry.available) throw new AiError(503, 'decisions.model_unavailable', `the model ${req.model} cannot answer right now`);
            return { entry, source: 'asked' };
        }
        const cfg = decisions ? decisions.of(req.kind) : null;
        if (cfg && cfg.default_model) {
            const entry = await modelList.find(cfg.default_model);
            if (entry && entry.available) return { entry, source: 'kind' };
        }
        return { entry: null, source: 'auto' };
    }

    /** The ladder of a kind: the owner's list, or the cheapest available structured models. */
    async function ladderOf(kind) {
        const cfg = decisions ? decisions.of(kind) : null;
        if (cfg && cfg.ladder && cfg.ladder.length) return cfg.ladder;
        return modelList.defaultLadder();
    }

    /** The id of the model that answered: "<provider>/<model>", the way the ladder names it. */
    const idOf = (receipt) => String((receipt && receipt.provider) || '') + '/' + String((receipt && receipt.model) || '');

    /** The model after the one that answered: the next in the ladder that can answer now. */
    async function nextIn(ladder, currentId) {
        const at = ladder.indexOf(currentId);
        const rest = at >= 0 ? ladder.slice(at + 1) : ladder.filter((id) => id !== currentId);
        for (const id of rest) {
            const entry = await modelList.find(id);
            if (entry && entry.available) return entry;
        }
        return null;
    }

    // How an Auto answer went (plan 16d): a product that knows (a test passed, the person voted) tells the weekly fit.
    // Only the person or service the decision answered may report it; anyone else gets the 404 of a missing one.
    const autoOutcomes = require('../routing/auto-decision').createAutoDecision({ db, log });
    r.post('/api/v1/route-decisions/:id/outcome', guard, async (req, res) => {
        try {
            const good = req.body && req.body.good;
            if (typeof good !== 'boolean') throw new AiError(422, 'input.invalid', 'good is true or false');
            const p = req.principal || {};
            const out = await autoOutcomes.outcome(String(req.params.id).slice(0, 64), good, { onBehalfOf: p.onBehalfOf || null, type: p.subject && p.subject.type, id: p.subject && p.subject.id });
            if (out.status === 404) throw new AiError(404, 'route_decision.not_found', 'no such decision');
            res.json({ id: String(req.params.id), outcome: out.outcome });
        } catch (err) { sendError(res, err, req); }
    });

    /**
     * The models that can answer decisions (2026-11-14): Google's Decisions API and every catalogue model that can
     * answer with structured output. Public (no token) and cached for ten minutes.
     */
    r.get('/api/v1/decisions/models', async (req, res) => {
        try {
            const list = await modelList.list();
            res.set('Cache-Control', 'public, max-age=600');
            res.json(list);
        } catch (err) { sendError(res, err, req, log); }
    });

    r.post('/api/v1/decisions', guard, async (req, res) => {
        try {
            const q = checked(req.body);
            const chosen = await resolveModel(q);
            const cfg = decisions ? decisions.of(q.kind) : null;
            const threshold = cfg ? Number(cfg.threshold) : DEFAULT_THRESHOLD;
            const first = chosen.entry ? await viaModel(q, req, chosen.entry) : await viaAuto(q, req);
            const steps = [{
                step: 1, provider: first.receipt.provider, model: first.receipt.model,
                cost_usd: Number(first.receipt.cost_usd) || 0, input_tokens: Number(first.receipt.input_tokens) || 0,
                calibrated: Boolean(first.calibrated), questions: Object.keys(q.questions),
            }];
            let answers = first.answers || {};
            let calibrated = Boolean(first.calibrated);
            // Escalation: an answer that is not sure enough is asked again of the next model in the ladder, once.
            if (!calibrated) {
                const names = unsureNames(answers, q.questions, threshold);
                if (names.length) {
                    const ladder = await ladderOf(q.kind);
                    const next = await nextIn(ladder, idOf(first.receipt));
                    if (next) {
                        const sub = { ...q, questions: Object.fromEntries(names.map((n) => [n, q.questions[n]])) };
                        let second = null;
                        try { second = await viaModel(sub, req, next); }
                        catch (err) { log.warn(`[ai] decisions escalation failed: ${String(err && err.message || err).slice(0, 160)}`); }
                        if (second) {
                            answers = { ...answers, ...(second.answers || {}) };
                            steps.push({
                                step: steps.length + 1, provider: second.receipt.provider, model: second.receipt.model,
                                cost_usd: Number(second.receipt.cost_usd) || 0, input_tokens: Number(second.receipt.input_tokens) || 0,
                                calibrated: Boolean(second.calibrated), questions: names, escalated: true,
                            });
                            // The answer is calibrated only when every step was: a mixed answer is not.
                            calibrated = steps.every((s) => s.calibrated);
                        }
                    }
                }
            }
            const last = steps[steps.length - 1];
            const cost = Math.round(steps.reduce((sum, s) => sum + (Number(s.cost_usd) || 0), 0) * 1e8) / 1e8;
            res.json({
                answers, calibrated,
                receipt: {
                    provider: last.provider, model: last.model, input_tokens: last.input_tokens, cost_usd: cost,
                    ...(steps[0].run_id ? { run_id: steps[0].run_id } : {}),
                    steps,
                    ...(steps.length > 1 ? { escalated: true, threshold } : {}),
                },
            });
        } catch (err) { sendError(res, err, req, log); }
    });
    return r;
}

module.exports = { decisionsRouter, checked, createGeminiDecider, GEMINI_PER_MTOK, AUTO, unsureNames, confidenceOf };
