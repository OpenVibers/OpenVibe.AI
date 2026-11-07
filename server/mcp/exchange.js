'use strict';
/**
 * The OpenVibe.Exchange MCP server (design EXCHANGE-REMAKE-2026-11-06, "For builders", item 7): the tools an MCP
 * client (Claude Desktop, Cursor, an agent) uses to pick a model and run a completion on the person's own account.
 *
 * It speaks MCP over stdio in bin/openvibe-exchange-mcp.js and calls the public Exchange API with the person's
 * Network token (OPENVIBE_EXCHANGE_TOKEN, sent as a Bearer, never printed or logged):
 *
 *   exchange_models  GET /api/v1/exchange/catalog -- the live catalog: price in/out, measured p50/p95, uptime
 *   exchange_chat    POST /v1/chat/completions -- the person's allowance, or their own stored provider key when the
 *                    request names a provider (x-openvibe-credential), exactly as the SDK's buyer side does
 *   exchange_usage   GET /api/v1/exchange/me/usage -- the person's own requests, tokens and spend by day and model
 *
 * The server never stores a key, a prompt or an answer, and it does not answer a tool call without a token: a
 * missing token is refused before any request, and a 401 from the Exchange is refused back as the tool's error.
 */
const pkg = require('../../package.json');

const MCP_PROTOCOL = '2024-11-05';
const DEFAULT_BASE = 'https://api.openvibe.exchange';
const DEFAULT_TIMEOUT_MS = 30000;
const CHAT_TIMEOUT_MS = 180000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_CONTENT = 200000;

class McpError extends Error {
    constructor(message, code = 'exchange.error') { super(message); this.name = 'McpError'; this.code = code; }
}

const text = (s) => String(s == null ? '' : s);

/** The error the Exchange answered, without ever echoing the token. */
function apiError(status, body) {
    const detail = body && (body.detail || (body.error && body.error.message) || body.title);
    if (status === 401) return new McpError('the Exchange refused the token (401): make a new Network developer key and set OPENVIBE_EXCHANGE_TOKEN', 'auth.refused');
    if (status === 403) return new McpError(`the Exchange refused this token (403${detail ? `: ${text(detail)}` : ''})`, 'auth.refused');
    return new McpError(`the Exchange answered HTTP ${status}${detail ? `: ${text(detail)}` : ''}`, 'exchange.error');
}

/** The tools, with the JSON schemas an MCP client shows. */
const TOOLS = [
    {
        name: 'exchange_models',
        description: 'List the models OpenVibe.Exchange can run right now, with the live price (USD per million tokens, in and out), measured p50/p95 latency in ms, uptime (0-1), health and the provider data policy. Optional query and kind (chat, embedding, stt, image) filter the list. Public: no token is needed for this read.',
        inputSchema: {
            type: 'object', properties: {
                query: { type: 'string', description: 'Only models whose slug, name or family contains this text' },
                kind: { type: 'string', enum: ['chat', 'embedding', 'stt', 'image'], description: 'Only models of this kind' },
                limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many models to return (default 25)' },
            },
        },
    },
    {
        name: 'exchange_chat',
        description: "Run one chat completion on the person's OpenVibe.Exchange account: the person's daily free allowance or Balance, or their own stored provider key when `credential` names the provider. Returns the OpenAI-shaped answer and the receipt (x_openvibe). The prompt and the answer are not stored by the MCP server.",
        inputSchema: {
            type: 'object', required: ['model', 'messages'], properties: {
                model: { type: 'string', description: 'A model id (deepseek/deepseek-flash), openvibe/auto, or @preset/<name>' },
                messages: {
                    type: 'array', minItems: 1, maxItems: MAX_MESSAGES,
                    items: { type: 'object', required: ['role', 'content'], properties: {
                        role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
                        content: { type: 'string' },
                    } },
                },
                max_tokens: { type: 'integer', minimum: 1, maximum: 32768, description: 'Default 512' },
                temperature: { type: 'number', minimum: 0, maximum: 2 },
                credential: { type: 'string', description: "A provider whose key the person stored on OpenVibe (for example deepseek), instead of the router's own capacity" },
            },
        },
    },
    {
        name: 'exchange_usage',
        description: "Read the person's own Exchange usage for the last N days (or a date window): requests, tokens and spend by day, model and workflow. Never anyone else's usage.",
        inputSchema: {
            type: 'object', properties: {
                days: { type: 'integer', minimum: 1, maximum: 366, description: 'Look back this many days (default 30); ignored with from/to' },
                from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day, YYYY-MM-DD' },
                to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day, YYYY-MM-DD' },
            },
        },
    },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function createExchangeMcp({ token = null, baseUrl = DEFAULT_BASE, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, version = pkg.version } = {}) {
    const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const authToken = token == null ? '' : String(token);

    async function publicCatalog({ kind = null } = {}) {
        const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
        const headers = { Accept: 'application/json' };
        if (authToken) headers.Authorization = `Bearer ${authToken}`;
        let res;
        try { res = await fetchImpl(`${base}/api/v1/exchange/catalog${q}`, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
        catch (err) { throw new McpError(`the Exchange could not be reached: ${String((err && err.message) || err).slice(0, 200)}`, 'exchange.unreachable'); }
        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        if (!res.ok) throw apiError(res.status, data);
        return data;
    }

    function compactModels(catalog, { query = null, limit = 25 } = {}) {
        const q = query == null ? '' : String(query).trim().toLowerCase();
        let models = Array.isArray(catalog && catalog.models) ? catalog.models : [];
        if (q) models = models.filter((m) => [m.slug, m.name, m.family, m.canonical].some((v) => String(v || '').toLowerCase().includes(q)));
        const n = Math.max(1, Math.min(200, Number(limit) || 25));
        return {
            generated_at: catalog && catalog.generated_at ? catalog.generated_at : null,
            window_days: catalog && catalog.window_days != null ? catalog.window_days : null,
            count: models.length,
            free_available: Boolean(catalog && catalog.free_available),
            models: models.slice(0, n).map((m) => ({
                slug: m.slug, name: m.name, family: m.family, kind: m.kind, uncensored: Boolean(m.uncensored),
                context: m.context == null ? null : m.context, free_now: Boolean(m.free_now),
                offers: (Array.isArray(m.offers) ? m.offers : []).map((o) => ({
                    provider: o.provider, model: o.model, status: o.status, trust: o.trust,
                    price: o.price ? { in: o.price.in, out: o.price.out, cached: o.price.cached, per: o.price.per } : null,
                    speed: o.speed ? { p50_ms: o.speed.p50_ms, p95_ms: o.speed.p95_ms } : null,
                    uptime: o.uptime == null ? null : o.uptime,
                    requests_7d: o.requests_7d == null ? null : o.requests_7d,
                    free_tier: Boolean(o.free_tier), privacy: o.privacy || null,
                })),
            })),
        };
    }

    function checkChat(args) {
        const a = args && typeof args === 'object' ? args : {};
        const model = text(a.model).trim();
        if (!model) throw new McpError('exchange_chat needs a model', 'input.invalid');
        if (!Array.isArray(a.messages) || !a.messages.length || a.messages.length > MAX_MESSAGES) {
            throw new McpError(`exchange_chat needs 1 to ${MAX_MESSAGES} messages`, 'input.invalid');
        }
        const messages = a.messages.map((m) => {
            if (!m || typeof m !== 'object') throw new McpError('each message is {role, content}', 'input.invalid');
            const role = text(m.role);
            if (!['system', 'user', 'assistant', 'tool'].includes(role)) throw new McpError('a message role is system, user, assistant or tool', 'input.invalid');
            return { role, content: text(m.content).slice(0, MAX_CONTENT) };
        });
        const body = { model, messages, stream: false };
        if (a.max_tokens != null) {
            const n = Number(a.max_tokens);
            if (!Number.isInteger(n) || n < 1 || n > 32768) throw new McpError('max_tokens is an integer from 1 to 32768', 'input.invalid');
            body.max_tokens = n;
        }
        if (a.temperature != null) {
            const t = Number(a.temperature);
            if (!Number.isFinite(t) || t < 0 || t > 2) throw new McpError('temperature is a number from 0 to 2', 'input.invalid');
            body.temperature = t;
        }
        return { body, credential: a.credential == null ? null : text(a.credential).trim().slice(0, 64) };
    }

    async function runTool(name, args) {
        if (name === 'exchange_models') {
            const a = args && typeof args === 'object' ? args : {};
            const kind = a.kind == null ? null : text(a.kind);
            if (kind && !['chat', 'embedding', 'stt', 'image'].includes(kind)) throw new McpError('kind is chat, embedding, stt or image', 'input.invalid');
            const catalog = await publicCatalog({ kind });
            return compactModels(catalog, { query: a.query, limit: a.limit });
        }
        if (name === 'exchange_chat') {
            const { body, credential } = checkChat(args);
            const headers = {};
            if (credential) headers['x-openvibe-credential'] = credential;
            return await call('/v1/chat/completions', { method: 'POST', body, headers, timeout: CHAT_TIMEOUT_MS });
        }
        if (name === 'exchange_usage') {
            const a = args && typeof args === 'object' ? args : {};
            const params = new URLSearchParams();
            if (a.from || a.to) {
                for (const k of ['from', 'to']) {
                    if (a[k] == null) continue;
                    const v = text(a[k]).slice(0, 10);
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new McpError(`${k} is YYYY-MM-DD`, 'input.invalid');
                    params.set(k, v);
                }
            } else {
                const days = a.days == null ? 30 : Number(a.days);
                if (!Number.isInteger(days) || days < 1 || days > 366) throw new McpError('days is an integer from 1 to 366', 'input.invalid');
                params.set('days', String(days));
            }
            return await call(`/api/v1/exchange/me/usage?${params.toString()}`);
        }
        throw new McpError(`unknown tool ${name}`, 'tools.unknown');
    }

    /** The authenticated JSON call; extra headers carry the person's own provider key selector. */
    async function call(path, { method = 'GET', body = null, headers = {}, timeout = timeoutMs } = {}) {
        if (!authToken) throw new McpError('not signed in: set OPENVIBE_EXCHANGE_TOKEN to a Network developer key (the Exchange MCP server never runs without one)', 'auth.missing');
        const all = { Authorization: `Bearer ${authToken}`, Accept: 'application/json', ...headers };
        if (body != null) all['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, { method, headers: all, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        } catch (err) {
            throw new McpError(`the Exchange could not be reached: ${String((err && err.message) || err).slice(0, 200)}`, 'exchange.unreachable');
        }
        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        if (!res.ok) throw apiError(res.status, data);
        return data;
    }

    /** One JSON-RPC message -> the response object, or null for a notification. */
    async function handle(message) {
        const isObject = message && typeof message === 'object' && !Array.isArray(message);
        if (!isObject) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
        const id = message.id === undefined ? null : message.id;
        const method = text(message.method);
        const notification = message.id === undefined;
        const reply = (result) => (notification ? null : { jsonrpc: '2.0', id, result });
        const fail = (code, msg) => (notification ? null : { jsonrpc: '2.0', id, error: { code, message: msg } });
        if (method === 'initialize') {
            return reply({
                protocolVersion: MCP_PROTOCOL,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'openvibe-exchange', version },
                instructions: 'Tools for OpenVibe.Exchange: list live models and prices, run a chat completion on the signed-in person\'s allowance or their own provider key, and read their usage. Set OPENVIBE_EXCHANGE_TOKEN to a Network developer key.',
            });
        }
        if (!method || method.startsWith('notifications/')) return null;
        if (method === 'ping') return reply({});
        if (method === 'tools/list') return reply({ tools: TOOLS });
        if (method === 'tools/call') {
            const name = text(message.params && message.params.name);
            const args = (message.params && message.params.arguments) || {};
            if (!byName.has(name)) return reply({ content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true });
            try {
                const value = await runTool(name, args);
                return reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
            } catch (err) {
                const msg = err instanceof McpError ? err.message : `the tool failed: ${String((err && err.message) || err).slice(0, 300)}`;
                return reply({ content: [{ type: 'text', text: msg }], isError: true });
            }
        }
        return fail(-32601, `method not found: ${method}`);
    }

    return { handle, tools: TOOLS, baseUrl: base, hasToken: Boolean(authToken), _test: { compactModels, checkChat } };
}

module.exports = { createExchangeMcp, McpError, TOOLS, MCP_PROTOCOL };
