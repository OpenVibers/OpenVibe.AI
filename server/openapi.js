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
 * — no credential, provider secret or secret reference field appears in this document. The person's
 * own /api/v1/me/* routes (their provider keys, and the preferences that route them) are person-only
 * and carry a key on PUT, so they stay out for the same reason. The OpenAI-compatible
 * /v1/chat/completions and /v1/models are outside /api and stay out of it too.
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

// ── The apps a person allows to use their own key (L55 C3) ───────────────────────────────────
route('get', '/allowed-keys/{subject}', {
    operationId: 'allowedKeys', summary: 'Which providers this person allowed this service to use their own key for', tags: ['keys'], security: SERVICE,
    description: 'ai.run.create. The providers this person allowed THIS service to use their own key for, and that they hold a key for: names only, never key material. A person who allowed this service nothing gets 404, and nothing at all about their keys.',
    parameters: [path('subject', str({ pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }))],
    responses: { 200: json('The provider names', ref('AllowedKeys')), 404: problem, ...errors([401, 403]) },
});

// ── Memory (Memory M2a) ──────────────────────────────────────────────────────────────────────
const memoryItem = ref('MemoryItem');
const memoryBody = ref('MemoryWriteRequest');
const memoryResult = ref('MemoryResult');
const memorySecurity = SERVICE;   // the person's own token, or a service token plus on_behalf_of
route('post', '/memory/items:batch', {
    operationId: 'importMemoryItems', summary: 'Import up to 200 memory items', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.write. Redaction runs again on the server; an item that is only a secret is refused. Dedupe is by text_mac within owner and scope: the same text updates seen_at and adds the source. AI-produced items are suggestions until the person accepts them.',
    requestBody: body(memoryBody),
    responses: { 200: json('The stored (or deduped) items', memoryResult), 422: problem, 503: problem, ...errors([400, 401, 403]) },
});
route('get', '/memory/items', {
    operationId: 'listMemoryItems', summary: 'List the person’s own memory items', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.read. q searches decrypted text in-process over that owner’s rows only, capped at 2,000.',
    parameters: [query('scope', str()), query('status', str({ enum: ['active', 'suggested', 'archived', 'conflict'] })), query('q', str()), query('on_behalf_of', str())],
    responses: { 200: json('The person’s items', memoryResult), 403: problem, 503: problem, ...errors([401]) },
});
route('delete', '/memory/items', {
    operationId: 'deleteMemorySource', summary: 'Delete everything from one source', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.write. Delete means gone: the rows are removed and the profiles that used them are rebuilt.',
    parameters: [{ ...query('source', str(), 'The adapter id or service to delete'), required: true }, query('on_behalf_of', str())],
    responses: { 200: json('How many rows were removed', memoryResult), 422: problem, 503: problem, ...errors([401, 403]) },
});
route('get', '/memory/items/{id}', {
    operationId: 'getMemoryItem', summary: 'Read one memory item', tags: ['memory'], security: memorySecurity,
    parameters: [path('id', str()), query('on_behalf_of', str())],
    responses: { 200: json('The item', memoryResult), 404: problem, 503: problem, ...errors([401, 403]) },
});
route('patch', '/memory/items/{id}', {
    operationId: 'updateMemoryItem', summary: 'Change text, kind, scope or status', tags: ['memory'], security: memorySecurity,
    parameters: [path('id', str())],
    requestBody: body(memoryBody),
    responses: { 200: json('The changed item', memoryResult), 404: problem, 422: problem, 503: problem, ...errors([401, 403]) },
});
route('delete', '/memory/items/{id}', {
    operationId: 'deleteMemoryItem', summary: 'Delete one memory item', tags: ['memory'], security: memorySecurity,
    parameters: [path('id', str()), query('on_behalf_of', str())],
    responses: { 200: json('How many rows were removed', memoryResult), 404: problem, 503: problem, ...errors([401, 403]) },
});
route('post', '/memory/items/{id}/split', {
    operationId: 'splitMemoryItem', summary: 'Undo a merge: the item and the one it swallowed go apart again', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.write. The person’s own token only. An item that was merged into another one is restored with its own text and its own sources; the winner keeps only its own sources again.',
    parameters: [path('id', str())],
    responses: { 200: json('The items again', memoryResult), 404: problem, 409: problem, 503: problem, ...errors([401, 403]) },
});
route('post', '/memory/items/{id}/settle', {
    operationId: 'settleMemoryConflict', summary: 'Settle a conflict between two notes', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.write. The person’s own token only. keep names the item that stays (active again); the other one is archived. A conflict never reaches an agent until it is settled.',
    parameters: [path('id', str())],
    requestBody: body({ type: 'object', required: ['keep'], properties: { keep: str({ description: 'The id of the item that stays' }) } }),
    responses: { 200: json('The kept item and the archived one', memoryResult), 404: problem, 409: problem, 422: problem, 503: problem, ...errors([401, 403]) },
});
route('get', '/memory/profile', {
    operationId: 'getMemoryProfile', summary: 'The cached profile for one scope', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.read. The person\u2019s own profile, or an agent\u2019s: a service token with on_behalf_of reads only a scope its grant names, and that read is audited in memory_reads with the note ids it was built from, never the text. Rebuilt by the cheap tier only when items_hash changes, at most once an hour per owner and scope; the result is stored as written.',
    parameters: [query('scope', str()), query('on_behalf_of', str())],
    responses: { 200: json('The cached profile', memoryResult), 503: problem, ...errors([401, 403]) },
});
route('get', '/memory/reads', {
    operationId: 'listMemoryReads', summary: 'The person’s own read log', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.read. The person’s own token only: who read their memory, for what, in which scopes, how many notes and when. The answer never carries the note ids and never the text, only the count of what was read.',
    parameters: [query('limit', integer({ minimum: 1, maximum: 200 }), 'How many reads at most (50 by default)')],
    responses: { 200: json('The reads', memoryResult), 503: problem, ...errors([401, 403]) },
});
route('get', '/memory/search', {
    operationId: 'searchMemoryForAgent', summary: 'An agent reads active memory in its granted scopes', tags: ['memory'], security: memorySecurity,
    description: 'ai.memory.read plus on_behalf_of. Active items only, at most 8, in the scopes the token’s grant names (user always; project:* only when granted). The read is audited in memory_reads with item ids, never text.',
    parameters: [query('q', str()), query('scopes', str(), 'Comma-separated scopes; default user'), query('purpose', str(), 'The task or run the person sees'), query('on_behalf_of', str())],
    responses: { 200: json('At most 8 active items', memoryResult), 403: problem, 503: problem, ...errors([401]) },
});
// ── Memory M3: the guided cloud import (person token only) ─────────────────────────────────
route('get', '/memory/import/providers', {
    operationId: 'getMemoryImportProviders', summary: 'The walkthroughs and the extraction prompt for the cloud import', tags: ['memory'], security: memorySecurity,
    description: 'The person’s own token only. Where to request each export (ChatGPT, Claude, Gemini), what arrives, how long it takes, and the prompt to paste into any assistant. The answer contains no note.',
    responses: { 200: json('The providers and the prompt', { type: 'object', properties: { providers: arrayOf({ type: 'object' }), prompt: str() } }), 403: problem, 503: problem, ...errors([401]) },
});
route('post', '/memory/import/preview', {
    operationId: 'previewMemoryImport', summary: 'Parse and redact an export into a two-hour draft', tags: ['memory'], security: memorySecurity,
    description: 'The person’s own token only. Send a .zip export, one multipart form (the Codes page forwards it untouched), a text/plain paste, or JSON { provider, text }. Nothing enters memory_items: the candidates are sealed into memory_imports with AI_MEMORY_KEY and expire after two hours. The answer is the draft id and the redacted candidates.',
    requestBody: {
        required: true,
        content: {
            'application/zip': { schema: { type: 'string', format: 'binary' } },
            'multipart/form-data': { schema: { type: 'object', properties: { provider: str({ enum: ['chatgpt', 'claude-ai', 'gemini-apps', 'other'] }), file: { type: 'string', format: 'binary' }, text: str() } } },
            'text/plain': { schema: { type: 'string' } },
            'application/json': { schema: { type: 'object', properties: { provider: str(), text: str() } } },
        },
    },
    responses: { 200: json('The sealed draft and its candidates', ref('MemoryResult')), 413: problem, 422: problem, 503: problem, ...errors([401, 403]) },
});
route('post', '/memory/import/{id}/commit', {
    operationId: 'commitMemoryImport', summary: 'Keep the ticked candidates and delete the draft', tags: ['memory'], security: memorySecurity,
    description: 'The person’s own token only. keep names the preview keys (k1, k2, …) to store. They go through the normal batch import (redaction again, dedupe), and the draft is deleted; the keys not sent are not stored. An expired draft answers 410.',
    parameters: [path('id', str())],
    requestBody: body({ type: 'object', properties: { keep: arrayOf(str()) } }),
    responses: { 200: json('What was kept and left out', ref('MemoryResult')), 404: problem, 410: problem, 422: problem, 503: problem, ...errors([401, 403]) },
});
route('delete', '/memory/import/{id}', {
    operationId: 'discardMemoryImport', summary: 'Throw a preview draft away', tags: ['memory'], security: memorySecurity,
    description: 'The person’s own token only. The draft and its candidates are deleted; nothing was ever stored in memory_items.',
    parameters: [path('id', str())],
    responses: { 200: json('How many candidates were discarded', ref('MemoryResult')), 404: problem, 410: problem, 503: problem, ...errors([401, 403]) },
});

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

// ── The budget of a run token (Codes C3) ────────────────────────────────────────────────────
route('put', '/run-budgets/{jti}', {
    operationId: 'putRunBudget', summary: "Register the budget of a run token", tags: ['runs'], security: SERVICE,
    description: "ai.run.create. The budget the service that minted a run token gives it: OpenVibe.AI counts every request of that token against it and refuses the request after the budget is spent (402 ai.run_budget_reached). A token without a budget is never capped.",
    parameters: [path('jti', str(), "The run token's own id")],
    requestBody: body({ type: 'object', properties: { budget_usd: nullable('number'), budget_tokens: nullable('integer'), expires_at: nullable('integer') } }),
    responses: { 200: json('The budget', { type: 'object', required: ['jti'], properties: { jti: str(), budget_usd: nullable('number'), budget_tokens: nullable('integer'), expires_at: integer() } }), ...errors([401, 403, 422]) },
});
route('get', '/run-budgets/{jti}', {
    operationId: 'getRunBudget', summary: 'What a run token may spend, and what it has spent', tags: ['runs'], security: SERVICE,
    description: 'ai.run.create. The counter of one run token: the budget it carries and what the run spent against it.',
    parameters: [path('jti', str(), "The run token's own id")],
    responses: { 200: json('The budget and the spend', { type: 'object', required: ['jti'], properties: { jti: str(), budget_usd: nullable('number'), budget_tokens: nullable('integer'), spent_usd: nullable('number'), spent_tokens: nullable('integer'), expires_at: nullable('integer'), reached: { type: 'boolean' } } }), ...errors([401, 403, 422]) },
});

// ── The half-price batches (server/batch/) ────────────────────────────────────────────────────
const batchItem = {
    type: 'object', required: ['idx', 'status'],
    properties: {
        idx: integer({ minimum: 0 }),
        status: str({ enum: ['queued', 'running', 'succeeded', 'failed'] }),
        model: nullable('string'),
        run_id: nullable('string', { description: 'The run that answered this prompt' }),
        answer: nullable('string'),
        error_code: nullable('string'),
        error_detail: nullable('string'),
    },
};
const batch = {
    type: 'object', required: ['id', 'status', 'items'],
    properties: {
        id: str(), owner_type: str({ enum: ['user', 'app'] }), owner_id: str(), project_id: nullable('string'),
        status: str({ enum: ['queued', 'running', 'succeeded', 'failed'] }),
        item_count: integer({ minimum: 1, description: 'How many prompts the batch carries' }),
        items: arrayOf(batchItem),
        discount: str({ description: 'The price the batch is charged at: half the retail rate, through Billing like every other request.' }),
        created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }), finished_at: nullable('string', { format: 'date-time' }),
    },
};
route('post', '/batches', {
    operationId: 'createBatch', summary: 'Submit a batch of prompts to be answered later, at half the retail price', tags: ['batches'], security: SERVICE_OR_APP,
    description: 'ai.run.create (or a developer app\'s ai.app.run). The batch is queued and its prompts are answered later; GET /batches/{id} says where it stands. It is billed through Billing like every other request, at half the retail rate, against the account that submits it (a person\'s Balance, or an app\'s project). A batch carries at most the configured number of prompts; a bigger one is refused with batch.too_large.',
    requestBody: body({ type: 'object', required: ['items'], properties: {
        items: { type: 'array', minItems: 1, items: { oneOf: [str(), { type: 'object', required: ['prompt'], properties: { prompt: str() } }] } },
        model: str({ description: 'The model the prompts are asked of, when the caller names one' }),
    } }),
    responses: { 201: json('The queued batch', batch), 403: problem, 422: problem, ...errors([401, 422]) },
});
route('get', '/batches', {
    operationId: 'listBatches', summary: 'The caller\'s own batches', tags: ['batches'], security: SERVICE_OR_APP,
    description: 'ai.run.read. The batches the caller submitted, newest first.',
    responses: { 200: json('The batches', { type: 'object', required: ['batches'], properties: { batches: { type: 'array', items: { type: 'object' } } } }), ...errors([401, 403]) },
});
route('get', '/batches/{id}', {
    operationId: 'getBatch', summary: 'One batch and its prompts', tags: ['batches'], security: SERVICE_OR_APP,
    description: 'ai.run.read. Where the batch stands (queued, running, succeeded, failed) and what each of its prompts was answered with.',
    parameters: [path('id', str())],
    responses: { 200: json('The batch', { type: 'object', required: ['batch'], properties: { batch: batch } }), 404: problem, ...errors([401, 403]) },
});

// ── Exchange read API (OpenVibe.Exchange) ───────────────────────────────────────────────────
const exchangeOffer = {
    type: 'object', required: ['provider', 'provider_name', 'model', 'kind', 'trust', 'free', 'free_tier', 'price'],
    properties: {
        provider: str({ description: 'The real upstream, never the router\'s internal provider key' }), provider_name: str(), model: str(),
        kind: str({ enum: ['chat', 'embedding', 'stt', 'image'] }),
        id: nullable('string', { description: 'The exact artifact id a request may pin, when the registry records one' }),
        trust: { type: 'string', enum: ['first-party', 'community'] },
        access: str({ enum: ['OWN_DEPLOYMENT', 'AUTHORIZED_WHOLESALE', 'UNVERIFIED'] }),
        free: { type: 'boolean', description: 'Prepaid capacity with no per-token price (a free server, a subscription, a local machine).' },
        free_tier: { type: 'boolean', description: 'The free allowance and the anonymous Try it may use this offer: its provider is one of AI_FREE_PROVIDERS (default deepseek,local,community; local covers local2 and whisper.cpp) and its output price is at or below AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK (default 1.5). Distinct from free: a priced DeepSeek Flash offer is free_tier true while a dearer priced offer is false.' },
        price: nullable('object', { properties: { in: { type: 'number' }, out: { type: 'number' }, cached: { type: 'number' }, per: str(), currency: str() } }),
        price_source: nullable('string', { description: 'The price page the card was read from, when recorded' }),
        price_checked_at: nullable('string', { description: 'The date someone checked the price, when recorded' }),
        speed: { type: 'object', properties: { p50_ms: nullable('number'), p95_ms: nullable('number') } },
        uptime: nullable('number', { minimum: 0, maximum: 1, description: 'succeeded / (succeeded + failed) real runs; null when no run reached this offer' }),
        requests_7d: integer({ minimum: 0 }), requests_today: integer({ minimum: 0 }),
        cached_7d: integer({ minimum: 0, description: 'Cached answers (no provider call) in the window, counted apart from requests_7d' }),
        cached_today: integer({ minimum: 0 }),
        data_policy: nullable('object', { properties: { trains: nullable('boolean'), retention_days: nullable('integer'), region: nullable('string'), anonymized: nullable('boolean', { description: 'The provider says the request is anonymised before the model sees it' }) } }),
        refusal_rate: nullable('number', { minimum: 0, maximum: 1, description: 'The share of the published probe set this offer refused (0.75 is three probes out of four). null when nobody measured this offer, never 0.' }),
        refusal_measured_on: nullable('string', { description: 'The day the refusal rate was measured' }),
        refusal_prompt_set: nullable('string', { description: 'The version of the published probe set the rate was measured with' }),
        updated_at: nullable('string'),
    },
};
const exchangeModel = {
    type: 'object', required: ['slug', 'name', 'family', 'kind', 'uncensored', 'offers'],
    properties: {
        slug: str(), canonical: str(), name: str(), family: str(), variant: nullable('string'), uncensored: { type: 'boolean' },
        kind: str({ enum: ['chat', 'embedding', 'stt', 'image'] }), type: str(), context: nullable('integer'), max_output: nullable('integer'),
        capabilities: { type: 'object', properties: { tools: { type: 'boolean' }, json: { type: 'boolean' }, vision: { type: 'boolean' }, stream: { type: 'boolean' } } },
        modalities: arrayOf(str()), description: nullable('string'),
        requests_7d: integer({ minimum: 0 }), requests_today: integer({ minimum: 0 }),
        cached_7d: integer({ minimum: 0 }), cached_today: integer({ minimum: 0 }), community: { type: 'boolean' },
        offers: arrayOf(exchangeOffer),
    },
};
route('get', '/exchange/catalog', {
    operationId: 'exchangeCatalog', summary: 'Every model and every offer that serves it', tags: ['exchange'], security: [],
    description: 'Public. The live offers: price in, out and cached per million tokens, measured p50/p95, uptime, requests, and the provider data policy. Speed and uptime are read from the last seven days of real runs (time to the first token where a receipt recorded one, else the answering attempt\'s total); cached answers are counted apart and excluded from speed, uptime and requests. Uptime is succeeded / (succeeded + failed); null when no data, never 0. A prepaid offer has no price (free: true); free_tier says whether the free allowance and the anonymous Try it may use an offer at all (a named AI_FREE_PROVIDERS source under the output price ceiling). Models carry a kind (chat, embedding, stt, image); chat lists must use kind "chat" and never mix embeddings or speech-to-text.',
    parameters: [query('kind', str({ enum: ['chat', 'embedding', 'stt', 'image'] }), 'Only models of this kind')],
    responses: { 200: json('The models, grouped by model, with their offers', { type: 'object', required: ['models'], properties: {
        generated_at: str({ format: 'date-time' }), window_days: integer(), count: integer(),
        kind: str({ enum: ['chat', 'embedding', 'stt', 'image'] }),
        families: arrayOf({ type: 'object', properties: { name: str(), models: integer(), offers: integer() } }),
        kinds: arrayOf({ type: 'object', properties: { kind: str(), models: integer(), offers: integer() } }),
        models: arrayOf(exchangeModel),
    } }) },
});
route('get', '/exchange/models/{slug}', {
    operationId: 'exchangeModel', summary: 'One model and its offers', tags: ['exchange'], security: [],
    description: 'Public. The slug is "<org>/<model>", lowercased, e.g. deepseek/deepseek-flash.',
    parameters: [path('slug', str())],
    responses: { 200: json('The model', exchangeModel), 404: problem },
});
route('get', '/exchange/models/{org}/{model}', {
    operationId: 'exchangeModelByParts', summary: 'One model, by its org and model', tags: ['exchange'], security: [],
    description: 'Public. The same answer as /exchange/models/{slug}, for a client that has the two parts.',
    parameters: [path('org', str()), path('model', str())],
    responses: { 200: json('The model', exchangeModel), 404: problem },
});
route('get', '/exchange/usage', {
    operationId: 'exchangeUsage', summary: 'Requests, tokens and spend by day, model and product', tags: ['exchange'], security: [],
    description: 'Public and aggregate only: never a prompt, an answer or a person. Read from the finished runs: a product is the service whose run answered (runs.requester_id), and each product\'s models are the provider and model that actually answered, not the route it asked for. Cached answers called no provider and are not counted; only aggregate rows are returned.',
    parameters: [query('days', integer({ minimum: 1, maximum: 366 }), 'Default 30')],
    responses: { 200: json('The aggregates', { type: 'object', properties: {
        generated_at: str({ format: 'date-time' }), days: integer(), from: str(), to: str(),
        today: { type: 'object' }, totals: { type: 'object' },
        by_day: arrayOf({ type: 'object' }), by_model: arrayOf({ type: 'object' }), by_product: arrayOf({ type: 'object' }),
    } }) },
});

route('get', '/exchange/price-changes', {
    operationId: 'exchangePriceChanges', summary: 'What a price was and what it became', tags: ['exchange'], security: [],
    description: "Public. The price changelog: every change the weekly price book made, with the old price, the new price, the provider's own listing the price was read from and the day it was read. A change that waits for the owner's approval is not a price yet and is not here.",
    parameters: [query('limit', integer({ minimum: 1, maximum: 200 }), 'Default 50'), query('provider', str(), 'Only this provider')],
    responses: { 200: json('The changes', { type: 'object', properties: {
        generated_at: str({ format: 'date-time' }), count: integer(),
        changes: arrayOf({ type: 'object', properties: {
            id: str(), provider: str(), model: str(), field: str(),
            old_price: nullable('number'), new_price: { type: 'number' }, change_pct: nullable('number'),
            source: str(), checked_at: str({ format: 'date' }), changed_at: str({ format: 'date-time' }),
        } }),
    } }) },
});

// ── The seller API: a standalone OpenAI-compatible endpoint (the design's SDK gap) ───────────
const sellerEndpointOffer = {
    type: 'object', required: ['id', 'offer_id', 'base_url', 'models', 'hours', 'concurrency', 'price', 'audience'],
    properties: {
        id: str({ pattern: '^ep_[0-9A-HJKMNP-TV-Z]{26}$' }),
        offer_id: str({ description: 'The offer id the router and the receipt use: endpoint:<id>' }),
        name: nullable('string'),
        base_url: str({ description: 'The https base URL the router calls; /chat/completions is appended. Port 443 or 8443, a host name (never an IP address).' }),
        models: arrayOf(str()), hours: { type: 'object', properties: { start: str(), end: str(), tz: str() } },
        concurrency: integer({ minimum: 1, maximum: 8 }),
        price: { type: 'object', properties: { in_per_million: { type: 'number' }, out_per_million: { type: 'number' } } },
        audience: str({ enum: ['everyone', 'followers', 'group'] }), group: nullable('string'),
        created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }),
        verification: nullable('object', { description: 'Canaries, spot re-runs, reputation and free-only, as the /sell dashboard shows them' }),
        reputation: integer({ minimum: 0, maximum: 100 }), free_only: { type: 'boolean' }, verified: { type: 'boolean' },
    },
};
const sellerEndpointInput = {
    type: 'object', required: ['base_url', 'models', 'price', 'hours', 'concurrency'],
    properties: {
        base_url: str({ description: 'https, a public host name (no IP literal), port 443 or 8443, an optional base path such as /v1' }),
        models: { type: 'array', items: str(), minItems: 1, maxItems: 40 },
        price: { description: 'Credits per million tokens: a number for both sides, or {in_per_million, out_per_million}; 0 volunteers the model', oneOf: [
            { type: 'number', minimum: 0, maximum: 1000000 },
            { type: 'object', required: ['in_per_million', 'out_per_million'], properties: { in_per_million: { type: 'number', minimum: 0, maximum: 1000000 }, out_per_million: { type: 'number', minimum: 0, maximum: 1000000 } } },
        ] },
        hours: { type: 'object', required: ['start', 'end'], properties: { start: str({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }), end: str({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }), tz: str() } },
        concurrency: integer({ minimum: 1, maximum: 8 }),
        audience: str({ enum: ['everyone', 'followers', 'group'] }),
        group: str({ description: 'Required when audience is group' }),
        name: str({ maxLength: 100 }),
    },
};
route('post', '/exchange/seller/offers', {
    operationId: 'createSellerEndpointOffer', summary: 'Register a standalone OpenAI-compatible server to sell', tags: ['exchange'], security: SERVICE_OR_APP,
    description: 'ai.app.run (a Network developer key), or a person\'s own token; a first-party service token is refused. The owner is the person the key acts for: an app\'s project owner, or the person themselves. The router reaches base_url only through the egress guard: https, a public DNS answer, never an IP literal, a timeout, a response byte cap, and never the buyer\'s identity in a header. A new endpoint serves the free tier only until its canaries, model fingerprint and spot re-runs verify it, exactly as a Node machine does; a request on the seller\'s own account is self-served and earns 0. An answer from it is labelled a community endpoint on the receipt (provider community-endpoint:<id>, provider_access COMMUNITY_ENDPOINT) and only requests that opt in to community capacity reach it.',
    requestBody: body(sellerEndpointInput),
    responses: { 201: json('The registered offer', { type: 'object', required: ['offer'], properties: { offer: sellerEndpointOffer } }), 409: problem, 422: problem, ...errors([401, 403, 503]) },
});
route('get', '/exchange/seller/offers', {
    operationId: 'listSellerEndpointOffers', summary: 'The caller\'s own endpoint offers, with their verification', tags: ['exchange'], security: SERVICE_OR_APP,
    description: 'ai.app.run, or a person\'s own token. Only the caller\'s offers: an app sees the offers of its project owner. The verification is the same the /sell dashboard shows.',
    responses: { 200: json('The offers', { type: 'object', required: ['owner', 'offers'], properties: { owner: str({ pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }), offers: arrayOf(sellerEndpointOffer) } }), ...errors([401, 403, 503]) },
});
route('delete', '/exchange/seller/offers/{id}', {
    operationId: 'deleteSellerEndpointOffer', summary: 'Remove one of the caller\'s endpoint offers', tags: ['exchange'], security: SERVICE_OR_APP,
    description: 'ai.app.run, or a person\'s own token. The offer stops receiving traffic on the next offer refresh (within 30 seconds); its verification and earnings stay as history.',
    parameters: [path('id', str({ pattern: '^ep_[0-9A-HJKMNP-TV-Z]{26}$' }))],
    responses: { 200: json('The removal', { type: 'object', properties: { id: str(), removed: { type: 'boolean' } } }), 404: problem, ...errors([401, 403]) },
});
route('post', '/exchange/tryit/challenge', {
    operationId: 'exchangeTryitChallenge', summary: 'A proof-of-work challenge for the anonymous Try it', tags: ['exchange'], security: [],
    description: 'Public. The anonymous Try it (no account, no Balance) must send a solved challenge in x-ov-pow: <challenge>:<nonce>, where sha256("<challenge>:<nonce>") has `bits` leading zero bits. The challenge is single use and expires; AI stores only its hash. The response also sets the signed, HttpOnly `ovai_device` cookie (when it is not already present), which counts accounts per device. A first-party service may forward the client address in x-ov-client-ip.',
    requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: {} } } } },
    responses: {
        200: json('The challenge', { type: 'object', required: ['challenge', 'bits', 'expires_at'], properties: { challenge: str(), bits: integer(), expires_at: str({ format: 'date-time' }) } }),
        429: problem,
        503: problem,
    },
});

// ── Action Center ────────────────────────────────────────────────────────────────────────────
route('get', '/actions', {
    operationId: 'listActions', summary: 'The Action Center items for one person', tags: ['actions'], security: SERVICE,
    description: 'ai.actions.read: a service token names one usr_ subject and gets only the runs whose on_behalf_of is that person — queued and running, then done and failed from the last 30 days, at most 50.',
    parameters: [query('subject', str({ pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }), 'Required')],
    responses: { 200: json('common.action-list-result@1', { type: 'object', required: ['items'], properties: { items: arrayOf(ref('ActionItem')) } }), ...errors([400, 401, 403, 429]) },
});

// ── Routing presets and receipts (the Exchange, 2026-11-06) ───────────────────────────────────
route('get', '/presets', {
    operationId: 'listPresets', summary: 'The routing presets this caller may name', tags: ['presets'], security: SERVICE_OR_APP,
    description: 'ai.run.create (an app token needs ai.app.run). The five built-in profiles — cheapest, fastest, private, uncensored, eu-only — and the caller\'s own: the ones its project or its account stored. A name is used as the model "@preset/<name>" or as the request\'s preset.',
    responses: { 200: json('The presets', { type: 'object', required: ['presets'], properties: { presets: arrayOf(ref('Preset')) } }), ...errors([401, 403]) },
});
route('post', '/presets', {
    operationId: 'createPreset', summary: 'Store (or replace) one routing preset', tags: ['presets'], security: SERVICE_OR_APP,
    description: 'ai.run.create (an app token needs ai.app.run). The preset belongs to the caller\'s project (an app token) or to the person the token acts for. A built-in name cannot be overwritten: it is not the caller\'s.',
    requestBody: body({ type: 'object', required: ['name'], properties: { name: str({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }), policy: ref('PresetPolicy') } }),
    responses: { 201: json('The stored preset', { type: 'object', required: ['preset'], properties: { preset: ref('Preset') } }), 409: problem, 422: problem, ...errors([401, 403]) },
});
route('delete', '/presets/{name}', {
    operationId: 'deletePreset', summary: 'Delete one routing preset', tags: ['presets'], security: SERVICE_OR_APP,
    description: 'ai.run.create (an app token needs ai.app.run). The caller\'s own preset only; a built-in one is not theirs to delete.',
    parameters: [path('name', str({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }))],
    responses: { 200: json('The removal', { type: 'object', properties: { name: str(), removed: { type: 'boolean' } } }), 409: problem, 422: problem, ...errors([401, 403]) },
});
route('get', '/receipts/{id}', {
    operationId: 'getReceipt', summary: 'The receipt of one answered request', tags: ['receipts'], security: SERVICE_OR_APP,
    description: 'ai.run.read (or ai.run.create; an app token needs ai.app.run), or ai.usage.read. The receipt says which offer answered, what it charged, the tokens, the cache hits, the latency, why the router chose it and the fallbacks it would have used, who paid and the privacy label. It never carries the prompt or the answer. The same receipt is in the answer\'s x-openvibe-receipt header.',
    parameters: [path('id', str({ pattern: '^rcpt_[0-9A-HJKMNP-TV-Z]{26}$' }))],
    responses: { 200: json('The receipt', { type: 'object', required: ['receipt'], properties: { receipt: ref('Receipt') } }), 404: problem, ...errors([401, 403]) },
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
        tags: ['runs', 'operations', 'actions', 'exchange', 'presets', 'receipts'].map((name) => ({ name })),
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
                MemoryItem: { type: 'object', required: ['id', 'owner', 'scope', 'kind', 'text', 'source', 'status', 'confidence', 'created_at', 'updated_at'], properties: {
                    id: str({ pattern: '^mem_[0-9A-HJKMNP-TV-Z]{26}$' }), owner: str(), scope: str(),
                    kind: str({ enum: ['preference', 'fact', 'project_rule', 'procedure', 'decision', 'lesson'] }),
                    text: str(), source: str(), source_ref: nullable('object'),
                    status: str({ enum: ['active', 'suggested', 'archived', 'conflict'] }), confidence: { type: 'number' },
                    seen_at: str({ format: 'date-time' }), created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }),
                    machine: nullable('string'), no_looks: { type: 'boolean' },
                } },
                MemoryProfile: { type: 'object', properties: {
                    scope: str(), text: str(), items_hash: str({ pattern: '^[0-9a-f]{64}$' }), built_at: str({ format: 'date-time' }),
                } },
                MemoryResult: { type: 'object', properties: {
                    items: arrayOf(ref('MemoryItem')), item: ref('MemoryItem'), profile: ref('MemoryProfile'),
                    deleted: integer({ minimum: 0 }), count: integer({ minimum: 0 }),
                } },
                AllowedKeys: { type: 'object', required: ['subject', 'service', 'providers'], properties: {
                    subject: str({ pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }), service: str(), providers: arrayOf(str({ maxLength: 40 })),
                }, additionalProperties: false },
                MemoryWriteRequest: { type: 'object', properties: {
                    items: arrayOf(ref('MemoryItemWrite')), on_behalf_of: str(), text: str(), kind: str(), scope: str(), status: str(), source: str(),
                } },
                MemoryItemWrite: { type: 'object', required: ['text'], properties: {
                    text: str(), kind: str(), scope: str(), source: str(), source_ref: nullable('object'), on_behalf_of: str(),
                    status: str({ enum: ['active', 'suggested', 'archived', 'conflict'] }), confidence: { type: 'number' },
                    machine: nullable('string'), no_looks: { type: 'boolean' }, seen_at: str({ format: 'date-time' }),
                } },
                ActionItem: { type: 'object', required: ['service', 'id', 'kind', 'title', 'bucket', 'state'], properties: {
                    service: { const: 'ai' }, id: str(), kind: { const: 'ai_run' }, title: str(), summary: nullable('string'),
                    bucket: { type: 'string', enum: ['active', 'done', 'failed'] }, state: str(), agent: nullable('string'),
                    cost_usd: nullable('number'), steps: nullable('integer'), error: nullable('string'),
                    created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }), href: str(),
                    actions: arrayOf(str()),
                } },
                PresetPolicy: { type: 'object', properties: {
                    objective: str({ enum: ['cheapest', 'fastest', 'balanced', 'private'] }),
                    floor: str({ enum: ['fast', 'balanced', 'strong', 'frontier'] }),
                    ceiling: nullable('number', { description: 'US dollars per million tokens: the highest price that may be paid' }),
                    max_price: nullable('number', { description: 'US dollars per million tokens: the hard cap. No offer fits is a refusal before the call' }),
                    quantization: arrayOf(str({ maxLength: 32 })),
                    region: arrayOf(str({ maxLength: 32 })),
                    data_policy: str({ enum: ['private', 'anonymized', 'community'] }),
                    community: { type: 'boolean' },
                    adult: { type: 'boolean' },
                } },
                Preset: { type: 'object', required: ['name', 'policy'], properties: {
                    name: str(), description: nullable('string'), scope: str({ enum: ['builtin', 'owner', 'request'] }), builtin: { type: 'boolean' },
                    owner: nullable('object'), policy: ref('PresetPolicy'),
                    created_at: nullable(str({ format: 'date-time' })), updated_at: nullable(str({ format: 'date-time' })),
                } },
                Receipt: { type: 'object', required: ['id', 'run_id'], properties: {
                    id: str(), run_id: str(), created_at: str({ format: 'date-time' }), workflow: nullable('string'),
                    route: nullable('object'),
                    preset: nullable({ type: 'object', properties: { name: str(), scope: str(), policy: ref('PresetPolicy') } }),
                    offer: { type: 'object', properties: {
                        provider: nullable('string'), model: nullable('string'), deployment: nullable('string'),
                        provider_access: nullable('string'), resolved_model: nullable('string'),
                    } },
                    price: { type: 'object', properties: {
                        in_per_mtok: nullable('number'), out_per_mtok: nullable('number'), cached_per_mtok: nullable('number'), source: nullable('string'),
                    } },
                    usage: { type: 'object', properties: {
                        tokens_in: integer(), tokens_out: integer(), tokens_cached: integer(), tokens_cache_write: integer(), tokens_reasoning: integer(),
                    } },
                    cost_usd: nullable('number'), fee_usd: nullable('number'), fee_rate: nullable('number'),
                    paid_by: str({ enum: ['openvibe_key', 'own_key', 'own_machine', 'plan'] }), paid_by_detail: nullable('string'), byok: { type: 'boolean' },
                    latency_ms: nullable('integer'), ttft_ms: nullable('integer'),
                    why: arrayOf(str()),
                    fallbacks: arrayOf({ type: 'object', properties: {
                        offer: str(), provider: nullable('string'), model: nullable('string'),
                        why: nullable('string'), status: nullable('string'), reason: nullable('string'),
                    } }),
                    privacy: nullable({ type: 'object', properties: {
                        label: str({ enum: ['private', 'anonymized', 'community'] }),
                        retention: nullable('string'), training: nullable('boolean'), region: nullable('string'),
                        trust: nullable('string'), known: { type: 'boolean' }, source: nullable('string'),
                    } }),
                    attempts: integer(),
                    requester: nullable('object'), owner: nullable('object'),
                } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).sort(([a], [b]) => a.localeCompare(b)).map(([p, item]) => [MOUNT + p, item])) },
    };
}

// ── Community AI offers (the design's "Offer to the network") ───────────────────────────────
route('get', '/community/offers', {
    operationId: 'communityOffers', summary: 'Live community offers for Exchange', tags: ['community'],
    description: 'No token. Models, price in credits per million, hours, concurrency, audience, health and open_now; never an owner subject or a machine id (offer_id is a stable hash).',
    responses: { 200: json('The live community offers'), 503: problem },
});
route('get', '/community/sell', {
    operationId: 'communitySell', summary: 'The seller dashboard for Exchange', tags: ['community'], security: SERVICE,
    description: 'ai.run.read or ai.usage.read, acting for the owner in X-OV-Subject. Tokens served, credits recorded (1 credit = 1,000,000 micro), uptime, verification (canaries, spot re-runs) and reputation; nothing here moves money.',
    parameters: [{ name: 'X-OV-Subject', in: 'header', required: true, schema: str({ pattern: '^usr_[0-9A-HJKMNP-TV-Z]{26}$' }), description: 'The owner whose offers and ledger these are' }],
    responses: { 200: json('The owner\'s offers and totals'), 422: problem, 503: problem, ...errors([401, 403]) },
});

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
