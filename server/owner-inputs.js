'use strict';
/**
 * Owner inputs (the owner-setup design of 2026-11-07): what the admin panel's Setup tab shows for AI's keys, and the
 * test hook behind its Test button.
 *
 *   POST /internal/config/:namespace/test/:key   (ai.config.manage, the same guard as the config routes)
 *     → 200 { ok, message, state, source, namespace, key, tested_at }   (409 config.not_set when nothing is set)
 *       The shape of openvibe-shared 4.125.0's test hook ({ ok, message }, 409 config.not_set) with more beside it:
 *       state is connected (the provider accepted it) or not_working (refused, or no answer); source is where the
 *       value came from: vault (entered in the admin panel) or env (the server's settings file, which the code falls
 *       back to and so is tested too). The value is read on the server, sent only to the provider it belongs to, and
 *       never appears in the answer, a log line or an error: a provider's own message is scrubbed of it and cut to one
 *       short line. It is mounted before the config routes, so a Shared upgrade's own hook never shadows it.
 *
 * Every test makes one cheap authenticated read: the provider's model list, the GPU marketplace's account or
 * instance list. Nothing is created, rented or spent.
 */
const { PRESETS } = require('./console/presets');
const { GPU_HOSTS, SERVER_HOSTS, ACCOUNTS } = require('./setup/hosts');
const { ovhHeaders, ociHeaders, googleAccessToken } = require('./setup/signing');

// The Setup groups by id (openvibe-shared's OWNER_INPUT_GROUPS, 4.125.0 and the 4.250.0 servers group):
// x-owner-input.group is one of these ids.
const SETUP_GROUPS = Object.freeze(['money', 'ai-providers', 'gpus', 'servers', 'voices', 'chat-apps', 'sign-in-apps',
    'data-sources', 'design-publishing', 'domains', 'legal']);
const TEST_TIMEOUT_MS = 10_000;

/** Where to get a provider's key, by the origin of its base URL: the presets' key pages, and a line on what to pick. */
const KEY_HOW = Object.freeze({
    deepseek: 'Sign in, open API keys and create one. DeepSeek only answers while the account has a topped-up balance.',
    openrouter: 'Create a key; give it a credit limit to cap what OpenVibe can spend through it.',
    groq: 'Create an API key. The free tier is enough to test it; paid limits need billing on the account.',
    gemini: 'Create an API key in a Google Cloud project; turn billing on in that project for paid limits.',
    mistral: 'Create an API key in a workspace on a paid plan (the free Experiment plan works for testing).',
    together: 'Open Settings, API keys, and create a key for the account that pays for it.',
    fireworks: 'Open Account, API keys, and create a key.',
    cerebras: 'Sign in, open API Keys and create one.',
    xai: 'Open API Keys in the xAI console and create a key that may use chat models.',
    openai: 'Create a secret key for the project that pays for it. A restricted key needs Models read and Model capabilities write.',
    anthropic: 'Create a key in the workspace that pays for it (Settings, API keys).',
    'deepseek-anthropic': 'Sign in, open API keys and create one. DeepSeek only answers while the account has a topped-up balance.',
    'minimax-anthropic': 'Open Account, Interface key, and create an API key for the pay-as-you-go plan.',
});

function originOf(url) {
    try { const u = new URL(String(url || '')); return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : ''; } catch { return ''; }
}

/** { get_it_at, get_it_how } for a provider record ({ key, base_url }): its preset's key page, else its own site. */
function keyPage(provider) {
    const origin = originOf(provider && provider.base_url);
    const preset = PRESETS.find((p) => p.keys && p.base_url && (p.id === (provider && provider.key) || (origin && originOf(p.base_url) === origin && p.base_url.replace(/\/+$/, '') === String(provider.base_url || '').replace(/\/+$/, ''))))
        || PRESETS.find((p) => p.keys && p.base_url && origin && originOf(p.base_url) === origin);
    if (preset) return { get_it_at: preset.keys, get_it_how: KEY_HOW[preset.id] || 'Sign in at the provider, open its API keys page and create a key.' };
    const site = origin && origin.startsWith('https:') ? origin.replace(/\/\/api\./, '//') : null;
    return { get_it_at: site, get_it_how: 'Sign in at the provider, open its API keys page and create a key for the account that pays.' };
}

/** One line, at most 200 characters, with every given secret replaced. */
function oneLine(text, secrets = []) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    for (const v of secrets) {
        if (typeof v !== 'string' || v.length < 4) continue;
        s = s.split(v).join('[hidden]');
        if (v.length >= 12) s = s.split(v.slice(0, 12)).join('[hidden]');
    }
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/** A fetch with a time limit; never throws, answers { status, json, error }. */
async function probe(fetchImpl, url, { headers = {}, method = 'GET', timeoutMs = TEST_TIMEOUT_MS } = {}) {
    let res;
    try {
        res = await fetchImpl(url, { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        return { status: 0, json: null, error: err && err.name === 'TimeoutError' ? 'it did not answer within 10 seconds' : `it could not be reached (${(err && (err.code || err.message)) || 'network error'})` };
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, error: null };
}

/** The provider's own refusal text, if it sent one. */
function providerSays(json) {
    if (!json || typeof json !== 'object') return '';
    const e = json.error;
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
    return '';
}

function refused(name, r) {
    if (r.error) return `${name} ${r.error}.`;
    const says = providerSays(r.json);
    if (r.status === 401 || r.status === 403) return `${name} refused the key (${r.status})${says ? `: ${says}` : '.'}`;
    if (r.status === 402) return `${name} accepted the key but says the account has no balance (402)${says ? `: ${says}` : '.'}`;
    if (r.status === 429) return `${name} is limiting requests right now (429); try again in a minute.`;
    return `${name} answered ${r.status}${says ? `: ${says}` : '.'}`;
}

/**
 * Test one provider key: the provider's model list, which every OpenAI-compatible API, Anthropic and Gemini serve
 * for free. provider is the registry record; key the value to test.
 */
async function testProviderKey(provider, key, { fetchImpl }) {
    const name = provider.display_name || provider.key;
    const base = String(provider.base_url || '').replace(/\/+$/, '');
    if (!base) return { ok: false, message: `${name} has no base URL, so there is nothing to send the key to.` };
    let url = `${base}/models`;
    let headers = { Authorization: `Bearer ${key}` };
    if (provider.kind === 'anthropic') {
        headers = /anthropic\.com/i.test(base) ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' };
        if (!/\/v1$/.test(base) && /anthropic\.com/i.test(base)) url = `${base}/v1/models`;
    } else if (provider.key === 'gemini' || provider.kind === 'gemini' || provider.metadata?.api_family === 'google') {
        url = 'https://generativelanguage.googleapis.com/v1beta/models';
        headers = { 'x-goog-api-key': key };
    }
    if (provider.metadata && provider.metadata.models_endpoint) url = provider.metadata.models_endpoint;
    if (provider.auth_mode === 'none') headers = {};
    else if (provider.kind !== 'anthropic' && provider.key !== 'gemini' && provider.kind !== 'gemini' && provider.metadata?.api_family !== 'google' && provider.auth_mode === 'x-api-key') headers = { 'x-api-key': key };
    // A configured models endpoint receives a key only on the origin the owner entered it for.
    try { if (new URL(url).origin !== new URL(base).origin) return { ok: false, message: `${name} has a model-list address on a different origin.` }; }
    catch { return { ok: false, message: `${name} has an invalid model-list address.` }; }
    const r = await probe(fetchImpl, url, { headers });
    if (r.status >= 200 && r.status < 300) {
        const list = r.json && (Array.isArray(r.json.data) ? r.json.data : Array.isArray(r.json.models) ? r.json.models : null);
        if (!list) return { ok: false, message: `${name} answered without a model list.` };
        return { ok: true, message: `${name} accepted the key and lists ${list.length} model${list.length === 1 ? '' : 's'}.`, models: list.map(m => m.id || m.name).filter(x => typeof x === 'string') };
    }
    return { ok: false, message: refused(name, r) };
}

/** Test a GPU marketplace key: Vast.ai's current user, RunPod's pod list (both read-only, nothing is rented). */
async function testGpuKey(marketplace, key, { fetchImpl, origin }) {
    if (marketplace === 'vast') {
        const r = await probe(fetchImpl, `${origin || 'https://console.vast.ai'}/api/v0/users/current/`, { headers: { Authorization: `Bearer ${key}` } });
        if (r.status >= 200 && r.status < 300) {
            const credit = r.json && Number.isFinite(Number(r.json.credit)) ? ` The account has $${Number(r.json.credit).toFixed(2)} of credit.` : '';
            return { ok: true, message: `Vast.ai accepted the key.${credit}` };
        }
        return { ok: false, message: refused('Vast.ai', r) };
    }
    const r = await probe(fetchImpl, `${origin || 'https://api.runpod.io'}/v2/pods`, { headers: { Authorization: `Bearer ${key}` } });
    if (r.status >= 200 && r.status < 300) return { ok: true, message: 'RunPod accepted the key.' };
    return { ok: false, message: refused('RunPod', r) };
}

/**
 * The host rows (server/setup/hosts.js): the GPU marketplaces and the servers the owner can configure. The
 * row's own fields are in the catalogue; here they are tested.
 */
const HOST_ROWS = Object.freeze({ gpus: GPU_HOSTS, servers: SERVER_HOSTS });

/** The host row of a group with this id, or null. */
function hostRow(group, id) {
    const list = HOST_ROWS[group] || [];
    return list.find((h) => h.id === String(id || '')) || null;
}

/** The account row with this id (a provider that needs more than one value), or null. */
function accountRow(id) {
    return ACCOUNTS.find((a) => a.id === String(id || '')) || null;
}

/** Fill a row's {placeholders} with the other fields of the same row. */
function fillUrl(url, parts) {
    return String(url || '').replace(/\{(\w+)\}/g, (whole, name) => (parts && parts[name] != null && parts[name] !== '' ? String(parts[name]) : whole));
}

/** The list in an answer: the array the host says it has. */
function listOf(json, name) {
    if (Array.isArray(json)) return json.length;
    if (!json || typeof json !== 'object') return null;
    for (const key of [name, 'data', 'items', 'results', 'offers', 'projects', 'servers']) {
        if (Array.isArray(json[key])) return json[key].length;
    }
    return null;
}

/**
 * Test one host row: one cheap authenticated read of the host's own account, servers or models. Nothing is
 * created, rented or bought. The row's other fields (a consumer key, a region, an organization) are the ones
 * the host asks for; they are read here and never written down.
 */
async function testHostKey(host, key, { fetchImpl, parts = {} } = {}) {
    const spec = host && host.test;
    const name = (host && (host.test && host.test.name)) || (host && host.name) || 'The host';
    if (!spec) return { ok: false, message: `${name} has no public API to read, so there is nothing to test.` };
    const url = fillUrl(spec.url, parts);
    let headers = {};
    if (spec.auth === 'bearer') headers = { Authorization: `Bearer ${key}` };
    else if (spec.auth === 'basic') headers = { Authorization: `Basic ${Buffer.from(`${parts.user || ''}:${key}`).toString('base64')}` };
    else if (spec.auth === 'x-api-key') headers = { 'X-API-Key': key };
    else if (spec.auth === 'x-auth-token') headers = { 'X-Auth-Token': key };
    else if (spec.auth === 'ovh') {
        if (!parts.application_key || !parts.consumer_key) return { ok: false, message: `${name} needs its application key and consumer key before the key can be tested.` };
        headers = ovhHeaders({ applicationKey: parts.application_key, applicationSecret: key, consumerKey: parts.consumer_key, method: 'GET', url });
    } else if (spec.auth === 'oci') {
        if (!parts.tenancy || !parts.user || !parts.fingerprint || !parts.region) {
            return { ok: false, message: `${name} needs its tenancy, user, fingerprint and region before the key can be tested.` };
        }
        headers = ociHeaders({ tenancy: parts.tenancy, user: parts.user, fingerprint: parts.fingerprint, privateKey: key, method: 'GET', url });
    } else return { ok: false, message: `${name} has no way to sign its requests.` };
    const r = await probe(fetchImpl, url, { headers });
    if (r.status >= 200 && r.status < 300) {
        if (!spec.list) return { ok: true, message: `${name} accepted the key.` };
        const items = listOf(r.json, spec.list_path || spec.list);
        if (items == null) return { ok: false, message: `${name} answered without a ${spec.list} list.` };
        const noun = items === 1 ? String(spec.list).replace(/s$/, '') : spec.list;
        return { ok: true, message: `${name} accepted the key and lists ${items} ${noun}.` };
    }
    return { ok: false, message: refused(name, r) };
}

/**
 * Test one account row: a provider that needs more than one value (Vertex AI's service account, project and
 * region). The service account's JSON key buys a short access token from Google and the token is used for
 * one read: the publisher models of that region.
 */
async function testAccountKey(account, key, { fetchImpl, parts = {} } = {}) {
    const spec = account && account.test;
    const name = (account && account.name) || 'The account';
    if (!spec) return { ok: false, message: `${name} has no way to test its key.` };
    let parsed = null;
    try { parsed = typeof key === 'string' ? JSON.parse(key) : key; } catch { parsed = null; }
    if (!parsed || !parsed.client_email) return { ok: false, message: `${name} needs the service account's JSON key, pasted whole.` };
    const project = parts.project || parsed.project_id || '';
    const region = parts.region || '';
    if (!project) return { ok: false, message: `${name} needs the Google Cloud project id before the key can be tested.` };
    if (!region) return { ok: false, message: `${name} needs the region before the key can be tested.` };
    const token = await googleAccessToken({ serviceAccount: parsed, fetchImpl });
    if (!token.ok) return { ok: false, message: token.message };
    const url = fillUrl(spec.url, Object.assign({}, parts, { project, region }));
    const r = await probe(fetchImpl, url, { headers: { Authorization: `Bearer ${token.token}` } });
    if (r.status >= 200 && r.status < 300) {
        const items = listOf(r.json, spec.list_path || spec.list || 'models');
        if (items == null) return { ok: false, message: `${name} answered without a model list.` };
        const noun = items === 1 ? String(spec.list).replace(/s$/, '') : spec.list;
        return { ok: true, message: `${name} accepted the service account and lists ${items} ${noun} in ${region}.` };
    }
    return { ok: false, message: refused(name, r) };
}

/**
 * The test route. `resolve(namespace, key)` answers { value, source } (or null when the namespace/key has no test),
 * `tests[namespace](key, value, ctx)` runs the check. Mounted next to adminRoutes, behind the same guard.
 */
function testRoute({ guard, basePath = '/internal/config', resolve, run, log = console, now = () => Date.now() }) {
    const re = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/([^/]+)/test/([^/]+)$`);
    return function handle(req, res, next) {
        if (String(req.method || '').toUpperCase() !== 'POST') return next();
        const m = re.exec(String(req.path || req.url || '').split('?')[0]);
        if (!m) return next();
        guard(req, res, async (err) => {
            if (err) return next(err);
            let namespace = m[1];
            let key = m[2];
            try { namespace = decodeURIComponent(namespace); key = decodeURIComponent(key); } catch { /* keep them as they are */ }
            const found = await Promise.resolve(resolve(namespace, key)).catch(() => null);
            if (!found) return res.status(404).json({ type: 'about:blank', status: 404, code: 'config.test_not_found', detail: `${namespace} has no test for ${key}` });
            const tested_at = new Date(now()).toISOString();
            const base = { namespace, key, source: found.source || null, tested_at };
            // As openvibe-shared 4.125.0's hook: nothing to test is 409 config.not_set (neither entered nor in the settings file).
            if (!found.value) return res.status(409).type('application/problem+json').json({ type: 'about:blank', status: 409, code: 'config.not_set', detail: `${key} is not set, so there is nothing to test` });
            let out;
            try { out = await run(namespace, key, found.value, found); } catch (e) { out = { ok: false, message: `The test could not run: ${(e && e.message) || 'unknown error'}` }; }
            const ok = Boolean(out && out.ok);
            const from = found.source === 'env' && found.env ? ` (the value from the server's settings file, ${found.env})` : '';
            const message = oneLine(`${(out && out.message) || (ok ? 'It works.' : 'It did not work.')}${from}`, [found.value, ...(found.secrets || [])]);
            (log.info || log.log).call(log, `[config] test ${namespace} ${key}: ${ok ? 'connected' : 'not working'}`);
            return res.json({ ...base, ok, state: ok ? 'connected' : 'not_working', message });
        });
    };
}

module.exports = {
    SETUP_GROUPS, KEY_HOW, keyPage, oneLine, probe, testProviderKey, testGpuKey, testHostKey, testAccountKey,
    testRoute, hostRow, accountRow, fillUrl, listOf, HOST_ROWS,
};
