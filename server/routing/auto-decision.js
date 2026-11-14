'use strict';
/**
 * Auto's decision step (plan 16d, 11-13). A request on openvibe/auto whose route offers a cheaper model and a stronger
 * one asks Decisions one calibrated yes/no question about the request itself — "will the cheaper model's answer be
 * good enough?" — and takes the cheaper model when p reaches the task kind's threshold. Every Auto answer that asked
 * carries `route_decision { id, kind, p, threshold, picked, decision_cost_usd }` in its explain, beside the real
 * charge (already metered), and the reason in words.
 *
 * Skipped, and the stronger order kept, when: not openvibe/auto; private (the alias or the route's objective); an
 * exact id, a pin, a task choice or provider routing named the model; the request is not plain text; there is one
 * candidate, or the cheapest one is already first; no Gemini key (only calibrated answers can meet a threshold, and the
 * router's own fallback would route through this pool again); the gemini provider is not active, or its data policy
 * does not say it never trains on what it reads (a person's words never go to a free tier that may); or the decision
 * would cost 5% or more of the stronger
 * model's expected cost. A decision that fails is skipped, never retried.
 *
 * The thresholds (route_thresholds, seeded 0.7) are re-fitted weekly from real outcomes (fitIfDue, from AI's
 * housekeeping): a cheap answer is bad when the same person asked the same thing again within 10 minutes, or a
 * product reported it bad (POST /api/v1/route-decisions/:id/outcome); a decision older than 10 minutes with neither is
 * good. The fit picks the lowest threshold whose bad rate among cheap answers stays within 2 points of the stronger
 * model's. A small share of borderline requests (p within 0.1 under the threshold) explore the cheaper model, so a
 * threshold can learn to go down as well as up; the explain marks them.
 *
 * No request text is stored: the person and the prompt are kept as hashes, for the retry match only.
 */
const crypto = require('crypto');

const DEFAULT_THRESHOLD = 0.7;
const MAX_TEXT_CHARS = 16000;          // about the first 4k tokens
const DECISION_SHARE_CAP = 0.05;       // the decision must cost under 5% of the stronger model's expected cost
const DEFAULT_OUT_TOKENS = 512;
const RETRY_WINDOW_MS = 10 * 60 * 1000;
const FIT_EVERY_MS = 7 * 24 * 3600 * 1000;
const FIT_MIN_N = 30;
const MAX_LOSS = 0.02;
const EXPLORE_BAND = 0.1;
const CANDIDATE_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const GEMINI_PER_MTOK = 0.10;
const QUESTION = {
    good_enough: {
        type: 'noul',
        instructions: 'This is a request to an AI model. Would a small, fast, inexpensive model answer it as well as a large frontier model, so that the person would not notice the difference? Say yes only for requests that need no deep reasoning, long careful writing, hard code or specialist knowledge.',
        criteria: {
            true_description: 'A small inexpensive model answers this as well as a frontier model.',
            false_description: 'This needs a stronger model to be answered well.',
        },
    },
};

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32);
/** Who a decision answered: the person a run acts for, else the caller itself. */
const subjectKey = ({ onBehalfOf = null, type = null, id = null } = {}) => (onBehalfOf ? `user:${onBehalfOf}` : (id ? `${type || ''}:${id}` : null));
const offerKey = (c) => `${c.provider}/${c.model || ''}`;

/** The plain text of a request (system, messages, prompt), cut to about the first 4k tokens; null when not text. */
function requestText(req) {
    if (!req || typeof req !== 'object' || req.image) return null;
    const { textsOf } = require('../policy/floor');
    const parts = textsOf(req);
    if (typeof req.prompt === 'string') parts.push(req.prompt);
    if (typeof req.input === 'string') parts.push(req.input);
    const text = parts.filter(Boolean).join('\n\n').trim();
    return text ? text.slice(0, MAX_TEXT_CHARS) : null;
}

/** The task kind the threshold belongs to: Bench's category when the route names one, else the route. */
function kindOf(route, operation) {
    const c = (route && route.constraints) || {};
    const o = (route && route.options) || {};
    const bench = String((route && route.bench_category) || c.bench_category || o.bench_category || '').trim();
    if (bench && bench !== 'all') return bench.slice(0, 64);
    return String((route && route.key) || operation || 'chat').slice(0, 64);
}

/** Expected USD of one answer from a described candidate: the request's tokens in, its output limit (or 512) out. */
function expectedCost(d, inTokens, outTokens) {
    return (inTokens * (Number(d.priceIn) || 0) + outTokens * (Number(d.priceOut) || 0)) / 1e6;
}

/**
 * The fit of one kind (pure). rows: [{ p, picked: 'cheap' | 'strong', bad: boolean }]. Returns { threshold, n, loss }
 * or null when there is not enough evidence to move it.
 */
function fitThreshold(rows, { current = DEFAULT_THRESHOLD, minN = FIT_MIN_N, maxLoss = MAX_LOSS } = {}) {
    const strong = rows.filter((r) => r.picked === 'strong');
    const cheap = rows.filter((r) => r.picked === 'cheap');
    if (strong.length < minN) return null;
    const strongBad = strong.filter((r) => r.bad).length / strong.length;
    for (const t of CANDIDATE_THRESHOLDS) {
        const at = cheap.filter((r) => r.p >= t);
        if (at.length < minN) continue;
        const bad = at.filter((r) => r.bad).length / at.length;
        if (bad - strongBad <= maxLoss) return { threshold: t, n: at.length + strong.length, loss: Math.round((bad - strongBad) * 1000) / 1000 };
    }
    // No threshold keeps quality: the strictest one with evidence, never looser than today.
    return cheap.length >= minN ? { threshold: Math.max(current, CANDIDATE_THRESHOLDS[CANDIDATE_THRESHOLDS.length - 1]), n: rows.length, loss: null } : null;
}

function createAutoDecision({ db, decider = null, clock = { now: () => Date.now() }, log = console, random = Math.random, explore = 0.05 }) {
    const iso = (ms) => new Date(ms).toISOString();

    async function thresholdOf(kind) {
        const row = await db.prepare('SELECT threshold FROM route_thresholds WHERE kind = ?').get(kind);
        return row && Number.isFinite(Number(row.threshold)) ? Number(row.threshold) : DEFAULT_THRESHOLD;
    }

    /**
     * Reorder the candidates for one Auto request, or leave them. `describe(c)` → { priceIn, priceOut } per 1M tokens.
     * Writes explain.route_decision and a reason when it asked.
     */
    async function step({ list, ctx = {}, req, route, operation, explain, describe, exact = false }) {
        if (!decider || ctx.aliasPolicy !== 'auto' || exact || ctx.routePin || ctx.taskChoice || ctx.compatRouting) return list;
        if (explain && explain.owner_routing) return list;
        if (route && route.constraints && route.constraints.objective === 'private') return list;
        if (!Array.isArray(list) || list.length < 2) return list;
        const text = requestText(req);
        if (!text) return list;
        const inTokens = Math.ceil(text.length / 4);
        const outTokens = Number(req && (req.maxTokens || req.max_tokens)) || DEFAULT_OUT_TOKENS;
        const described = [];
        for (const c of list) {
            try { described.push({ c, cost: expectedCost(await describe(c), inTokens, outTokens) }); } catch { described.push({ c, cost: Infinity }); }
        }
        const strong = described[0];
        const cheap = described.reduce((a, b) => (b.cost < a.cost ? b : a), strong);
        if (cheap === strong || !(cheap.cost < strong.cost)) return list;
        const decisionCost = (inTokens * GEMINI_PER_MTOK) / 1e6;
        if (!(decisionCost < DECISION_SHARE_CAP * strong.cost)) return list;
        // A person's words go only to a provider that does not train on them (plan 16d; the owner's 11-12 note on
        // Google's free tier): the decider must say so, a key alone is never enough.
        if (typeof decider.privateOk !== 'function' || !(await decider.privateOk())) return list;
        const kind = kindOf(route, operation);
        let p;
        let receipt = null;
        try {
            const out = await decider.ask({ parts: [{ type: 'text', text }], text, questions: QUESTION, onlyText: true });
            if (!out) return list;
            const a = out.answers && out.answers.good_enough;
            p = a && Number(a.noul);
            receipt = out.receipt || null;
            if (!Number.isFinite(p)) return list;
        } catch (err) {
            log.warn && log.warn(`[ai] auto decision skipped: ${String((err && err.message) || err).slice(0, 160)}`);
            return list;
        }
        const threshold = await thresholdOf(kind);
        const exploring = p < threshold && p >= threshold - EXPLORE_BAND && random() < explore;
        const picked = p >= threshold || exploring ? 'cheap' : 'strong';
        const cost = receipt && Number.isFinite(Number(receipt.cost_usd)) ? Number(receipt.cost_usd) : decisionCost;
        const id = `rdc_${crypto.randomBytes(12).toString('hex')}`;
        const now = clock.now();
        const subject = subjectKey({ onBehalfOf: ctx.onBehalfOf, type: ctx.requesterType, id: ctx.requesterId });
        const subjectHash = subject ? hash(subject) : null;
        const promptHash = hash(text);
        try {
            await db.prepare(`INSERT INTO route_decisions (id, kind, p, threshold, picked, explore, decision_cost_usd, cheap_offer, strong_offer, cheap_cost_usd, strong_cost_usd, subject_hash, prompt_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, kind, p, threshold, picked, exploring ? 1 : 0, cost, offerKey(cheap.c), offerKey(strong.c), cheap.cost, strong.cost, subjectHash, promptHash, iso(now));
            // The same person asking the same thing again within 10 minutes: the earlier answer was not good enough.
            if (subjectHash) {
                await db.prepare("UPDATE route_decisions SET outcome = 'retried' WHERE subject_hash = ? AND prompt_hash = ? AND created_at >= ? AND id <> ? AND outcome IS NULL")
                    .run(subjectHash, promptHash, iso(now - RETRY_WINDOW_MS), id);
            }
        } catch (err) {
            log.warn && log.warn(`[ai] auto decision not recorded: ${String((err && err.message) || err).slice(0, 160)}`);
        }
        const round = (x) => Math.round(x * 1000) / 1000;
        explain.route_decision = { id, kind, p: round(p), threshold, picked, decision_cost_usd: cost, ...(exploring ? { explore: true } : {}) };
        const reason = picked === 'cheap'
            ? `Auto took the cheaper model ${offerKey(cheap.c)}: Decisions says it is good enough (p ${round(p)} ${exploring ? `just under ${threshold}, a measured try` : `≥ ${threshold}`})`
            : `Auto kept the stronger model ${offerKey(strong.c)}: Decisions says the cheaper one may not be good enough (p ${round(p)} < ${threshold})`;
        explain.reasons = [reason, ...(explain.reasons || [])];
        if (picked === 'strong') return list;
        return [cheap.c, ...list.filter((c) => c !== cheap.c)];
    }

    /** A product reports how a decided answer went (a test that passed, a vote). Only the person it answered. */
    async function outcome(id, good, who = {}) {
        const row = await db.prepare('SELECT id, subject_hash FROM route_decisions WHERE id = ?').get(String(id));
        if (!row) return { status: 404 };
        const subject = subjectKey(who);
        if (!subject || row.subject_hash !== hash(subject)) return { status: 404 };
        await db.prepare('UPDATE route_decisions SET outcome = ? WHERE id = ?').run(good ? 'good' : 'bad', row.id);
        return { status: 200, outcome: good ? 'good' : 'bad' };
    }

    /** The weekly fit, when it is due (due-based: one run per week whatever the process restarts). */
    async function fitIfDue() {
        const now = clock.now();
        const last = await db.prepare('SELECT max(fitted_at) AS at FROM route_thresholds').get();
        if (last && last.at && now - Date.parse(last.at) < FIT_EVERY_MS) return { due: false };
        const since = iso(now - 4 * FIT_EVERY_MS);
        const settled = iso(now - RETRY_WINDOW_MS);
        const rows = await db.prepare('SELECT kind, p, picked, outcome FROM route_decisions WHERE created_at >= ? AND created_at <= ?').all(since, settled);
        const byKind = new Map();
        for (const r of rows) {
            if (!byKind.has(r.kind)) byKind.set(r.kind, []);
            byKind.get(r.kind).push({ p: Number(r.p), picked: r.picked, bad: r.outcome === 'retried' || r.outcome === 'bad' });
        }
        const fitted = [];
        for (const [kind, list] of byKind) {
            const current = await thresholdOf(kind);
            const fit = fitThreshold(list, { current });
            const threshold = fit ? fit.threshold : current;
            await db.prepare(`INSERT INTO route_thresholds (kind, threshold, n, updated_at, fitted_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (kind) DO UPDATE SET threshold = excluded.threshold, n = excluded.n, updated_at = CASE WHEN route_thresholds.threshold = excluded.threshold THEN route_thresholds.updated_at ELSE excluded.updated_at END, fitted_at = excluded.fitted_at`)
                .run(kind, threshold, list.length, iso(now), iso(now));
            fitted.push({ kind, threshold, n: list.length, moved: threshold !== current });
        }
        // Nothing to fit still counts as a fit, so the job does not run again every hour.
        if (!fitted.length) {
            await db.prepare(`INSERT INTO route_thresholds (kind, threshold, n, updated_at, fitted_at) VALUES ('', ?, 0, ?, ?)
                ON CONFLICT (kind) DO UPDATE SET fitted_at = excluded.fitted_at`).run(DEFAULT_THRESHOLD, iso(now), iso(now));
        } else {
            await db.prepare("DELETE FROM route_thresholds WHERE kind = ''").run();
        }
        return { due: true, fitted };
    }

    return { step, outcome, fitIfDue, thresholdOf };
}

module.exports = { createAutoDecision, fitThreshold, requestText, kindOf, expectedCost, DEFAULT_THRESHOLD, QUESTION, RETRY_WINDOW_MS };
