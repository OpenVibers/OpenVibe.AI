'use strict';
/**
 * GET /v1/models and GET /v1/models/{id} in both wire protocols (AI Exchange P4, CHECKPOINT D3/D4).
 *
 * With AI_MODEL_CATALOG on, the list is the registry's real models as ai.model@1 catalog entries plus the dynamic
 * policy aliases (openvibe/auto, economy, balanced, fast, private; legacy openvibe), each alias carrying dynamic:true.
 * With the flag off, both protocols answer exactly the legacy single virtual `openvibe` model.
 *
 * The same path serves OpenAI and Anthropic clients. Anthropic's SDK identifies itself with `anthropic-version`;
 * this module reads that header (or ?format=anthropic) so the response and the error shape match the protocol.
 * A client that sends neither gets OpenAI's shape. The OpenAI and Anthropic routers each register the routes; the
 * OpenAI router steps aside for an Anthropic request before its auth guard, so that router's error shape applies.
 */
const modelCatalog = require('../providers/model-catalog');

const LEGACY_MODEL = 'openvibe';
const LEGACY_CREATED = 1760486400;
const LEGACY_CREATED_AT = '2026-10-30T00:00:00Z';

/** Does the caller speak Anthropic's models protocol? */
function wantsAnthropic(req) {
    return Boolean(String((req.headers && req.headers['anthropic-version']) || '').trim()) || Boolean(req.query && req.query.format === 'anthropic');
}

const epochOf = (iso) => {
    const ms = Date.parse(iso || '');
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : LEGACY_CREATED;
};
const aliasEntry = (alias) => ({
    ...alias,
    object: 'model',
    type: 'chat',
    owned_by: 'openvibe',
    created: LEGACY_CREATED,
    created_at: LEGACY_CREATED_AT,
    display_name: alias.name,
});
const catalogOpenAi = (x) => ({
    ...x.entry,
    id: x.entry.id || `${x.entry.provider_key}/${x.entry.model_key}`,
    object: 'model',
    created: epochOf(x.entry.created_at),
    owned_by: x.entry.provider_key,
    dynamic: false,
});
const catalogAnthropic = (x) => ({
    ...x.entry,
    type: 'model',
    id: x.entry.id || `${x.entry.provider_key}/${x.entry.model_key}`,
    display_name: x.entry.display_name || x.entry.model_key,
    created_at: x.entry.created_at || LEGACY_CREATED_AT,
    dynamic: false,
});
const anthropicAlias = (alias) => ({
    ...alias,
    type: 'model',
    display_name: alias.name,
    created_at: LEGACY_CREATED_AT,
    object: undefined,
    owned_by: undefined,
    created: undefined,
});

/** The catalog list in one protocol. Flag off: today's single virtual model. */
async function list({ registry, config, protocol }) {
    const enabled = Boolean(config.modelCatalog && config.modelCatalog.enabled);
    if (!enabled) {
        if (protocol === 'anthropic') return { data: [{ type: 'model', id: LEGACY_MODEL, display_name: 'OpenVibe AI', created_at: LEGACY_CREATED_AT }], has_more: false, first_id: LEGACY_MODEL, last_id: LEGACY_MODEL };
        return { object: 'list', data: [{ id: LEGACY_MODEL, object: 'model', created: LEGACY_CREATED, owned_by: 'openvibe' }] };
    }
    const aliases = modelCatalog.ALIASES.map((a) => (protocol === 'anthropic' ? anthropicAlias(a) : aliasEntry(a)));
    const models = (await modelCatalog.entries({ registry })).map((x) => (protocol === 'anthropic' ? catalogAnthropic(x) : catalogOpenAi(x)));
    const data = [...aliases, ...models];
    if (protocol === 'anthropic') return { data, has_more: false, first_id: data.length ? data[0].id : null, last_id: data.length ? data[data.length - 1].id : null };
    return { object: 'list', data };
}

/** One model (or dynamic alias) in one protocol; null when it does not exist. */
async function find({ registry, config, protocol, id }) {
    const enabled = Boolean(config.modelCatalog && config.modelCatalog.enabled);
    if (!enabled) return null;
    const alias = modelCatalog.ALIASES.find((a) => a.id === id);
    if (alias) return protocol === 'anthropic' ? anthropicAlias(alias) : aliasEntry(alias);
    const found = await modelCatalog.entries({ registry });
    const x = found.find((m) => m.entry.id === id) || found.find((m) => `${m.entry.provider_key}/${m.entry.model_key}` === id);
    if (!x) return null;
    return protocol === 'anthropic' ? catalogAnthropic(x) : catalogOpenAi(x);
}

/** Write a list response in the handler's protocol. */
async function sendList(req, res, { registry, config, protocol }) {
    const body = await list({ registry, config, protocol: protocol || (wantsAnthropic(req) ? 'anthropic' : 'openai') });
    res.json(body);
}

/** Write a single-model response, or the protocol's 404. */
async function sendOne(req, res, { registry, config, protocol }) {
    const proto = protocol || (wantsAnthropic(req) ? 'anthropic' : 'openai');
    let id = req.params && req.params[0] != null ? String(req.params[0]) : '';
    try { id = decodeURIComponent(id); } catch { /* keep the raw id */ }
    const body = await find({ registry, config, protocol: proto, id });
    if (!body) {
        if (proto === 'anthropic') return res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: `no model ${id}`, code: 'ai.model_not_found' } });
        return res.status(404).json({ error: { message: `no model ${id}`, type: 'invalid_request_error', code: 'ai.model_not_found', param: null } });
    }
    return res.json(body);
}

/** The protocol's error object (a registry failure inside a models route, which Express 4 does not catch by itself). */
function sendError(res, protocol, status, message, code) {
    if (protocol === 'anthropic') return res.status(status).json({ type: 'error', error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message: String(message || 'error').slice(0, 1000), code: code || null } });
    return res.status(status).json({ error: { message: String(message || 'error').slice(0, 1000), type: status >= 500 ? 'api_error' : 'invalid_request_error', code: code || null, param: null } });
}

/**
 * The `openvibe` disclosure of a finished run (D3), only while the catalog flag is on. Null with the flag off: no
 * field or SSE comment is added, exactly as before.
 */
async function disclosureOf({ registry, config, run }) {
    if (!(config.modelCatalog && config.modelCatalog.enabled)) return null;
    return modelCatalog.disclosureOf({ registry, run });
}

module.exports = { wantsAnthropic, list, find, sendList, sendOne, sendError, disclosureOf, LEGACY_MODEL };
