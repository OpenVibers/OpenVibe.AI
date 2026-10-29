'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.AI's run API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path under /api/v1. server/app.js mounts
 * exactly these routers, and test/openapi.test.js walks the mounted stack and fails when the table
 * and the app differ in either direction — so the document cannot advertise an address this service
 * does not answer.
 *
 *   GET /openapi.json            this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json     308 to /openapi.json
 *
 * /api/health and /api/ready are probes. The operator/admin API and the attribution-quota API are
 * internal (staff/service tokens): they stay out. Credentials are deliberately not documented at all
 * — no credential, provider secret or secret reference field appears in this document. The
 * OpenAI-compatible /v1/chat/completions and /v1/models are outside /api and stay out of it too.
 *
 * Request fields are what server/api/runs.js and server/api/actions.js read; the run properties are
 * server/runs.js decode(). Nothing is inferred.
 */
const pkg = require('../package.json');

const MOUNT = '/api/v1';
const SITE = 'https://openvibe.ai';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });
const integer = (extra = {}) => ({ type: 'integer', ...extra });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: { type: str(), title: str(), status: integer(), code: str(), detail: str(), request_id: str() },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 409, 413, 422, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const SERVICE = [{ bearer: [] }];
const SERVICE_OR_APP = [{ bearer: [] }, { app: [] }];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const runBody = (required = []) => ({
    type: 'object', ...(required.length ? { required } : {}),
    properties: {
        workflow: str({ description: 'The workflow key, e.g. ai.generate' }), version: integer({ minimum: 1 }),
        input: { type: 'object' }, idempotency_key: str({ minLength: 8, maxLength: 128 }),
        target: { type: 'object' }, attribution: { type: 'object' }, on_behalf_of: ref('SubjectRef'),
        options: { type: 'object' }, route: { type: 'object', description: '{ provider, model } — one offer from GET /api/v1/routes?operation=…' },
    },
});
const directBody = {
    type: 'object',
    properties: {
        idempotency_key: str({ minLength: 8, maxLength: 128 }), target: { type: 'object' }, attribution: { type: 'object' },
        on_behalf_of: ref('SubjectRef'), options: { type: 'object' },
    },
};

const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────
route('post', '/runs', {
    operationId: 'createRun', summary: 'Start a workflow run (201 finished, 202 queued or running, 200 replay)', tags: ['runs'], security: SERVICE,
    description: 'ai.run.create. ?wait=ms waits for the result (bounded by the service maximum); ?stream=1 answers text/event-stream (delta { text } as the answer is written, then run { run }, or error { code, message }). A 202 carries Location: /api/v1/runs/{id}.',
    parameters: [query('wait', integer({ minimum: 0 }), 'Milliseconds to wait for the result'), query('stream', { type: 'string', enum: ['1'] }, 'Answer server-sent events')],
    requestBody: body(runBody(['workflow'])),
    responses: {
        201: json('Finished (or served from the cache)', ref('RunResponse')),
        202: { description: 'Still queued or running', headers: { Location: { schema: { type: 'string' } } }, content: { 'application/json': { schema: ref('RunResponse') } } },
        200: json('An idempotent replay of an earlier run', ref('RunResponse')),
        429: { ...problem, headers: { 'Retry-After': { schema: { type: 'integer' } } } },
        ...errors([400, 401, 403, 404, 409, 413, 422, 503]),
    },
});
route('get', '/runs', {
    operationId: 'listRuns', summary: 'The caller\'s runs, newest first', tags: ['runs'], security: SERVICE,
    description: 'ai.run.read (or ai.run.create). `all=1` needs ai.usage.read.',
    parameters: [
        query('status', str()), query('workflow', str()), query('target', str()), query('limit', integer({ minimum: 1 })),
        query('before', str(), 'The next page cursor'), query('all', { type: 'string', enum: ['1'] }, 'Every caller\'s runs (ai.usage.read)'),
    ],
    responses: { 200: json('Runs', { type: 'object', required: ['runs'], properties: { runs: arrayOf(ref('Run')) } }), ...errors([400, 401, 403, 429]) },
});
route('get', '/runs/{id}', {
    operationId: 'getRun', summary: 'One run with its citations and request log', tags: ['runs'], security: SERVICE_OR_APP,
    description: 'ai.run.read (or ai.run.create; an app token needs ai.app.run). Another caller\'s run answers 404.',
    parameters: [path('id', str())],
    responses: { 200: json('The run', { type: 'object', required: ['run'], properties: {
        run: ref('Run'), citations: arrayOf(ref('Citation')), requests: arrayOf(ref('RunRequest')),
    } }), ...errors([401, 403, 404, 429]) },
});
route('post', '/runs/{id}/cancel', {
    operationId: 'cancelRun', summary: 'Cancel a queued or running run (owner)', tags: ['runs'], security: SERVICE,
    description: 'ai.run.create.',
    parameters: [path('id', str())],
    responses: { 200: json('The run', { type: 'object', required: ['run'], properties: { run: ref('Run') } }), ...errors([401, 403, 404, 409, 429]) },
});
route('post', '/runs/{id}/retry', {
    operationId: 'retryRun', summary: 'Retry a failed run as a new run (owner)', tags: ['runs'], security: SERVICE,
    description: 'ai.run.create. The new run carries retry_of.',
    parameters: [path('id', str()), query('wait', integer({ minimum: 0 }))],
    responses: { 201: json('The new run', { type: 'object', required: ['run'], properties: { run: ref('Run') } }),
        202: json('Still running', { type: 'object', required: ['run'], properties: { run: ref('Run') } }), ...errors([401, 403, 404, 409, 429]) },
});
route('get', '/runs/{id}/citations', {
    operationId: 'listRunCitations', summary: 'A run\'s citations', tags: ['runs'], security: SERVICE,
    description: 'ai.run.read.',
    parameters: [path('id', str())],
    responses: { 200: json('Citations', { type: 'object', required: ['citations'], properties: { citations: arrayOf(ref('Citation')) } }), ...errors([401, 403, 404, 429]) },
});
route('post', '/runs/{id}/citations', {
    operationId: 'attachRunCitations', summary: 'Attach sources or citations to a finished run (owner)', tags: ['runs'], security: SERVICE,
    description: 'ai.run.create. 1 to 50 items; every item needs a source_type.',
    parameters: [path('id', str())],
    requestBody: body({ type: 'object', required: ['citations'], properties: { citations: { type: 'array', minItems: 1, maxItems: 50, items: ref('CitationInput') } } }),
    responses: { 201: json('The run\'s citations', { type: 'object', required: ['citations'], properties: { citations: arrayOf(ref('Citation')) } }), ...errors([401, 403, 404, 422, 429]) },
});

// ── Direct operations ────────────────────────────────────────────────────────────────────────
for (const op of ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed', 'image']) {
    const appAllowed = op !== 'enrich' && op !== 'image';
    route('post', `/${op}`, {
        operationId: `${op}Run`, summary: `Run ai.${op} directly and wait for the answer`, tags: ['operations'],
        security: appAllowed ? SERVICE_OR_APP : SERVICE,
        description: `${appAllowed ? 'ai.run.create (or an app token with ai.app.run) for a run of workflow ai.${op}' : `ai.run.create for a first-party run of workflow ai.${op}`}. The operation's own input fields sit at the top level; workflow/version are not accepted here.`,
        parameters: [query('wait', integer({ minimum: 0 }), 'Milliseconds to wait; defaults to the service maximum')],
        requestBody: body(directBody),
        responses: {
            201: json('Finished', ref('RunResponse')),
            202: { description: 'Still running', headers: { Location: { schema: { type: 'string' } } }, content: { 'application/json': { schema: ref('RunResponse') } } },
            200: json('An idempotent replay', ref('RunResponse')),
            429: { ...problem, headers: { 'Retry-After': { schema: { type: 'integer' } } } },
            ...errors([400, 401, 403, 404, 409, 413, 422, 503]),
        },
    });
}
route('post', '/research', {
    operationId: 'research', summary: 'Gather research sources for a question (workflow research.gather)', tags: ['operations'], security: SERVICE_OR_APP,
    description: 'ai.run.create (or an app token with ai.app.run). An app\'s run leaves DeepSeek\'s paid web search out and reads only the free sources.',
    parameters: [query('wait', integer({ minimum: 0 }))],
    requestBody: body(directBody),
    responses: { 201: json('Finished', ref('RunResponse')), 202: json('Still running', ref('RunResponse')), 200: json('Replay', ref('RunResponse')), ...errors() },
});

// ── Action Center ────────────────────────────────────────────────────────────────────────────
route('get', '/actions', {
    operationId: 'listActions', summary: 'The Action Center items for one person', tags: ['actions'], security: SERVICE,
    description: 'ai.actions.read: a service token names one usr_ subject and gets only the runs whose on_behalf_of is that person — queued and running, then done and failed from the last 30 days, at most 50.',
    parameters: [query('subject', str({ pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }), 'Required')],
    responses: { 200: json('common.action-list-result@1', { type: 'object', required: ['items'], properties: { items: arrayOf(ref('ActionItem')) } }), ...errors([400, 401, 403, 429]) },
});

function openapi() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.AI API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.AI', email: 'contact@openvibe.network' },
        },
        servers: [{ url: SITE }],
        tags: ['runs', 'operations', 'actions'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network service or user token for audience openvibe.ai carrying the route\'s capability (ai.run.create, ai.run.read, ai.actions.read)' },
                app: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A developer app token with ai.app.run: it runs only its own app.<project_key>.* namespace and is metered as its project' },
            },
            schemas: {
                SubjectRef: { type: 'object', required: ['type', 'id'], properties: { type: str(), id: str() } },
                WorkflowRef: { type: 'object', required: ['key', 'version'], properties: { key: str(), version: integer() } },
                Run: { type: 'object', required: ['id', 'status', 'workflow'], properties: {
                    id: str(), status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
                    workflow: ref('WorkflowRef'), template: nullable('object'), route: nullable('object'),
                    requester: { type: 'object', properties: { type: str(), id: str() } }, on_behalf_of: nullable('object'), attribution: nullable('object'),
                    source_service: nullable('string'), target: nullable('object'), input: nullable('object'), output: nullable('object'),
                    error: nullable('object', { properties: { code: str(), detail: str() } }), synthetic: { type: 'boolean' },
                    provenance: { type: 'object' },
                    usage: { type: 'object', properties: { tokens_in: nullable('integer'), tokens_out: nullable('integer'), cost_usd: nullable('number'), attempts: nullable('integer'), usage_sample_ids: nullable(arrayOf(str())) } },
                    explain: nullable('object'), citations_count: nullable('integer'), grounding: nullable('object'),
                    retry_of: nullable('string'), idempotency_key: nullable('string'), trace_id: nullable('string'),
                    created_at: str({ format: 'date-time' }), started_at: nullable('string', { format: 'date-time' }), finished_at: nullable('string', { format: 'date-time' }),
                } },
                RunResponse: { type: 'object', required: ['run'], properties: { run: ref('Run'), replayed: { type: 'boolean' } } },
                RunRequest: { type: 'object', properties: {
                    id: str(), seq: integer(), operation: str(), provider_key: nullable('string'), model_key: nullable('string'),
                    route_key: nullable('string'), route_version: nullable('integer'), status: str(), skip_reason: nullable('string'),
                    fallback: { type: 'boolean' }, prompt_hash: nullable('string'), input_hash: nullable('string'), output_hash: nullable('string'),
                    tokens_in: nullable('integer'), tokens_out: nullable('integer'), tokens_cached: nullable('integer'), tokens_estimated: nullable('integer'),
                    cost_usd: nullable('number'), latency_ms: nullable('integer'), error: nullable('string'), created_at: str({ format: 'date-time' }),
                } },
                CitationInput: { type: 'object', required: ['source_type'], properties: {
                    source_type: str({ pattern: '^[a-z][a-z0-9_.-]{1,63}$' }), source_id: str(), url: str(), title: str(),
                    author: str(), snippet: str(), published_at: str(), retrieved_at: str(), provenance: { type: 'object' },
                }, additionalProperties: false },
                Citation: { type: 'object', properties: {
                    id: str(), run_id: str(), ordinal: integer(), source_type: str(), source_id: nullable('string'), url: nullable('string'),
                    title: nullable('string'), author: nullable('string'), published_at: nullable('string'), retrieved_at: nullable('string'),
                    snippet: nullable('string'), content_hash: nullable('string'), trust: { type: 'object' }, provenance: { type: 'object' },
                    attached_by: str(), created_at: str({ format: 'date-time' }),
                } },
                ActionItem: { type: 'object', required: ['service', 'id', 'kind', 'title', 'bucket', 'state'], properties: {
                    service: { const: 'ai' }, id: str(), kind: { const: 'ai_run' }, title: str(), summary: nullable('string'),
                    bucket: { type: 'string', enum: ['active', 'done', 'failed'] }, state: str(), agent: nullable('string'),
                    cost_usd: nullable('number'), steps: nullable('integer'), error: nullable('string'),
                    created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }), href: str(),
                    actions: arrayOf(str()),
                } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).sort(([a], [b]) => a.localeCompare(b)).map(([p, item]) => [MOUNT + p, item])) },
    };
}

/** The documented routes as "METHOD /api/v1/path": what the app must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${MOUNT}${p}`)).sort();
}

/** Serve GET /openapi.json here; GET /api/v1/openapi.json redirects to it (308). */
function mount(app, document = openapi()) {
    const send = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount, MOUNT };
