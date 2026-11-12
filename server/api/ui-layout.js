'use strict';
/**
 * POST /api/v1/ui/layout/suggest (ai.layout.suggest; make your own controls design, 2026-11-11,
 * piece 6). A first-party service sends the surface catalog, the layout shown now, the person's words
 * and the device; a validated ui.layout@1 and a one-sentence summary come back, or an honest
 * "couldn't" with the validator's reasons.
 *
 * The run is the workflow ui.layout.suggest on the cheap structured-output route. If its answer
 * breaks a rule, this route makes ONE more run with the validator's reasons in the input (the same
 * catalog and words, no other change). It never applies a layout: the caller previews it for the
 * person. The person the service names in X-OV-Subject is the run's owner, so their own AI limits,
 * preferences and cache scope apply.
 */
const express = require('express');
const { validate, http } = require('openvibe-contracts');
const { AiError, sendError } = require('../util');

const CAP = 'ai.layout.suggest';
const REQUEST = 'ui.layout-request@1';
const SUGGESTION = 'ui.layout-suggestion@1';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const WAIT_MS = 20000;
const LIMIT = 10;
const WINDOW_MS = 60_000;

function uiLayoutRouter({ runs, auth, log = console, now = () => Date.now() }) {
    const r = express.Router();
    r.use(http.middleware());
    const guard = auth.requireCap(CAP);
    const seen = new Map();
    const allow = (key, at) => {
        const kept = (seen.get(key) || []).filter((t) => at - t < WINDOW_MS);
        if (kept.length >= LIMIT) { seen.set(key, kept); return false; }
        kept.push(at); seen.set(key, kept);
        if (seen.size > 5000) seen.delete(seen.keys().next().value);
        return true;
    };

    const receiptOf = (run) => ({
        model: String((run.provenance && run.provenance.model) || run.model || 'unknown').slice(0, 200),
        ...(run.provenance && run.provenance.provider ? { provider: String(run.provenance.provider).slice(0, 100) } : {}),
        ...(run.provenance && run.provenance.route ? { route: String(run.provenance.route).slice(0, 200) } : {}),
        run_id: String(run.id),
        cost_usd: Number(run.usage && run.usage.cost_usd) || 0,
    });

    function refused(reasons, run) {
        const list = (reasons || []).map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, 20);
        const why = list[0] || 'the model could not make that layout';
        return { ok: false, layout: null, summary: `Couldn't do that: ${why}`.slice(0, 300), reasons: list.length ? list : [why], receipt: receiptOf(run) };
    }

    async function oneRun(input, req) {
        const created = await runs.create({ workflow: 'ui.layout.suggest', task: 'ui.layout.suggest', input }, req.principal, {
            trace: req.ov && req.ov.traceId, requestId: req.ov && req.ov.requestId, callerWaitMs: WAIT_MS,
        });
        return await runs.explained(await runs.wait(created, WAIT_MS));
    }

    const unavailable = (run) => run && run.error && ['provider.unavailable', 'route.unavailable', 'ai.resting', 'workflow.not_found', 'task.not_found'].includes(run.error.code);

    r.post('/api/v1/ui/layout/suggest', guard, async (req, res) => {
        try {
            const at = now();
            const named = String(req.get('x-ov-subject') || '').trim();
            if (named && !SUBJECT_RE.test(named)) throw new AiError(422, 'input.invalid', 'X-OV-Subject names a person with usr_…');
            if (named) req.principal = { ...req.principal, onBehalfOf: named };
            if (!allow(named || (req.principal && req.principal.sub) || 'anonymous', at)) {
                throw new AiError(429, 'layout.rate_limited', 'too many layout suggestions; wait a minute');
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const v = validate(REQUEST, body);
            if (!v.valid) throw new AiError(422, 'input.invalid', `the request does not match ${REQUEST}`, { errors: v.errors });
            let run = await oneRun(body, req);
            if (run.status !== 'succeeded' || !run.output || run.output.ok !== true) {
                const first = run.status !== 'succeeded'
                    ? [run.error && run.error.detail ? String(run.error.detail).slice(0, 300) : 'the model did not answer with a layout']
                    : (Array.isArray(run.output.reasons) && run.output.reasons.length ? run.output.reasons : ['the answer broke a rule']);
                if (run.status !== 'succeeded' && unavailable(run)) throw new AiError(503, 'layout.suggest_unavailable', first[0]);
                // One retry with the validator's reasons. Same catalog, same words, same device.
                run = await oneRun({ ...body, retry: { reasons: first.slice(0, 20) } }, req);
            }
            if (run.status !== 'succeeded') {
                if (unavailable(run)) throw new AiError(503, 'layout.suggest_unavailable', (run.error && run.error.detail) || 'the model is unavailable');
                return res.json(refused([run.error && run.error.detail || 'the model could not make that layout'], run));
            }
            const answer = run.output && typeof run.output === 'object' ? { ...run.output, receipt: receiptOf(run) } : null;
            if (!answer || !validate(SUGGESTION, answer).valid) {
                throw new AiError(502, 'layout.suggest_invalid', 'the model answered something that is not a layout suggestion');
            }
            if (!answer.ok) return res.json({ ...answer, receipt: receiptOf(run) });
            // The layout is already checked with openvibe-sdk/ui-layout by the workflow's postprocess; the
            // route only confirms the whole answer is ui.layout-suggestion@1.
            return res.json(answer);
        } catch (err) {
            if (err && err.status) return sendError(res, err, req.ov, log);
            log.error && log.error('[ui-layout]', err && err.stack || err);
            return http.sendProblem(res, 500, 'layout.suggest_error', { detail: 'could not suggest a layout', ctx: req.ov });
        }
    });
    return r;
}

module.exports = { uiLayoutRouter, CAP };
