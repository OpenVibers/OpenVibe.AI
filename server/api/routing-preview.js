'use strict';
const express = require('express');
const { CAPS } = require('../auth');
const { policyFor, select } = require('../exchange/compat-routing');
const { canonicalOf } = require('../exchange/catalog');
const { sendError } = require('../util');
function routingPreview({ auth, registry, log }) {
    const r = express.Router();
    r.post(
        '/v1/routing/preview',
        auth.appOrCap(CAPS.appRun, CAPS.runCreate),
        async (req, res) => {
            try {
                const { model, variant, policy } = policyFor(req.body || {});
                if (variant === 'online')
                    return res
                        .status(400)
                        .json({
                            error: {
                                code: 'input.invalid',
                                message:
                                    'Grounding is not part of a routing preview',
                            },
                        });
                const providers = new Map(
                    (await registry.listProviders())
                        .filter(
                            (p) =>
                                p.status === 'active' &&
                                p.kind !== 'stub' &&
                                p.metadata?.hidden !== true &&
                                p.metadata?.synthetic !== true &&
                                !['CUSTOMER_BYOK', 'RESTRICTED'].includes(
                                    p.provider_access,
                                ),
                        )
                        .map((p) => [p.key, p]),
                );
                const rows = (await registry.listModels()).filter(
                    (m) =>
                        m.status === 'active' && providers.has(m.provider_key),
                ).filter(
                    (m) => m.metadata?.hidden !== true && m.metadata?.synthetic !== true &&
                        m.metadata?.restricted !== true && m.metadata?.byok !== true &&
                        !['CUSTOMER_BYOK', 'RESTRICTED'].includes(m.provider_access || m.metadata?.provider_access),
                );
                const candidates = rows
                    .filter(
                        (m) =>
                            model === 'openvibe/auto' ||
                            canonicalOf(m, providers.get(m.provider_key)) ===
                                model ||
                            m.metadata?.id === model,
                    )
                    .map((m) => ({
                        provider: m.provider_key,
                        model: m.model_key,
                        row: m,
                    }));
                const answer = await select(candidates, policy, async (c) => {
                    const p = providers.get(c.provider),
                        m = c.row;
                    const privacy = p.metadata?.data_policy || {};
                    return {
                        priceIn: m.cost?.in_per_mtok,
                        priceOut: m.cost?.out_per_mtok,
                        training: privacy.training,
                        retention: privacy.retention,
                    };
                });
                // No prompt, credential, balance hold or upstream request is needed for this diagnostic.
                return res
                    .set('Cache-Control', 'no-store')
                    .json({
                        executable: false,
                        notice: 'Catalogue-only preview; live availability, account gates and budgets are checked at execution. Quality and speed are excluded when no measured evidence is supplied.',
                        candidates: answer.allowed.map((c) => ({
                            provider: c.provider,
                            model: c.model,
                        })),
                        excluded: answer.excluded,
                    });
            } catch (err) {
                return sendError(res, err, req.ov, log);
            }
        },
    );
    r.post(
        '/v1/presets/import/preview',
        auth.appOrCap(CAPS.appRun, CAPS.runCreate),
        (req, res) => {
            try {
                return res
                    .set('Cache-Control', 'no-store')
                    .json(
                        require('../exchange/import-preset').importPreset(
                            req.body,
                        ),
                    );
            } catch (err) {
                return sendError(res, err, req.ov, log);
            }
        },
    );
    return r;
}
module.exports = { routingPreview };
