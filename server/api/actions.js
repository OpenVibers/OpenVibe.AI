'use strict';

/**
 * The Action Center read (plan 2026-10-28 §3.10): GET /api/v1/actions?subject=usr_…
 *
 * A Network service token for audience openvibe.ai holding ai.actions.read names one person and gets the runs whose
 * on_behalf_of is that user, as common.action-list-result@1: everything queued/running, then done and failed runs from
 * the last 30 days, newest updated first, at most 50. Never a run made for anyone else; a person's token, a token
 * without the capability and a subject that is not a usr_… id are refused.
 */
const express = require('express');
const { AiError, sendError } = require('../util');
const { CAPS } = require('../auth');
const items = require('../actions/items');

const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = 86_400_000;

function actionsRouter({ runs, registry, auth, log = console }) {
    const r = express.Router();
    r.get('/api/v1/actions', auth.requireCap(CAPS.actionsRead), async (req, res) => {
        try {
            const subject = String(req.query.subject || '').trim();
            if (!USER.test(subject)) throw new AiError(400, 'input.invalid', 'subject must be a usr_… subject id');
            const list = await runs.listOnBehalfOf(subject, { since: Date.now() - 30 * DAY, limit: 50 });
            const workflows = new Map();
            const out = [];
            for (const run of list) {
                const key = `${run.workflow.key}@${run.workflow.version}`;
                if (!workflows.has(key)) workflows.set(key, await registry.getWorkflow(run.workflow.key, run.workflow.version));
                out.push(items.toItem(run, workflows.get(key)));
            }
            res.json({ items: out });
        } catch (err) { sendError(res, err, req.ov, log); }
    });
    return r;
}

module.exports = { actionsRouter };
