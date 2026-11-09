'use strict';
const { schema } = require('openvibe-contracts');
const contract = id => {
    const { $id, $schema, ...s } = schema(id);
    return s;
};
const json = s => ({ content: { 'application/json': { schema: s } } });
const properties = {
    q: { type: 'string', minLength: 1, maxLength: 500 },
    engine: { type: 'string', default: 'auto', description: 'Engine ID from the public catalog. Auto prefers personal keys, then price among healthy engines supporting freshness. Failed personal keys never fall back to shared keys.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum returned results; some providers return fewer.' },
    freshness: { type: 'string', enum: ['day', 'month', 'year'] },
    max_cost_usd: { type: 'number', minimum: 0, description: 'Maximum provider cost for this call, including BYOK. Variable-cost engines must fit their documented conservative ceiling.' },
};
const errors = Object.fromEntries([401, 403, 422, 429, 503].map(n => [n, { description: 'Authentication, invalid request, cap/rate limit or engine unavailable (application/problem+json).' }]));
const paths = {};
for (const kind of ['web', 'images', 'icons']) {
    paths['/v1/search' + (kind === 'web' ? '' : '/' + kind)] = { post: {
        operationId: 'search' + kind[0].toUpperCase() + kind.slice(1), tags: ['exchange'],
        summary: `Search ${kind} through Exchange`, security: [{ bearer: [] }],
        description: 'Accepts an Exchange key, person token, authorized service or app token. Receipt reports engine, provider cost in USD and elapsed milliseconds, including fallbacks. If a timed-out or malformed upstream answer may already have been billed, its reserved ceiling is included conservatively. BYOK has zero Exchange charge and zero fee; its provider cost remains visible in the receipt. Shared keys settle that cost against the Exchange key cap. Sources and checked dates are in GET /api/v1/exchange/search/engines.',
        requestBody: { required: true, ...json({ type: 'object', required: ['q'], properties: {
            ...properties,
            ...(kind === 'web' ? {} : {
                license: { type: 'string', description: 'Exact licence filter; cc-by and by are equivalent. Unknown licences never pass commercial=true.' },
                commercial: { type: 'boolean' }, format: { type: 'string' },
                orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
                size: { type: 'string', enum: ['small', 'medium', 'large'], description: 'Longest side: below 800px, 800–1999px, or 2000px and above. Missing dimensions do not match.' },
                type: { type: 'string', enum: ['icon'] }, set: { type: 'string' },
                style: { type: 'string', enum: ['any', 'line', 'solid'] },
            }),
        } }) },
        responses: { 200: { description: kind === 'web' ? 'exchange.search-result@1. Sonar answer text is the snippet on each cited source.' : 'exchange.image-result@1. Images include size, author, licence, source page and attribution; unavailable metadata is null. Search results confer no additional licence.', ...json(contract(kind === 'web' ? 'exchange.search-result@1' : 'exchange.image-result@1')) }, ...errors },
    } };
}
paths['/v1/fetch'] = { post: {
    operationId: 'fetchSearchPage', tags: ['exchange'], summary: 'Read a public HTTPS page as text or Markdown', security: [{ bearer: [] }],
    description: 'engine: auto, openvibe-egress, deepseek or jina. Auto prefers an eligible personal reader key, otherwise free local egress. Remote reader targets pass the existing public DNS/address guard before submission. Direct reads recheck DNS at connect time. Remote reader redirects are subject to the provider security policy. Receipt and cap semantics match search.',
    requestBody: { required: true, ...json({ type: 'object', required: ['url'], properties: {
        url: { type: 'string', format: 'uri', maxLength: 8192 }, engine: properties.engine, max_cost_usd: properties.max_cost_usd,
    } }) },
    responses: { 200: { description: 'The URL, extracted text (at most 200000 characters) and receipt', ...json({ type: 'object', required: ['url', 'text', 'receipt'], properties: {
        url: { type: 'string', format: 'uri' }, text: { type: 'string' }, receipt: contract('exchange.search-result@1').properties.receipt,
    } }) }, ...errors },
} };
module.exports = { paths };
