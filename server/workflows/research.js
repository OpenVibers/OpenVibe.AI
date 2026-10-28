'use strict';
/**
 * MegaSource (server/research/): one research call over Wikipedia, the topic's Fandom wiki, Wikidata, DeepSeek web
 * search, Commons and Openverse. No model call and no template: the step reads, ranks and returns the evidence, and the
 * product workflows (wiki.generate_space, wiki.generate_page, …) cite it by number. Cached for a day per calling
 * service: the same question asked twice reads the web once.
 */
const { SOURCE } = require('./common-schemas');

const STR = (n) => ({ type: 'string', maxLength: n });
const INT = (lo, hi) => ({ type: 'integer', minimum: lo, maximum: hi });
const NULLABLE = (n) => ({ type: ['string', 'null'], maxLength: n });
const PROVIDERS = ['wikipedia', 'fandom', 'wikidata', 'deepseek', 'commons', 'openverse'];

const IMAGE = {
    type: 'object', additionalProperties: false, required: ['url', 'free', 'provider'],
    properties: {
        url: STR(2048), original: NULLABLE(2048), width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] }, mime: NULLABLE(40),
        title: NULLABLE(300), description: NULLABLE(400), author: NULLABLE(200), license: NULLABLE(200), license_url: NULLABLE(2048),
        free: { type: 'boolean' }, source_url: NULLABLE(2048), provider: STR(80),
    },
};

const workflows = [
    {
        key: 'research.gather', name: 'Research a topic (MegaSource)', namespace: 'research',
        description: 'Sources, licensed pictures and facts for a topic from Wikipedia, its Fandom wiki, Wikidata, the Search Fabric web scope (DeepSeek as its fallback), Commons and Openverse.',
        input_schema: {
            type: 'object', additionalProperties: false, required: ['query'],
            properties: {
                query: STR(200), topic: STR(200), focus: STR(200), question: STR(200),
                lang: { type: 'string', pattern: '^[a-z]{2,3}$' },
                max_sources: INT(1, 20), max_images: INT(0, 24), images: { type: 'boolean' }, content_chars: INT(500, 12000),
                providers: { type: 'array', maxItems: PROVIDERS.length, items: { enum: PROVIDERS } },
            },
        },
        output_schema: {
            type: 'object', additionalProperties: false, required: ['query', 'sources', 'images', 'facts', 'providers', 'usage'],
            properties: {
                query: STR(200), topic: STR(200), focus: NULLABLE(200), lang: STR(3), retrieved_at: STR(40),
                sources: { type: 'array', maxItems: 20, items: SOURCE },
                images: { type: 'array', maxItems: 24, items: IMAGE },
                facts: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: STR(80), value: STR(400) } } },
                topic_wiki: { type: ['object', 'null'] },
                providers: { type: 'object' },
                usage: { type: 'object' },
            },
        },
        steps: [{ kind: 'research' }],
        default_route: null,
        cache_mode: 'service', cache_ttl_sec: 86400,
        metadata: { seed: true },
    },
];

module.exports = { templates: [], workflows, PROVIDERS };
