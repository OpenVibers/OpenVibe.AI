'use strict';
/**
 * Community endpoints (design EXCHANGE-REMAKE-2026-11-06, "Gap found while building the SDK"): a standalone
 * OpenAI-compatible server can sell to the Exchange, not only an OpenVibe Node machine. A seller registers its own
 * https address with their Network developer key on the public seller API (server/api/seller.js); AI stores the
 * offer here, reads it beside Network's Node offers, and reaches it through this module only.
 *
 * The egress guard, on every registration, every dispatch and every redirect hop:
 *   - https only, no credentials in the URL, no port but 443 or 8443;
 *   - never an IP literal, and never a name that can only mean this machine or a private network;
 *   - the DNS answer is judged inside the connection's own lookup (openvibe-shared/egress), so the socket connects
 *     to the checked address and a second answer cannot swap it (no rebinding); an address that is loopback,
 *     RFC 1918, link-local (169.254.169.254), CGNAT, documentation, benchmarking, multicast, or an IPv6 form that
 *     wraps one of those is refused;
 *   - redirects are followed by hand, at most two, by 307/308 only, and every hop is judged again;
 *   - a timeout and a response byte cap on every call;
 *   - the request is built fresh: the model, the conversation, the output limit and the tools. Never the buyer's
 *     subject, on_behalf_of, run id, key, cookies or forwarding headers.
 *
 * Trust is the Node machine's (server/community/index.js): the same canaries, the same model fingerprint, the same
 * ~1% spot re-runs, the free tier only until verified, and the self-dealing rule. An endpoint is a community source:
 * it sees the prompt, and only requests that opt in ever reach it.
 */
const net = require('net');
const https = require('https');
const { ids } = require('openvibe-contracts');
const egress = require('openvibe-shared/egress');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { AiError, parseJson } = require('../util');

const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ID = /^ep_[0-9A-HJKMNP-TV-Z]{26}$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const AUDIENCES = new Set(['everyone', 'followers', 'group']);
const MAX_MODELS = 40;
const MAX_MODEL = 200;
const MAX_PRICE = 1000000;
const MAX_MESSAGES = 200;
const MAX_CONTENT = 65536;
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_PORTS = new Set(['', '443', '8443']);

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE;
const roundPrice = (v) => Math.round(Number(v) * 1e6) / 1e6;

/**
 * The one URL rule. Returns a URL whose pathname has no trailing slash (an OpenAI base URL such as
 * https://host/v1), or throws AiError 422 `community.endpoint_url` with a message that never echoes the host.
 */
function judgeBaseUrl(raw) {
    let u;
    try { u = new URL(String(raw == null ? '' : raw)); } catch { throw new AiError(422, 'community.endpoint_url', 'base_url must be an https URL'); }
    if (u.protocol !== 'https:') throw new AiError(422, 'community.endpoint_url', 'base_url must be https');
    if (u.username || u.password) throw new AiError(422, 'community.endpoint_url', 'credentials in base_url are not allowed');
    if (u.search || u.hash) throw new AiError(422, 'community.endpoint_url', 'base_url carries no query or fragment');
    if (!ALLOWED_PORTS.has(u.port)) throw new AiError(422, 'community.endpoint_url', 'base_url must use port 443 or 8443');
    const host = egress.normalizeHost(u.hostname);
    // Node never calls the lookup hook for an IP literal, so the literal is the check (Actor #297).
    if (net.isIP(host)) throw new AiError(422, 'community.endpoint_url', 'base_url must name a host, not an IP address');
    if (egress.isInternalName(host)) throw new AiError(422, 'community.endpoint_url', 'base_url must be a public host name');
    u.hostname = host;
    u.pathname = u.pathname.replace(/\/+$/, '') || '';
    return u;
}

/** A conversation as the OpenAI Chat Completions body takes it: text only, the caps the machine path uses. */
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n') : '').slice(0, MAX_CONTENT);

/** Validate a registration body. → the stored fields; throws AiError 422 `community.endpoint_invalid`. */
function checkInput(input) {
    const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const allowed = new Set(['base_url', 'models', 'price', 'hours', 'concurrency', 'audience', 'group', 'name']);
    for (const k of Object.keys(b)) if (!allowed.has(k)) throw new AiError(422, 'community.endpoint_invalid', `unknown field ${k}`);
    const url = judgeBaseUrl(b.base_url);
    if (!Array.isArray(b.models) || b.models.length < 1 || b.models.length > MAX_MODELS) {
        throw new AiError(422, 'community.endpoint_invalid', `models must be an array of 1 to ${MAX_MODELS} model ids`);
    }
    const models = [...new Set(b.models.map((m) => String(m == null ? '' : m).trim()).filter(Boolean))];
    if (models.length !== b.models.length || models.some((m) => m.length > MAX_MODEL)) {
        throw new AiError(422, 'community.endpoint_invalid', `models must be unique strings of at most ${MAX_MODEL} characters`);
    }
    const h = b.hours && typeof b.hours === 'object' && !Array.isArray(b.hours) ? b.hours : {};
    if (!HHMM.test(String(h.start)) || !HHMM.test(String(h.end))) throw new AiError(422, 'community.endpoint_invalid', 'hours.start and hours.end are HH:MM');
    const tz = h.tz == null || h.tz === '' ? 'UTC' : String(h.tz);
    if (tz.length > 64) throw new AiError(422, 'community.endpoint_invalid', 'hours.tz is at most 64 characters');
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { throw new AiError(422, 'community.endpoint_invalid', 'hours.tz is not a known time zone'); }
    if (!Number.isInteger(b.concurrency) || b.concurrency < 1 || b.concurrency > 8) {
        throw new AiError(422, 'community.endpoint_invalid', 'concurrency must be an integer from 1 to 8');
    }
    let price;
    if (typeof b.price === 'number') price = { in_per_million: b.price, out_per_million: b.price };
    else if (b.price && typeof b.price === 'object' && !Array.isArray(b.price)) {
        const pin = b.price.in_per_million != null ? b.price.in_per_million : b.price.in;
        const pout = b.price.out_per_million != null ? b.price.out_per_million : b.price.out;
        price = { in_per_million: pin, out_per_million: pout };
    } else throw new AiError(422, 'community.endpoint_invalid', 'price is a number or {in_per_million, out_per_million}');
    if (!isPrice(price.in_per_million) || !isPrice(price.out_per_million)) {
        throw new AiError(422, 'community.endpoint_invalid', `price must be 0 to ${MAX_PRICE} credits per million tokens`);
    }
    const audience = b.audience == null ? 'everyone' : String(b.audience);
    if (!AUDIENCES.has(audience)) throw new AiError(422, 'community.endpoint_invalid', 'audience must be everyone, followers or group');
    let group = null;
    if (audience === 'group') {
        group = String(b.group == null ? '' : b.group).trim();
        if (!group || group.length > 80) throw new AiError(422, 'community.endpoint_invalid', 'audience group needs a group id of 1 to 80 characters');
    }
    const name = b.name == null ? null : String(b.name).trim();
    if (name && name.length > 100) throw new AiError(422, 'community.endpoint_invalid', 'name is at most 100 characters');
    return {
        base_url: url.toString().replace(/\/+$/, ''), models,
        hours: { start: String(h.start), end: String(h.end), tz },
        concurrency: b.concurrency, price: { in_per_million: roundPrice(price.in_per_million), out_per_million: roundPrice(price.out_per_million) },
        audience, group, name: name || null,
    };
}

/** A jsonb column as its value: the driver may hand back the parsed object or its text. */
const jsonOf = (v, fallback) => (v && typeof v === 'object' ? v : parseJson(v, fallback));

/** The seller's own view of an offer (never a token: this API has none). */
function viewOf(row) {
    if (!row) return null;
    const models = jsonOf(row.models, []);
    const hours = jsonOf(row.hours, {});
    return {
        id: row.id, offer_id: `endpoint:${row.id}`, name: row.name || null, base_url: row.base_url,
        models: Array.isArray(models) ? models : [], hours: hours && typeof hours === 'object' ? hours : {},
        concurrency: Number(row.concurrency),
        price: { in_per_million: roundPrice(row.price_in), out_per_million: roundPrice(row.price_out) },
        audience: row.audience, group: row.group_id || null,
        created_at: row.created_at, updated_at: row.updated_at,
    };
}

/** The offer the community router places on: the shape a Network doc normalizes to, plus its kind and address. */
function offerOf(row) {
    const view = viewOf(row);
    return {
        offer_id: view.offer_id, machine_id: `endpoint:${row.id}`, owner: row.owner_subject, kind: 'endpoint',
        endpoint: { id: row.id, base_url: row.base_url }, projectId: row.project_id || null,
        models: view.models, hours: view.hours, concurrency: view.concurrency, price: view.price,
        audience: view.audience, group: view.group, ready: true, health: 'up', name: view.name,
    };
}

function createEndpointOffers({ db, config, env = process.env, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, tokens = null, lookup = null, transport = null }) {
    const cfg = (config && config.community && config.community.endpoints) || {};
    const network = String((config && config.networkInternalUrl) || '').replace(/\/+$/, '');
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const clientId = (config && config.console && config.console.clientId) || env.OV_OAUTH_CLIENT_ID || 'ai';
    let projectTokens = tokens;
    if (!projectTokens && secret && network) {
        projectTokens = createServiceTokenClient({ tokenUrl: `${network}/oauth/token`, clientId, clientSecret: secret, scope: { 'openvibe.network': 'network.project.read' }, fetch: fetchImpl });
    }
    const maxPerOwner = Math.max(1, Math.min(100, Number(cfg.maxPerOwner) || 20));
    const timeoutMs = Math.max(5000, Math.min(120000, Number(cfg.timeoutMs) || 60000));
    const maxBytes = Math.max(65536, Math.min(16 * 1024 * 1024, Number(cfg.maxBytes) || MAX_BYTES));
    const maxRedirects = Math.max(0, Math.min(3, cfg.maxRedirects == null ? 2 : Number(cfg.maxRedirects)));
    const safeLookup = egress.createSafeLookup({ ...(lookup ? { lookup } : {}) });

    const active = new Map();          // offer id -> calls in flight
    const owners = new Map();         // project id -> { at, owner } (5 minutes)
    const nowIso = () => new Date(clock.now()).toISOString();

    /** The person a seller acts for. A person's own token is themselves; an app's project owner comes from Network. */
    async function ownerFor(principal) {
        if (!principal) throw new AiError(401, 'token.missing', 'a seller is a person or a developer app');
        if (principal.kind === 'user') {
            const id = principal.subject && principal.subject.id;
            if (!USR.test(String(id))) throw new AiError(422, 'community.endpoint_owner', 'the person has no subject');
            return { owner: String(id), projectId: null, appId: null };
        }
        if (principal.kind === 'app') {
            const projectId = String(principal.projectId || '');
            if (!PROJECT.test(projectId)) throw new AiError(422, 'community.endpoint_owner', 'the app has no project');
            const hit = owners.get(projectId);
            if (hit && clock.now() - hit.at < 300000 && hit.owner) return { owner: hit.owner, projectId, appId: principal.appId || null };
            if (!projectTokens || !network) throw new AiError(503, 'community.unavailable', 'the seller API cannot read project owners here');
            let res;
            try {
                const token = await projectTokens.getToken({ audience: 'openvibe.network' });
                res = await fetchImpl(`${network}/internal/projects/${encodeURIComponent(projectId)}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
                });
            } catch (err) {
                throw new AiError(503, 'community.unavailable', `Network did not answer for the project: ${String(err && err.message || err).slice(0, 200)}`);
            }
            if (res.status === 404) throw new AiError(403, 'community.endpoint_owner', 'the developer app has no project');
            if (!res.ok) throw new AiError(503, 'community.unavailable', `Network answered ${res.status} for the project`);
            const body = await res.json().catch(() => null);
            const owner = body && body.project && body.project.owner && body.project.owner.id;
            if (!USR.test(String(owner))) throw new AiError(503, 'community.unavailable', 'the project has no owner');
            owners.set(projectId, { at: clock.now(), owner: String(owner) });
            return { owner: String(owner), projectId, appId: principal.appId || null };
        }
        throw new AiError(403, 'community.endpoint_owner', 'a seller is a person or a developer app, not a service');
    }

    const rows = () => db.prepare('SELECT * FROM community_endpoint_offers ORDER BY created_at DESC');

    /** Every registered endpoint as a community offer, for the router's offer list. */
    async function liveOffers() {
        if (!db) return [];
        const list = await rows().all();
        return list.map(offerOf);
    }

    async function list(owner) {
        if (!USR.test(String(owner))) throw new AiError(422, 'community.endpoint_owner', 'owner must be a usr_ subject');
        return (await rows().all()).filter((r) => r.owner_subject === owner).map(viewOf);
    }

    async function create({ owner, projectId = null, appId = null, createdBy = null, input }) {
        if (!USR.test(String(owner))) throw new AiError(422, 'community.endpoint_owner', 'owner must be a usr_ subject');
        const checked = checkInput(input);
        const existing = (await rows().all()).filter((r) => r.owner_subject === owner);
        if (existing.length >= maxPerOwner) throw new AiError(409, 'community.endpoint_limit', `at most ${maxPerOwner} endpoint offers per seller`);
        const at = nowIso();
        const row = {
            id: `ep_${ids.ulid()}`, owner, projectId, appId, createdBy: createdBy || (appId || owner), checked, at,
        };
        await db.prepare(`INSERT INTO community_endpoint_offers (id, owner_subject, project_id, app_id, created_by, name, base_url, models, hours,
            concurrency, price_in, price_out, audience, group_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, owner, projectId, appId, row.createdBy, checked.name, checked.base_url, JSON.stringify(checked.models), JSON.stringify(checked.hours),
                checked.concurrency, checked.price.in_per_million, checked.price.out_per_million, checked.audience, checked.group, at, at);
        return viewOf(await db.prepare('SELECT * FROM community_endpoint_offers WHERE id = ?').get(row.id));
    }

    /** Remove an offer. Its verification and ledger rows stay: they are history and earnings, not the live offer. */
    async function remove({ id, owner }) {
        if (!ID.test(String(id))) throw new AiError(404, 'community.endpoint_not_found', `no endpoint offer ${id}`);
        if (!USR.test(String(owner))) throw new AiError(422, 'community.endpoint_owner', 'owner must be a usr_ subject');
        const found = await db.prepare('SELECT id FROM community_endpoint_offers WHERE id = ? AND owner_subject = ?').get(String(id), String(owner));
        if (!found) throw new AiError(404, 'community.endpoint_not_found', `no endpoint offer ${id}`);
        await db.prepare('DELETE FROM community_endpoint_offers WHERE id = ?').run(String(id));
        return { id: String(id), removed: true };
    }

    /** A registration of the seller's own, by id (the verify route uses it). */
    async function own({ id, owner }) {
        if (!ID.test(String(id))) return null;
        const row = await db.prepare('SELECT * FROM community_endpoint_offers WHERE id = ? AND owner_subject = ?').get(String(id), String(owner));
        return row ? offerOf(row) : null;
    }

    /** One response, without following anything: the transport seam tests script (redirect chains included). */
    function once(target, { body, timeoutMs: callTimeout, signal }) {
        const send = {
            method: 'POST',
            url: target.toString(),
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'OpenVibe.AI/0.1 (+https://ai.openvibe.services)',
                'Content-Length': Buffer.byteLength(body),
            },
            body, lookup: safeLookup, timeoutMs: callTimeout, maxBytes,
        };
        if (transport) return transport(send);
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (err) => { if (settled) return; settled = true; try { req.destroy(); } catch { /* */ } reject(err); };
            const ok = (value) => { if (settled) return; settled = true; resolve(value); };
            const req = https.request(target, {
                method: 'POST', headers: send.headers, lookup: safeLookup, timeout: callTimeout, agent: false,
            }, (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400) { res.resume(); return ok({ status, headers: res.headers, body: '' }); }
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); return fail(new AiError(413, 'community.endpoint_too_large', `the endpoint answered more than ${maxBytes} bytes`)); }
                let bytes = 0;
                const chunks = [];
                res.on('data', (c) => {
                    bytes += c.length;
                    if (bytes > maxBytes) { res.destroy(); return fail(new AiError(413, 'community.endpoint_too_large', `the endpoint answered more than ${maxBytes} bytes`)); }
                    chunks.push(c);
                });
                res.on('error', (err) => fail(new AiError(502, 'community.endpoint_unavailable', `the endpoint's answer failed: ${String(err && err.message || err).slice(0, 200)}`)));
                res.on('end', () => ok({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('error', (err) => fail(new AiError(502, 'community.endpoint_unavailable', err && err.code === 'EGRESS_DENIED'
                ? 'the endpoint resolves to a non-public address'
                : `the endpoint could not be reached: ${String(err && err.message || err).slice(0, 200)}`)));
            req.on('timeout', () => fail(new AiError(504, 'community.endpoint_timeout', `the endpoint did not answer within ${callTimeout}ms`)));
            const timer = setTimeout(() => fail(new AiError(504, 'community.endpoint_timeout', `the endpoint did not answer within ${callTimeout}ms`)), callTimeout);
            if (signal) {
                const onAbort = () => fail(new AiError(409, 'run.cancelled', 'cancelled'));
                if (signal.aborted) return onAbort();
                signal.addEventListener('abort', onAbort, { once: true });
                req.on('close', () => signal.removeEventListener('abort', onAbort));
            }
            req.on('close', () => clearTimeout(timer));
            req.end(body);
        });
    }

    /** POST one chat completion, redirects judged hop by hop. → { status, headers, body } */
    async function send(rawUrl, body, { timeoutMs: callTimeout = timeoutMs, signal = null } = {}) {
        let target = judgeBaseUrl(rawUrl);
        for (let hop = 0; hop <= maxRedirects; hop++) {
            const res = await once(target, { body, timeoutMs: callTimeout, signal });
            if (res.status < 300 || res.status >= 400) return res;
            const location = res.headers && res.headers.location;
            if (!location) throw new AiError(502, 'community.endpoint_redirect', 'the endpoint redirected without a location');
            if (![307, 308].includes(res.status)) throw new AiError(502, 'community.endpoint_redirect', `the endpoint answered ${res.status} to a POST; only 307 and 308 are followed`);
            let next;
            try { next = judgeBaseUrl(new URL(String(location), target).toString()); } catch (err) {
                throw new AiError(502, 'community.endpoint_redirect', 'the endpoint redirected to an address that is not allowed');
            }
            if (hop === maxRedirects) throw new AiError(502, 'community.endpoint_redirect', 'the endpoint redirected too many times');
            target = next;
        }
        throw new AiError(502, 'community.endpoint_redirect', 'the endpoint redirected too many times');
    }

    /** The answer in the shape server/community/index.js reads from a machine. */
    function parseAnswer(text) {
        let data;
        try { data = JSON.parse(text || ''); } catch { throw new AiError(502, 'community.endpoint_response', 'the endpoint did not answer JSON'); }
        const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
        const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : null;
        if (!message) throw new AiError(502, 'community.endpoint_response', 'the endpoint did not answer a chat completion');
        const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
            ? message.content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('') : '';
        const answer = { role: 'assistant', content: content.slice(0, MAX_CONTENT) };
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
            answer.tool_calls = message.tool_calls.slice(0, 32).filter((c) => c && c.function && typeof c.function.name === 'string')
                .map((c, i) => ({ id: String(c.id || `call_${i + 1}`).slice(0, 200), type: 'function',
                    function: { name: String(c.function.name).slice(0, 64), arguments: typeof c.function.arguments === 'string' ? c.function.arguments.slice(0, MAX_CONTENT) : JSON.stringify(c.function.arguments || {}) } }));
            if (!answer.tool_calls.length) delete answer.tool_calls;
        }
        const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
        return {
            text: answer.content, message: answer,
            model: typeof data.model === 'string' ? data.model : null,
            usage: { input: Math.max(0, Math.trunc(Number(usage.prompt_tokens) || 0)), output: Math.max(0, Math.trunc(Number(usage.completion_tokens) || 0)), cached: 0 },
            finish: choice.finish_reason || (answer.tool_calls ? 'tool_calls' : 'stop'),
        };
    }

    /**
     * One chat completion on a seller's endpoint. The seller's declared concurrency is honoured here: over it, the
     * call is busy and the router falls back, rather than piling requests on the server.
     */
    async function chat(offer, { model, messages, maxTokens = 512, temperature = null, tools = null, timeoutMs: callTimeout = timeoutMs, signal = null } = {}) {
        const id = offer && offer.endpoint && offer.endpoint.id;
        if (!id) throw new AiError(502, 'community.endpoint_unavailable', 'not an endpoint offer');
        const cap = Math.max(1, Number(offer.concurrency) || 1);
        const inFlight = active.get(id) || 0;
        if (inFlight >= cap) throw new AiError(503, 'community.busy', 'the endpoint is at its concurrency limit');
        active.set(id, inFlight + 1);
        try {
            const list = (Array.isArray(messages) ? messages : []).slice(0, MAX_MESSAGES).map((m) => {
                const one = { role: ['system', 'user', 'assistant', 'tool'].includes(m && m.role) ? m.role : 'user', content: textOf(m && m.content) };
                if (one.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) one.tool_calls = m.tool_calls.slice(0, 32);
                if (one.role === 'tool' && m.tool_call_id) one.tool_call_id = String(m.tool_call_id).slice(0, 200);
                return one;
            });
            const request = { model: String(model || ''), messages: list, max_tokens: Math.max(1, Math.min(Number(maxTokens) || 512, 32768)), stream: false };
            if (temperature != null && Number.isFinite(Number(temperature))) request.temperature = Number(temperature);
            if (Array.isArray(tools) && tools.length) { request.tools = tools; request.tool_choice = 'auto'; }
            const res = await send(`${offer.endpoint.base_url}/chat/completions`, JSON.stringify(request), { timeoutMs: callTimeout, signal });
            if (res.status !== 200) throw new AiError(502, 'community.endpoint_unavailable', `the endpoint answered HTTP ${res.status}`);
            return parseAnswer(res.body);
        } finally {
            const left = (active.get(id) || 1) - 1;
            if (left <= 0) active.delete(id); else active.set(id, left);
        }
    }

    return { enabled: Boolean(db), liveOffers, list, create, remove, ownerFor, chat, judgeBaseUrl };
}

module.exports = { createEndpointOffers, judgeBaseUrl };
