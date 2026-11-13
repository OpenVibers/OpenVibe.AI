'use strict';
const { requestFor, post, bearer, web } = require('../transport');
module.exports = {
    id: 'perplexity', byok: true, checked_on: '2026-11-09',
    kinds: ['web'], key_env: 'SEARCH_PERPLEXITY_KEY', hosts: ['api.perplexity.ai'],
    class: 'answer_engine',
    price_per_1000: null, source: 'https://docs.perplexity.ai/docs/getting-started/pricing', freshness: [],
    pricing_note: 'Sonar on Agent API: $0.25/M input, $2.50/M output, $0.0625/M cached; web search $2.50/1000 tool calls. No flat answer price.',
    input_per_million: 0.25, output_per_million: 2.5, search_per_1000: 2.5,
    ceiling: () => 0.1,
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.perplexity.ai/v1/agent', post({ model: 'perplexity/sonar', input: b.q, instructions: 'Search the web before answering and cite your sources.', max_tool_calls: 1, tools: [{ type: 'web_search' }], max_steps: 3, max_output_tokens: 1024, store: false }, bearer(key)));
        const content = (out.output || []).filter(r => r.type === 'message').flatMap(r => r.content || []).filter(r => r.type === 'output_text');
        const answer = content.map(r => r.text).join('\n');
        const citations = (out.output || []).filter(r => r.type === 'search_results').flatMap(r => r.results || []);
        if (!answer) throw new Error('Sonar returned no answer');
        const cost = out.usage?.cost?.total_cost;
        if (!Number.isFinite(cost) || cost < 0) throw new Error('Sonar usage is missing');
        // Answers retain their citations in the contract's result rows, without inventing a source URL.
        return { rows: citations.map(r => web(r, answer, r.date)), cost };
    },
};
