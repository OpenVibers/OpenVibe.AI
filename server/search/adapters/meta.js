'use strict';
const { requestFor, post, bearer, web } = require('../transport');
const MAX_OUTPUT = 512;
module.exports = {
    id: 'meta', byok: true, manual_only: true, registry_required: true, checked_on: '2026-11-10',
    kinds: ['web'], key_env: 'SEARCH_META_KEY', hosts: ['api.meta.ai'], freshness: [],
    class: 'answer_engine',
    price_per_1000: null, source: 'https://dev.meta.ai/docs/pricing-rate-limits',
    pricing_note: 'Muse Spark 1.3 Standard: $1.25/M input, $0.15/M cached, $4.25/M output plus $2.50/1000 queries. Explicit selection only; up to $4 reserved for one built-in call and its model iterations.',
    // One built-in call permits at most two model iterations. Reserve both full context windows,
    // the output budget, and conservatively one search query per generated token.
    ceiling: () => 4,
    estimate: () => 0.01,
    async search(b, { fetchImpl, key }) {
        const out = await requestFor(this.hosts, fetchImpl)('https://api.meta.ai/v1/responses', post({
            model: 'muse-spark-1.3', input: b.q, instructions: 'Search the web for this question. Use one concise search query and cite the sources.',
            tools: [{ type: 'web_search', search_context_size: 'low' }], max_tool_calls: 1,
            include: ['web_search_call.results'], max_output_tokens: MAX_OUTPUT, store: false,
        }, bearer(key)));
        const usage = out.usage;
        const input = usage?.input_tokens, output = usage?.output_tokens, cached = usage?.input_tokens_details?.cached_tokens ?? 0;
        if (![input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input) throw new Error('Meta usage is missing');
        const searches = (out.output || []).filter(item => item.type === 'web_search_call');
        let queries = 0;
        const rows = [];
        for (const call of searches) {
            if (call.status !== 'completed' || call.action?.type !== 'search') throw new Error('Meta search did not complete');
            const issued = Array.isArray(call.action.queries) ? call.action.queries : typeof call.action.query === 'string' ? [call.action.query] : null;
            if (!issued?.length || issued.some(q => typeof q !== 'string' || !q.trim())) throw new Error('Meta search query usage is missing');
            queries += issued.length;
            for (const result of call.results || []) if (result.type === 'text_result') rows.push(web(result, result.snippet, null));
        }
        if (!searches.length || !rows.length) throw new Error('Meta returned no search results');
        const cost = ((input - cached) * 1.25 + cached * 0.15 + output * 4.25) / 1e6 + queries * 0.0025;
        return { rows, cost };
    },
};
