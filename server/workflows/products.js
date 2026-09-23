'use strict';
/**
 * Seed workflows the publication products consume (plan §15.13). Every one returns a DRAFT /
 * EVIDENCE package — never publication truth — with citations that index into the numbered
 * input.sources, plus `gaps` for what the sources do not support. The owning product (Wiki,
 * Blog, News, Reviews, Deals, Coupons, Trade, Codes, Games) decides what to publish.
 *
 * Hard rules carried into the prompts and the schemas:
 *   - no invented facts, prices, ratings, dates, quotes (Reviews has no rating field at all;
 *     Deals' price is null unless cited; Coupons' unknown expiry stays unknown)
 *   - Trade is informational only (fixed disclaimer, observation timestamps, stale sources flagged)
 *   - moderation follows OpenVibe policy: profanity is allowed; threats, minors and doxxing are not
 */
const { SOURCES, CITES, GAPS } = require('./common-schemas');

const STR = (n) => ({ type: 'string', maxLength: n });
const OBJ = (props, required) => ({ type: 'object', additionalProperties: false, required: required || Object.keys(props), properties: props });
const ARR = (items, max = 20) => ({ type: 'array', items, maxItems: max });
const CLAIM = OBJ({ text: STR(600), citations: CITES });

const RULES = 'You prepare a DRAFT evidence package for OpenVibe editors — never publication truth. Use ONLY the numbered sources provided. Every claim must cite the source numbers it rests on in its `citations` array (integers, e.g. [0, 2]). If the sources do not support something, leave it out and list it in `gaps`. Never invent facts, names, numbers, prices, ratings, dates or quotes. Output only JSON matching the schema.';

function productTemplate(key, name, task, route, extraUser = '') {
    return {
        key, name, description: `${name}. Draft/evidence package with citations.`,
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: `${RULES}\n\nTask: ${task}`,
        user_prompt: `${extraUser}{{#sources_block}}Sources ({{source_count}}):\n\n{{sources_block}}{{/sources_block}}{{^sources_block}}No sources were provided.{{/sources_block}}`,
        default_route: route, owner: key.split('.')[0], metadata: { json_name: key.replace(/\./g, '_') },
    };
}

const templates = [
    productTemplate('wiki.generate_space', 'Wiki: propose a space', 'Propose a wiki space for the topic: a title, a one-paragraph summary and a page tree (page titles with short outlines), grounded in the sources.', 'wiki.generate',
        'Topic: {{topic}}{{#audience}}\nAudience: {{audience}}{{/audience}}\n\n'),
    productTemplate('wiki.generate_page', 'Wiki: draft a page', 'Draft one wiki page: summary, sections and infobox values, each cited.', 'wiki.generate',
        'Page title: {{title}}{{#space}}\nSpace: {{space}}{{/space}}{{#outline}}\nRequested outline: {{json outline}}{{/outline}}\n\n'),
    productTemplate('blog.draft_post', 'Blog: draft a post', 'Draft a blog post in Markdown for the brief. Claims of fact must cite sources; opinion and framing need none. If there are no sources, write only what needs no facts and list the facts you would need in gaps.', 'blog.draft',
        'Topic: {{topic}}{{#brief}}\nBrief: {{brief}}{{/brief}}{{#tone}}\nTone: {{tone}}{{/tone}}{{#audience}}\nAudience: {{audience}}{{/audience}}\n\n'),
    productTemplate('news.summarize_story', 'News: summarize a story', 'Write a neutral, factual summary of the story the sources report: a headline, a summary, key points and a timeline, all cited. Attribute contested claims to their source.', 'news.summarize',
        '{{#topic}}Topic: {{topic}}\n\n{{/topic}}'),
    productTemplate('news.compare_perspectives', 'News: compare perspectives', 'Group the sources into distinct perspectives on the question, summarize each fairly in its own terms, and list where they agree and disagree. Do not pick a winner.', 'news.summarize',
        'Question or topic: {{topic}}\n\n'),
    productTemplate('reviews.summarize_entity', 'Reviews: summarize an entity', 'Summarize what the review signals say about the entity: themes, pros and cons, each cited, and how strong the coverage is. Never produce or imply a star rating or aggregate score.', 'reviews.summarize',
        'Entity: {{entity.name}}{{#entity.type}} ({{entity.type}}){{/entity.type}}\n\n'),
    productTemplate('deals.enrich_deal', 'Deals: enrich a deal', 'Normalise the offer: product identity, category, price, shipping, condition and availability — only what the sources state, with the observation time of the price. A missing price stays null.', 'deals.enrich',
        'Offer as submitted:\n{{json offer}}\n\n'),
    productTemplate('coupons.extract_coupon', 'Coupons: extract coupons', 'Extract every coupon code the sources state, with its restrictions and expiry. If the expiry is not stated, expires_at is null and expiry_known is false. Never mark a code as working; validity is decided by reports, not by you.', 'coupons.extract',
        '{{#merchant}}Merchant: {{json merchant}}\n\n{{/merchant}}'),
    productTemplate('trade.summarize_market_context', 'Trade: market context', 'Summarize the sourced market and filing context for the instrument. Every observation carries the observation time from its source. Flag sources older than the staleness window as stale. Informational only: no advice, no predictions, no recommendations.', 'trade.summarize',
        'Instrument: {{json instrument}}{{#stale_after_hours}}\nStaleness window: {{stale_after_hours}} hours{{/stale_after_hours}}\n\n'),
    productTemplate('codes.generate_docs', 'Codes: generate documentation', 'Write developer documentation for the project from the provided source files: an overview and sections in Markdown. Cite the files each section describes. Do not document behaviour the files do not show.', 'codes.generate_docs',
        'Project: {{project}}{{#audience}}\nAudience: {{audience}}{{/audience}}\n\n'),
    productTemplate('games.generate_lore', 'Games: generate lore', 'Write lore for the world that stays consistent with the canon sources (cite them where you rely on them), and list any contradiction with canon you had to resolve. Invented fiction is expected here; invented canon citations are not.', 'games.generate_lore',
        'World: {{world}}\nRequest: {{prompt}}\n\n'),
    productTemplate('moderation.classify', 'Moderation: classify content', 'Classify the content under OpenVibe policy. Profanity, insults, crude jokes and trash talk are ALLOWED and are not violations. Flag only: credible threats of violence, any sexual content involving minors, doxxing (sharing private personal information), targeted harassment campaigns, spam/scams, sexual content where not allowed, and self-harm encouragement. Quote the exact spans you flag. When unsure, choose review, not block.', 'moderation.classify',
        '{{#context}}Context: {{context}}\n\n{{/context}}Content to classify:\n"""\n{{text}}\n"""\n\n'),
];

const workflows = [
    {
        key: 'wiki.generate_space', name: 'Propose a wiki space', namespace: 'wiki',
        input_schema: OBJ({ topic: STR(300), audience: STR(300), sources: SOURCES(1) }, ['topic', 'sources']),
        output_schema: OBJ({ title: STR(200), summary: STR(2000), pages: ARR(OBJ({ title: STR(200), slug_hint: STR(120), outline: ARR(STR(300), 20), citations: CITES }), 40), citations: CITES, gaps: GAPS }),
        default_route: 'wiki.generate',
    },
    {
        key: 'wiki.generate_page', name: 'Draft a wiki page', namespace: 'wiki',
        input_schema: OBJ({ title: STR(300), space: STR(300), outline: ARR(STR(300), 30), sources: SOURCES(1) }, ['title', 'sources']),
        output_schema: OBJ({ title: STR(300), summary: STR(2000), sections: ARR(OBJ({ heading: STR(200), body: STR(20000), citations: CITES }), 40), infobox: ARR(OBJ({ key: STR(100), value: STR(500), citations: CITES }), 30), citations: CITES, gaps: GAPS }),
        default_route: 'wiki.generate',
    },
    {
        key: 'blog.draft_post', name: 'Draft a blog post', namespace: 'blog',
        input_schema: OBJ({ topic: STR(300), brief: STR(4000), tone: STR(200), audience: STR(300), sources: SOURCES(0) }, ['topic']),
        output_schema: OBJ({ title: STR(200), dek: STR(400), body_markdown: STR(40000), tags: ARR(STR(40), 10), citations: CITES, gaps: GAPS }),
        default_route: 'blog.draft',
    },
    {
        key: 'news.summarize_story', name: 'Summarize a news story', namespace: 'news',
        input_schema: OBJ({ topic: STR(300), sources: SOURCES(1) }, ['sources']),
        output_schema: OBJ({ headline: STR(200), summary: STR(3000), key_points: ARR(CLAIM, 20), timeline: ARR(OBJ({ when: STR(60), what: STR(500), citations: CITES }), 30), citations: CITES, gaps: GAPS }),
        default_route: 'news.summarize',
    },
    {
        key: 'news.compare_perspectives', name: 'Compare perspectives on a story', namespace: 'news',
        input_schema: OBJ({ topic: STR(300), sources: SOURCES(2) }, ['topic', 'sources']),
        output_schema: OBJ({ question: STR(300), perspectives: ARR(OBJ({ label: STR(120), summary: STR(2000), citations: CITES }), 10), agreements: ARR(CLAIM, 10), disagreements: ARR(CLAIM, 10), citations: CITES, gaps: GAPS }),
        default_route: 'news.summarize',
    },
    {
        key: 'reviews.summarize_entity', name: 'Summarize review signals for an entity', namespace: 'reviews',
        input_schema: OBJ({ entity: OBJ({ name: STR(200), type: STR(80) }, ['name']), sources: SOURCES(1) }, ['entity', 'sources']),
        output_schema: OBJ({ summary: STR(2000), themes: ARR(STR(80), 12), pros: ARR(CLAIM, 12), cons: ARR(CLAIM, 12), coverage: { enum: ['weak', 'moderate', 'strong'] }, citations: CITES, gaps: GAPS }),
        default_route: 'reviews.summarize',
    },
    {
        key: 'deals.enrich_deal', name: 'Enrich a deal', namespace: 'deals',
        input_schema: OBJ({ offer: { type: 'object', required: ['title'], properties: { title: STR(300), url: STR(2048), price: {}, currency: STR(8), merchant: STR(200) } }, sources: SOURCES(1) }, ['offer', 'sources']),
        output_schema: OBJ({
            title: STR(300),
            product: OBJ({ name: STR(300), brand: { type: ['string', 'null'], maxLength: 120 }, model: { type: ['string', 'null'], maxLength: 120 } }),
            category: STR(80),
            price: OBJ({ amount: { type: ['number', 'null'] }, currency: { type: ['string', 'null'], maxLength: 8 }, observed_at: { type: ['string', 'null'], maxLength: 40 }, citations: CITES }),
            shipping: { type: ['string', 'null'], maxLength: 300 },
            condition: { enum: ['new', 'used', 'refurbished', 'unknown'] },
            availability: { enum: ['in_stock', 'limited', 'out_of_stock', 'unknown'] },
            summary: STR(1000), citations: CITES, gaps: GAPS,
        }),
        default_route: 'deals.enrich',
    },
    {
        key: 'coupons.extract_coupon', name: 'Extract coupons', namespace: 'coupons',
        input_schema: OBJ({ merchant: { type: 'object', properties: { name: STR(200), domain: STR(253) } }, sources: SOURCES(1) }, ['sources']),
        output_schema: OBJ({
            coupons: ARR(OBJ({ code: STR(64), description: STR(500), restrictions: ARR(STR(300), 10), expires_at: { type: ['string', 'null'], maxLength: 40 }, expiry_known: { type: 'boolean' }, min_spend: { type: ['string', 'null'], maxLength: 60 }, citations: CITES }), 30),
            citations: CITES, gaps: GAPS,
        }),
        default_route: 'coupons.extract',
    },
    {
        key: 'trade.summarize_market_context', name: 'Summarize market context (informational)', namespace: 'trade',
        input_schema: OBJ({ instrument: { type: 'object', required: ['symbol'], properties: { symbol: STR(32), name: STR(200), exchange: STR(40) } }, stale_after_hours: { type: 'integer', minimum: 1, maximum: 8760 }, sources: SOURCES(1) }, ['instrument', 'sources']),
        output_schema: OBJ({
            summary: STR(3000),
            observations: ARR(OBJ({ text: STR(600), observed_at: { type: ['string', 'null'], maxLength: 40 }, citations: CITES }), 30),
            stale_sources: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 50 },
            disclaimer: { const: 'Informational only; not investment advice.' },
            citations: CITES, gaps: GAPS,
        }),
        default_route: 'trade.summarize',
    },
    {
        key: 'codes.generate_docs', name: 'Generate documentation from code', namespace: 'codes',
        input_schema: OBJ({ project: STR(200), audience: STR(200), sources: SOURCES(1) }, ['project', 'sources']),
        output_schema: OBJ({ title: STR(200), overview: STR(4000), sections: ARR(OBJ({ heading: STR(200), body_markdown: STR(20000), citations: CITES }), 40), citations: CITES, gaps: GAPS }),
        default_route: 'codes.generate_docs',
    },
    {
        key: 'games.generate_lore', name: 'Generate game lore', namespace: 'games',
        input_schema: OBJ({ world: STR(200), prompt: STR(4000), sources: SOURCES(0) }, ['world', 'prompt']),
        output_schema: OBJ({ title: STR(200), lore_markdown: STR(20000), entities: ARR(OBJ({ name: STR(120), kind: STR(60), description: STR(1000) }), 30), contradictions: ARR(STR(500), 10), citations: CITES, gaps: GAPS }),
        default_route: 'games.generate_lore',
    },
    {
        key: 'moderation.classify', name: 'Classify content for moderation', namespace: 'moderation',
        input_schema: OBJ({ text: STR(8000), context: STR(1000), sources: SOURCES(0) }, ['text']),
        output_schema: OBJ({
            labels: { type: 'array', maxItems: 8, items: { enum: ['threat', 'minors', 'doxxing', 'harassment', 'spam', 'sexual', 'self_harm', 'none'] } },
            action: { enum: ['allow', 'review', 'block'] },
            severity: { enum: ['none', 'low', 'medium', 'high'] },
            rationale: STR(1000),
            spans: ARR(OBJ({ quote: STR(500), label: STR(40) }), 20),
            citations: CITES,
        }),
        default_route: 'moderation.classify', cache_mode: 'private',
    },
].map(w => ({
    cache_mode: 'private',
    ...w,
    steps: [{ kind: 'llm', template: w.key, operation: w.key === 'moderation.classify' ? 'classify' : 'generate', output: 'json', prepare: 'sources', cite: true, params: { max_tokens: 2400, temperature: 0.3 } }],
    metadata: { draft: true, seed: true },
}));

module.exports = { templates, workflows };
