'use strict';
/**
 * The picture-orientation detector (pictures, 2026-11-11 part 3): one small function that answers which way is up.
 *
 *   POST /api/v1/vision/orientation   a 256 px copy (data URL) or a Media reference → { rotation, confidence, receipt }
 *   GET  /api/v1/admin/orientation    the owner console's reading: the setting, today's count and spend, recent tries
 *
 * The owner turns it on for the whole network on Exchange (the `pics.orientation` task defaults): method off|vision,
 * the model (OpenVibe's router by default, the cheapest vision model that can see), the confidence a picture must
 * reach, a daily picture cap and a daily budget. A run is an ordinary AI run of the `pics.orientation` workflow, so
 * it carries the same receipt, quota, audit and usage as every other run; the endpoint refuses before spending when
 * today's count or cost would pass the owner's bounds.
 */
const express = require('express');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { AiError, sendError } = require('../util');
const { CAPS, namespaceAllowed, bearer } = require('../auth');
const { receiptId } = require('../exchange/receipts');

const PERSON_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PRINCIPAL = /^(svc|app|mod|node):/;

const DAY = 24 * 60 * 60 * 1000;
const MAX_IMAGE = 2 * 1024 * 1024;

const cleanNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const dayStart = (ms) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** The setting as the console reads it: every field the detector obeys, never a secret. */
function settingOf(d) {
    return {
        method: d && d.method ? d.method : 'off',
        confidence: d && d.confidence != null ? Number(d.confidence) : 0.8,
        daily_cap: d && d.daily_cap != null ? Number(d.daily_cap) : null,
        budget_usd_per_day: d && d.budget_usd_per_day != null ? Number(d.budget_usd_per_day) : null,
        model: d && d.signed_in ? d.signed_in : null,
        max_cost_usd: d && d.max_cost_usd != null ? Number(d.max_cost_usd) : null,
    };
}

function createOrientation({ choices, runs, registry = null, auth, db, config = {}, clock = { now: () => Date.now() }, log = console }) {
    if (!auth) throw new TypeError('createOrientation: auth is required');
    const r = express.Router();
    // A service (Media) runs with its own token; the Exchange owner's Try it forwards the person's Network session,
    // which AI's own person routes already accept from Exchange for audience openvibe.network. A person here must be
    // owner/admin: the detector's budget is the network's, so a stranger does not spend it.
    const serviceGuard = auth.requireCap(CAPS.runCreate);
    async function personGuard(req, res, next) {
        const token = bearer(req);
        let claims;
        try {
            claims = await verifyUserToken(token, {
                ...(config.networkPublicKey ? { publicKey: config.networkPublicKey } : { jwks: config.networkJwksUrl }),
                issuer: config.issuer, audience: ['openvibe.network', 'openvibe.ai'], now: clock.now(), log,
            });
        } catch (err) {
            return sendError(res, new AiError(401, 'token.invalid', 'a person or service token is required'), req.ov, log);
        }
        if (!claims || PRINCIPAL.test(String(claims.sub || '')) || ['service', 'app', 'mod', 'node'].includes(claims.actor_type)) {
            return sendError(res, new AiError(403, 'capability.denied', 'a person token is required on this route'), req.ov, log);
        }
        if (!['owner', 'admin'].includes(String(claims.role || ''))) {
            return sendError(res, new AiError(403, 'role.admin_required', 'the orientation detector is the owner\'s'), req.ov, log);
        }
        const subject = PERSON_SUBJECT.test(String(claims.subject_id || '')) ? claims.subject_id
            : PERSON_SUBJECT.test(String(claims.sub || '')) ? claims.sub : null;
        if (!subject) return sendError(res, new AiError(401, 'token.invalid', 'the person token has no user subject'), req.ov, log);
        req.principal = { kind: 'user', sub: claims.sub, subject: { type: 'user', id: subject }, claims };
        return next();
    }
    function guard(req, res, next) {
        const token = bearer(req);
        if (!token) return serviceGuard(req, res, next);
        return Promise.resolve().then(async () => {
            let service = null;
            try { service = await auth.verify(token); } catch { service = null; }
            if (service && service.ok) return serviceGuard(req, res, next);
            return personGuard(req, res, next);
        }).catch((err) => sendError(res, err, req.ov, log));
    }

    const json = (fn) => async (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(await fn(req)); }
        catch (err) { sendError(res, err, req.ov, log); }
    };

    async function today() {
        try {
            const row = await db.prepare(`SELECT count(*) AS n, COALESCE(sum(cost_usd), 0) AS cost FROM runs
                WHERE workflow_key = 'pics.orientation' AND status = 'succeeded' AND created_at >= ?`).get(dayStart(clock.now()));
            return { runs: Number(row && row.n) || 0, cost_usd: Math.round((Number(row && row.cost) || 0) * 1e6) / 1e6 };
        } catch { return { runs: 0, cost_usd: 0 }; }
    }

    async function defaults() {
        return (await choices.defaults())['pics.orientation'] || {};
    }

    /**
     * A Media/MediaHub service token runs any picture its grant covers; a person runs for themselves. An app may
     * not turn another app's pictures (the run would be the project's), so it is refused here.
     */
    function checkCaller(req) {
        if (req.principal.kind === 'app') throw new AiError(403, 'capability.denied', 'an app does not run the orientation detector');
        if (req.principal.kind !== 'user' && !namespaceAllowed(req.principal, 'pics.orientation')) {
            throw new AiError(403, 'capability.namespace_denied', 'this token may not run pics.orientation');
        }
    }

    r.post('/api/v1/vision/orientation', express.json({ limit: '3mb' }), guard, json(async (req) => {
        checkCaller(req);
        const d = await defaults();
        const setting = settingOf(d);
        if (setting.method !== 'vision') {
            // Off is an answer, not an error: a caller that always asks learns nothing new and spends nothing.
            return { method: 'off', answered: false, rotation: null, confidence: null };
        }
        const image = req.body && req.body.image;
        if (!image || typeof image !== 'object' || Array.isArray(image)) throw new AiError(422, 'input.invalid', 'image must be a data URL (a 256 px copy) or a Media reference');
        if (image.data_url != null) {
            if (typeof image.data_url !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(image.data_url)) {
                throw new AiError(422, 'input.invalid', 'image.data_url must be a base64 JPEG, PNG or WebP data URL');
            }
            if (image.data_url.length > MAX_IMAGE * 2) throw new AiError(413, 'source.too_large', 'send a 256 px copy (at most 2 MiB)');
        } else if (!image.media || typeof image.media.media_id !== 'string') {
            throw new AiError(422, 'input.invalid', 'image needs a data_url or a Media reference');
        }
        const spent = await today();
        if (setting.daily_cap != null && spent.runs >= setting.daily_cap) {
            throw new AiError(429, 'orientation.daily_cap', `the orientation detector has answered ${spent.runs} picture${spent.runs === 1 ? '' : 's'} today, its cap of ${setting.daily_cap}`, { retry_after_seconds: 3600 });
        }
        if (setting.budget_usd_per_day != null && spent.cost_usd >= setting.budget_usd_per_day) {
            throw new AiError(429, 'orientation.daily_budget', `the orientation detector has spent $${spent.cost_usd.toFixed(4)} today, its daily budget of $${setting.budget_usd_per_day.toFixed(4)}`, { retry_after_seconds: 3600 });
        }
        const created = await runs.create({
            workflow: 'pics.orientation',
            input: { image: { ...(image.data_url != null ? { data_url: image.data_url } : { media: image.media }), max_width: 256 }, ...(typeof req.body.hint === 'string' ? { hint: req.body.hint.slice(0, 200) } : {}) },
            // The owner's model choice is the task default; the cheapest can-see model is the router's ranking.
            preset: { name: 'cheapest', policy: { objective: 'cheapest' } },
        }, req.principal, { trace: req.ov.traceId, requestId: req.ov.requestId, abuse: req.abuse });
        const run = await runs.wait(created, 45000);
        if (!run || run.status === 'queued' || run.status === 'running') throw new AiError(503, 'orientation.slow', 'the model is still looking at the picture; try again in a minute', { retry_after_seconds: 60 });
        if (run.status !== 'succeeded') {
            const why = (run.error && (run.error.detail || run.error.code)) || 'the model did not answer';
            throw new AiError(502, 'orientation.failed', String(why).slice(0, 300));
        }
        const out = run.output || {};
        const rotation = cleanNumber(out.rotation);
        const confidence = cleanNumber(out.confidence);
        if (![0, 90, 180, 270].includes(rotation) || confidence == null) throw new AiError(502, 'orientation.unreadable', 'the model answered without a usable rotation');
        const after = await today();
        return {
            method: 'vision', answered: true,
            rotation, confidence: Math.max(0, Math.min(1, confidence)),
            model: (run.provenance && run.provenance.model) || null,
            provider: (run.provenance && run.provenance.provider) || null,
            cost_usd: run.usage ? run.usage.cost_usd : null,
            receipt_id: receiptId(run.id),
            run_id: run.id,
            setting: { confidence: setting.confidence },
            budget: { runs_today: after.runs, daily_cap: setting.daily_cap, cost_usd_today: after.cost_usd, budget_usd_per_day: setting.budget_usd_per_day },
        };
    }));

    // The owner console's reading: what the detector is set to, what it has spent today, and the last tries.
    r.get('/api/v1/admin/orientation', auth.requireCap(CAPS.usageRead, CAPS.workflowManage), json(async () => {
        const d = await defaults();
        const spent = await today();
        let recent = [];
        try {
            const rows = await db.prepare(`SELECT id, status, output, provider_key, model_key, cost_usd, created_at FROM runs
                WHERE workflow_key = 'pics.orientation' ORDER BY created_at DESC LIMIT 20`).all();
            recent = rows.map((row) => {
                let out = null;
                try { out = row.output ? JSON.parse(row.output) : null; } catch { out = null; }
                return {
                    run_id: row.id, status: row.status, created_at: row.created_at,
                    rotation: out && [0, 90, 180, 270].includes(Number(out.rotation)) ? Number(out.rotation) : null,
                    confidence: out && Number.isFinite(Number(out.confidence)) ? Number(out.confidence) : null,
                    provider: row.provider_key || null, model: row.model_key || null,
                    cost_usd: row.cost_usd == null ? null : Number(row.cost_usd), receipt_id: receiptId(row.id),
                };
            });
        } catch (err) { log.warn('[orientation] recent runs unreadable:', err.message); }
        return { setting: settingOf(d), today: spent, recent };
    }));

    return r;
}

module.exports = { createOrientation, settingOf };
