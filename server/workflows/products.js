'use strict';
/**
 * Seed workflows the publication products consume (plan §15.13). Every one returns a DRAFT /
 * EVIDENCE package — never publication truth — with citations that index into the numbered
 * input.sources, plus `gaps` for what the sources do not support. The owning product (Wiki,
 * Blog, News, Reviews, Deals, Coupons, Trade, Codes, Games, Tools, Food) decides what to publish.
 *
 * Hard rules carried into the prompts and the schemas:
 *   - no invented facts, prices, ratings, dates, quotes (Reviews has no rating field at all;
 *     Deals' price is null unless cited; Coupons' unknown expiry stays unknown)
 *   - Trade is informational only (fixed disclaimer, observation timestamps, stale sources flagged)
 *   - moderation follows OpenVibe policy: profanity is allowed; threats, minors and doxxing are not
 */
const { SOURCES, CITES, GAPS, IMAGE } = require('./common-schemas');

const STR = (n) => ({ type: 'string', maxLength: n });
const OBJ = (props, required) => ({ type: 'object', additionalProperties: false, required: required || Object.keys(props), properties: props });
const ARR = (items, max = 20) => ({ type: 'array', items, maxItems: max });
const CLAIM = OBJ({ text: STR(600), citations: CITES });
// What a wiki page is about (wiki.generate_space): the wiki's own page groups follow from it.
const PAGE_KINDS = ['overview', 'character', 'person', 'episode', 'season', 'work', 'place', 'group', 'object', 'concept', 'event', 'production', 'reception', 'list', 'other'];

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
    productTemplate('wiki.generate_space', 'Wiki: plan a wiki', 'Plan a wiki about the topic, written like an encyclopedia or a well-kept fan wiki, from the numbered sources. `title`: the wiki\'s name (usually the topic\'s name). `summary`: one paragraph saying what the topic is, cited. `pages`: the main page first, titled exactly as the topic is best known, with kind overview; then the subjects a reader would look up, as many as the sources say enough about, up to {{max_pages}} pages in all: the people or characters, works (episodes, seasons, films, books, games, albums), places, groups, objects, concepts, events, and its production and reception when the sources cover them. Each page: `title` (its usual name; add the topic in brackets only to tell two subjects apart), `kind`, `parent` (the title of another page in this list it belongs under, else an empty string; the main page has none), `outline` (three to six short section headings this page should have), `query` (a short web search phrase that finds this subject, such as "Ron Stoppable Kim Possible"), and `citations`. Only plan subjects the sources name; leave out anything they do not support.', 'wiki.write',
        'Topic: {{topic}}{{#audience}}\nAudience: {{audience}}{{/audience}}\nPages at most: {{max_pages}}\n\n'),
    productTemplate('wiki.generate_page', 'Wiki: write a page', 'Write one page of the wiki from the numbered sources, encyclopedic and engaging, the way a well-kept wiki reads. `summary`: one or two plain sentences saying what the subject is. `lead`: the opening paragraph or two, in Markdown. `sections`: follow the requested outline where the sources support it (skip or merge headings they do not), each with a `heading` and a Markdown `body` of one or more full paragraphs (a list where it reads better), each citing its sources; about 500 to 1500 words in all when the sources allow, shorter when they do not. Link other pages of this wiki, and only titles from the list of pages, as [[Exact Title]] the first time each is mentioned. `infobox`: up to twelve key facts as `label` and `value` (for example First appearance, Voiced by, Created by, Release date, Location), each cited; the Wikidata facts are good material. `images`: up to three pictures from the numbered list of pictures that clearly show this page\'s subject, judged by their title and description (never a picture of something or someone else, and none when no picture fits), each with its `index`, a short factual `caption`, and `section`: the heading it illustrates, or lead for the page\'s main picture. Never write source numbers or "[n]" in the text. Never describe a real person\'s looks, body, clothing or age.', 'wiki.write',
        'Page title: {{title}}\nWiki topic: {{topic}}{{#outline}}\nRequested outline: {{json outline}}{{/outline}}\n\nPages of this wiki (link only these, as [[Title]]):\n{{pages_block}}\n\n{{#images_block}}Pictures (by number):\n{{images_block}}\n\n{{/images_block}}'),
    productTemplate('blog.draft_post', 'Blog: draft a post', 'Draft a blog post in Markdown for the brief. Claims of fact must cite sources; opinion and framing need none. If there are no sources, write only what needs no facts and list the facts you would need in gaps.', 'blog.draft',
        'Topic: {{topic}}{{#brief}}\nBrief: {{brief}}{{/brief}}{{#tone}}\nTone: {{tone}}{{/tone}}{{#audience}}\nAudience: {{audience}}{{/audience}}\n\n'),
    productTemplate('blog.write_digest', 'Blog: write a desk digest', 'Write one digest post for an OpenVibe.Blog desk from the numbered sources (the items its sources published in the period). Pick the items a reader of this desk would most want to know about, about twelve at most, and skip routine, minor or duplicate ones. Group them into two to five sections, most important first. Each section is a list of short paragraphs, one story per paragraph, two to four plain sentences saying what happened and why it matters to this desk\'s readers, exactly as the sources state it; each paragraph lists the numbers of the sources it rests on in its `citations`. Never write source numbers, "(Source n)" or brackets in the text itself. Neutral and readable: no opinion stated as fact, no hype, no advice, no predictions. Name prices, dates and numbers only as the sources give them. List in gaps only what a reader would miss (an item you could not make sense of, a missing date or price). title: a headline naming the one or two biggest stories, at most 90 characters, without the words digest, desk, roundup or snapshot and without a date. dek: one sentence about the period.', 'blog.draft',
        'Desk: {{desk}}{{#about}}\nThe desk covers: {{about}}{{/about}}\nPeriod: {{period}}\n\n'),
    productTemplate('news.summarize_story', 'News: summarize a story', 'Write a neutral, factual summary of the story the sources report: a headline, a summary, key points and a timeline, all cited. Attribute contested claims to their source. The tone, when given, changes the length and the explaining, never the facts or the neutrality: brief is two or three sentences and at most three key points; explained also says, from the sources, what the subject is and why it matters, for someone new to it.', 'news.summarize',
        '{{#topic}}Topic: {{topic}}\n\n{{/topic}}{{#tone}}Tone: {{tone}}\n\n{{/tone}}'),
    productTemplate('news.compare_perspectives', 'News: compare perspectives', 'Group the sources into distinct perspectives on the question, summarize each fairly in its own terms, and list where they agree and disagree. Do not pick a winner.', 'news.summarize',
        'Question or topic: {{topic}}\n\n'),
    productTemplate('reviews.summarize_entity', 'Reviews: summarize an entity', 'Summarize what the review signals say about the entity: themes, pros and cons, each cited, and how strong the coverage is. Never produce or imply a star rating or aggregate score.', 'reviews.summarize',
        'Entity: {{entity.name}}{{#entity.type}} ({{entity.type}}){{/entity.type}}\n\n'),
    productTemplate('deals.enrich_deal', 'Deals: enrich a deal', 'Normalise the offer: product identity, category, price, shipping, condition and availability — only what the sources state, with the observation time of the price. A missing price stays null.', 'deals.enrich',
        'Offer as submitted:\n{{json offer}}\n\n'),
    productTemplate('coupons.extract_coupon', 'Coupons: extract coupons', 'Extract every coupon code the sources state, with its restrictions and expiry. If the expiry is not stated, expires_at is null and expiry_known is false. Never mark a code as working; validity is decided by reports, not by you.', 'coupons.extract',
        '{{#merchant}}Merchant: {{json merchant}}\n\n{{/merchant}}'),
    productTemplate('trade.summarize_market_context', 'Trade: market context', 'Summarize the sourced market and filing context for the instrument. Return: summary (two to four plain sentences on what the latest figures and filings show, such as the latest period\'s numbers next to the same period a year before, exactly as the sources state them); observations (one per notable figure or filing: text, observed_at as the period end or date the source gives, and citations); stale_sources (the numbers of sources older than the staleness window); disclaimer (exactly "Informational only; not investment advice."); citations; gaps. Do arithmetic only on numbers the sources give, and say what you compared. Every observation carries the observation time from its source. Informational only: no advice, no predictions, no recommendations, no price targets.', 'trade.summarize',
        'Instrument: {{json instrument}}{{#stale_after_hours}}\nStaleness window: {{stale_after_hours}} hours{{/stale_after_hours}}\n\n'),
    productTemplate('codes.generate_docs', 'Codes: generate documentation', 'Write developer documentation for the project from the provided source files: an overview and sections in Markdown. Cite the files each section describes. Do not document behaviour the files do not show.', 'codes.generate_docs',
        'Project: {{project}}{{#audience}}\nAudience: {{audience}}{{/audience}}\n\n'),
    productTemplate('games.generate_lore', 'Games: generate lore', 'Write lore for the world that stays consistent with the canon sources (cite them where you rely on them), and list any contradiction with canon you had to resolve. Invented fiction is expected here; invented canon citations are not.', 'games.generate_lore',
        'World: {{world}}\nRequest: {{prompt}}\n\n'),
    productTemplate('tools.describe', 'Tools: describe a tool', 'Describe one OpenVibe tool for the people who use it, from its descriptor (the numbered sources: its registry entry, inputs, outputs and limits): a one-line summary, what it does, how to use it step by step, what each input and output means, its limits, and a short FAQ. Cite the descriptor fields each statement rests on. Do not claim formats, sizes or features the descriptor does not list; say what is unknown in gaps.', 'tools.describe',
        'Tool: {{tool}}{{#audience}}\nAudience: {{audience}}{{/audience}}\n\n'),
    productTemplate('food.suggest_recipes', 'Food: suggest recipes', 'Suggest up to three simple, low-cost recipes the person can cook, built first from their pantry. An ingredient from the pantry has from_pantry true and needs no citation. Every other ingredient must be one of the foods in the numbered sources (OpenVibe.Food\'s food list) and cite it; if a recipe needs something the sources do not list, leave that recipe out and name the missing food in gaps. State amounts in everyday units. Never state prices, calories, nutrition or health claims: the app works out costs from its own data. Keep steps short and safe (cook meat, poultry and eggs through).', 'food.suggest',
        'Pantry: {{json pantry}}{{#people}}\nCooking for: {{people}}{{/people}}{{#ask}}\nRequest: {{ask}}{{/ask}}\n\n'),
    productTemplate('rent.screen_listing', 'Rent: screen a listing for scam signs', 'Read one rental listing a person posted and say whether a member of staff should look at it for the signs of a rental scam. The signs: asking for a deposit, rent or any payment before the place can be viewed (payment_before_viewing); asking to pay by wire transfer, gift cards, cryptocurrency or a payment app sent to a stranger (unusual_payment); an owner who is abroad or otherwise cannot show the place in person (owner_unavailable); pressure to decide or pay at once, such as many other applicants or today only (pressure); asking for identity documents, a social security number or bank details before any viewing (personal_data_request); moving the conversation to a private email or messaging app while refusing calls or visits (off_platform_only). A low price alone is not a sign: you cannot know the area. Ordinary rules (no pets, references, a deposit paid at signing, proof of income at application) are not signs. Quote the exact words behind each sign you name. When no sign is clearly present, answer allow with signals none; choose review only when the words show at least one sign.', 'rent.screen',
        'Listing:\n"""\n{{json listing}}\n"""\n\n'),
    productTemplate('moderation.classify', 'Moderation: classify content', 'Classify the content under OpenVibe policy. Profanity, insults, crude jokes and trash talk are ALLOWED and are not violations. Flag only: credible threats of violence, any sexual content involving minors, doxxing (sharing private personal information), targeted harassment campaigns, spam/scams, sexual content where not allowed, and self-harm encouragement. Quote the exact spans you flag. When unsure, choose review, not block.', 'moderation.classify',
        '{{#context}}Context: {{context}}\n\n{{/context}}Content to classify:\n"""\n{{text}}\n"""\n\n'),
];

const workflows = [
    {
        key: 'wiki.generate_space', name: 'Plan a wiki', namespace: 'wiki',
        input_schema: OBJ({ topic: STR(300), audience: STR(300), max_pages: { type: 'integer', minimum: 1, maximum: 40 }, sources: SOURCES(1) }, ['topic', 'sources']),
        output_schema: OBJ({
            title: STR(200), summary: STR(2000),
            pages: ARR(OBJ({ title: STR(200), kind: { enum: PAGE_KINDS }, parent: STR(200), outline: ARR(STR(120), 8), query: STR(160), citations: CITES }), 40),
            citations: CITES, gaps: GAPS,
        }),
        default_route: 'wiki.write',
        steps: [{ kind: 'llm', template: 'wiki.generate_space', operation: 'generate', output: 'json', prepare: 'wiki.space', cite: true, params: { max_tokens: 4000, temperature: 0.3, timeout_ms: 150000 } }],
    },
    {
        key: 'wiki.generate_page', name: 'Write a wiki page', namespace: 'wiki',
        input_schema: OBJ({
            title: STR(300), topic: STR(300), space: STR(300), outline: ARR(STR(300), 30), pages: ARR(STR(200), 60),
            images: ARR(OBJ({ title: STR(300), description: STR(400) }, ['title']), 16), sources: SOURCES(1),
        }, ['title', 'sources']),
        output_schema: OBJ({
            title: STR(300), summary: STR(500), lead: STR(6000),
            sections: ARR(OBJ({ heading: STR(160), body: STR(12000), citations: CITES }), 14),
            infobox: ARR(OBJ({ label: STR(60), value: STR(300), citations: CITES }), 14),
            images: ARR(OBJ({ index: { type: 'integer', minimum: 0, maximum: 15 }, caption: STR(300), section: STR(160) }), 3),
            citations: CITES, gaps: GAPS,
        }),
        default_route: 'wiki.write',
        steps: [{ kind: 'llm', template: 'wiki.generate_page', operation: 'generate', output: 'json', prepare: 'wiki.page', cite: true, params: { max_tokens: 7000, temperature: 0.4, timeout_ms: 170000 } }],
    },
    {
        key: 'blog.draft_post', name: 'Draft a blog post', namespace: 'blog',
        input_schema: OBJ({ topic: STR(300), brief: STR(4000), tone: STR(200), audience: STR(300), sources: SOURCES(0) }, ['topic']),
        output_schema: OBJ({ title: STR(200), dek: STR(400), body_markdown: STR(40000), tags: ARR(STR(40), 10), citations: CITES, gaps: GAPS }),
        default_route: 'blog.draft',
    },
    {
        // OpenVibe.Blog's AI desks (server/desks.js): a digest of what a desk's sources published, each section cited.
        key: 'blog.write_digest', name: 'Write a desk digest', namespace: 'blog',
        input_schema: OBJ({ desk: STR(120), about: STR(400), period: STR(120), sources: SOURCES(2) }, ['desk', 'period', 'sources']),
        output_schema: OBJ({ title: STR(200), dek: STR(400), sections: ARR(OBJ({ heading: STR(160), paragraphs: ARR(CLAIM, 8) }), 6), citations: CITES, gaps: GAPS }),
        default_route: 'blog.draft',
    },
    {
        key: 'news.summarize_story', name: 'Summarize a news story', namespace: 'news',
        // tone (OpenVibe.News' reader control): brief (two or three sentences), neutral (the default), explained (for
        // someone new to the subject: what it is and why it matters, still only from the sources).
        input_schema: OBJ({ topic: STR(300), tone: { enum: ['brief', 'neutral', 'explained'] }, sources: SOURCES(1) }, ['sources']),
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
        key: 'tools.describe', name: 'Describe a tool', namespace: 'tools',
        input_schema: OBJ({ tool: STR(120), audience: STR(200), sources: SOURCES(1) }, ['tool', 'sources']),
        output_schema: OBJ({
            summary: STR(300), description_markdown: STR(6000),
            how_to: ARR(OBJ({ step: STR(600), citations: CITES }), 15),
            fields: ARR(OBJ({ name: STR(120), direction: { enum: ['input', 'output'] }, meaning: STR(600), citations: CITES }), 40),
            limits: ARR(CLAIM, 15), faq: ARR(OBJ({ question: STR(300), answer: STR(1200), citations: CITES }), 12),
            citations: CITES, gaps: GAPS,
        }),
        default_route: 'tools.describe',
    },
    {
        key: 'food.suggest_recipes', name: 'Suggest recipes from a pantry', namespace: 'food',
        input_schema: OBJ({ pantry: ARR(STR(120), 60), people: { type: 'integer', minimum: 1, maximum: 12 }, ask: STR(500), sources: SOURCES(1) }, ['pantry', 'sources']),
        output_schema: OBJ({
            recipes: ARR(OBJ({
                title: STR(160), serves: { type: 'integer', minimum: 1, maximum: 12 }, minutes: { type: 'integer', minimum: 1, maximum: 600 },
                ingredients: ARR(OBJ({ name: STR(120), amount: STR(80), from_pantry: { type: 'boolean' }, citations: CITES }), 25),
                steps: ARR(STR(600), 20), notes: STR(600),
            }), 3),
            citations: CITES, gaps: GAPS,
        }),
        default_route: 'food.suggest',
    },
    {
        key: 'rent.screen_listing', name: 'Screen a rental listing for scam signs', namespace: 'rent',
        input_schema: OBJ({
            listing: OBJ({ title: STR(200), kind: STR(40), price: { type: 'number' }, currency: STR(8), period: STR(20), city: STR(120), country: STR(8), description: STR(5000) }, ['title']),
            sources: SOURCES(0),
        }, ['listing']),
        output_schema: OBJ({
            signals: { type: 'array', maxItems: 7, items: { enum: ['payment_before_viewing', 'unusual_payment', 'owner_unavailable', 'pressure', 'personal_data_request', 'off_platform_only', 'none'] } },
            action: { enum: ['allow', 'review'] },
            rationale: STR(1000),
            spans: ARR(OBJ({ quote: STR(500), signal: STR(40) }), 20),
            citations: CITES,
        }),
        default_route: 'rent.screen', cache_mode: 'private',
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
    steps: w.steps || [{ kind: 'llm', template: w.key, operation: w.key === 'moderation.classify' || w.key === 'rent.screen_listing' ? 'classify' : 'generate', output: 'json', prepare: 'sources', cite: true, params: { max_tokens: 2400, temperature: 0.3 } }],
    metadata: { draft: true, seed: true },
}));

// Food's cupboard by photo or receipt (OpenVibe.Food /pantry/photo): a picture, not sources, so it has its own step.
templates.push({
    key: 'food.read_pantry_photo', name: 'Food: read a cupboard photo or a grocery receipt',
    description: 'Which foods from OpenVibe.Food\'s list one photo clearly shows: a cupboard, fridge or shelf, or a grocery receipt.',
    input_schema: { type: 'object' }, output_schema: { type: 'object' },
    system_prompt: 'You read one photo for OpenVibe.Food: a cupboard, fridge or shelf, or a grocery receipt. Say which foods from the numbered list it clearly shows, by their numbers in `items` (each number once). On a receipt a line names a food when its words or a usual receipt abbreviation do ("BNLS CHKN BRST" is chicken breasts, "LG EGGS 12CT" is eggs). Never guess at something you cannot see or read. Put foods you do see that are not on the list in `unlisted` (short names). `seen` says what you saw for that item, in a few words ("a carton of 12 eggs", "receipt line: GV WHL MILK"). confidence: high when the label or the receipt line is plain, medium when it is likely, low otherwise. Never write out prices, totals, card numbers, store names or addresses, loyalty numbers, names or anything else personal on a receipt. Output only JSON matching the schema.',
    user_prompt: 'This photo is a {{kind}}.\n\nThe list (number: food):\n{{foods_block}}',
    default_route: 'food.vision', owner: 'food', metadata: { json_name: 'food_read_pantry_photo' },
});
workflows.push({
    key: 'food.read_pantry_photo', name: 'Read a cupboard photo or a receipt', namespace: 'food',
    input_schema: OBJ({ image: IMAGE, kind: { enum: ['shelf', 'receipt'] }, foods: ARR(STR(120), 80) }, ['image', 'foods']),
    output_schema: OBJ({
        items: ARR(OBJ({ food: { type: 'integer', minimum: 0, maximum: 79 }, seen: STR(160), confidence: { enum: ['high', 'medium', 'low'] } }), 60),
        unlisted: ARR(STR(120), 30),
        gaps: GAPS,
    }),
    steps: [{ kind: 'llm', template: 'food.read_pantry_photo', operation: 'generate', output: 'json', image: 'image', image_max_width: 1280, prepare: 'food.read_pantry_photo', params: { max_tokens: 1200, temperature: 0.1 } }],
    default_route: 'food.vision',
    // A person's photo: never shared between callers (the stored run keeps only the image's hash, server/runs.js).
    cache_mode: 'none',
    metadata: { seed: true },
});

// OpenVibe.Pics: alt text, a caption and tags for one picture (accessibility, embeds and finding your own pictures).
templates.push({
    key: 'pics.describe_image', name: 'Pics: describe a picture',
    description: 'Alt text, a short caption and tags for one picture on OpenVibe.Pics.',
    input_schema: { type: 'object' }, output_schema: { type: 'object' },
    system_prompt: 'You describe one picture for OpenVibe.Pics so people who cannot see it know what it shows. alt: one plain sentence of at most 140 characters saying what the picture shows (never "image of" or "picture of"). caption: one or two sentences with the detail a sighted person would notice first. tags: up to six short lowercase words for what is in it. Describe only what is visible. Never name or guess who a real person is, and never read out personal details shown in it (names, addresses, number plates, phone numbers, faces of children described by age or appearance beyond "a child"). If it shows text, say what kind of text it is rather than quoting personal parts. Output only JSON matching the schema.',
    user_prompt: '{{#title}}The uploader titled it: {{title}}\n{{/title}}Describe the picture.',
    default_route: 'pics.vision', owner: 'media-hub', metadata: { json_name: 'pics_describe_image' },
});
workflows.push({
    key: 'pics.describe_image', name: 'Describe a picture', namespace: 'pics',
    input_schema: OBJ({ image: IMAGE, title: STR(120) }, ['image']),
    output_schema: OBJ({ alt: STR(160), caption: STR(400), tags: ARR(STR(30), 6), gaps: GAPS }),
    steps: [{ kind: 'llm', template: 'pics.describe_image', operation: 'generate', output: 'json', image: 'image', image_max_width: 1024, prepare: 'pics.describe_image', params: { max_tokens: 400, temperature: 0.2 } }],
    default_route: 'pics.vision',
    // A person's picture: never shared between callers (the stored run keeps only the image's hash).
    cache_mode: 'none',
    metadata: { seed: true },
});

// OpenVibe.Blog's satire desk ("Is This Real?"): invented on purpose, so it is not a sourced evidence package and has its
// own rules. The page labels every post as satire written by AI; the rules keep the jokes away from real people.
templates.push({
    key: 'blog.write_satire', name: 'Blog: write a satire post',
    description: 'An absurd, plainly fictional mock-explainer for OpenVibe.Blog\'s satire desk.',
    input_schema: { type: 'object' }, output_schema: { type: 'object' },
    system_prompt: 'You write for "Is This Real?", OpenVibe.Blog\'s satire desk: absurd, deadpan mock-explainers that treat a ridiculous question as if it were a serious public-health or consumer issue, in the style of an earnest internet explainer that has completely lost the plot. Escalate the absurdity section by section; invented studies, invented institutes and invented experts with obviously silly names are the joke. Rules you never break: the piece must be plainly fiction to any reader; never name, quote or describe a real living person, and never put words in the mouth of a real company, brand, government body or organisation; no jokes about real tragedies, victims, illness, minors, or any group of people by race, religion, gender, sexuality or disability; never give steps, amounts or methods for anything dangerous (drugs, weapons, self-harm, dangerous stunts), even as a joke, and when the topic brushes against one, the punchline is that nobody should try it; no slurs. Profanity is allowed but use it sparingly. title: the question, as a headline. dek: one deadpan sentence in the voice of the piece (never a description of the piece). body_markdown: 350 to 700 words in Markdown with two to four ## sections; no title heading. tags: up to five lower-case words. Output only JSON matching the schema.',
    user_prompt: 'Question: {{topic}}{{#angle}}\nAngle: {{angle}}{{/angle}}',
    default_route: 'blog.draft', owner: 'blog', metadata: { json_name: 'blog_write_satire' },
});
workflows.push({
    key: 'blog.write_satire', name: 'Write a satire post', namespace: 'blog',
    input_schema: OBJ({ topic: STR(300), angle: STR(300) }, ['topic']),
    output_schema: OBJ({ title: STR(200), dek: STR(300), body_markdown: STR(12000), tags: ARR(STR(40), 5) }),
    steps: [{ kind: 'llm', template: 'blog.write_satire', operation: 'generate', output: 'json', params: { max_tokens: 2400, temperature: 0.9 } }],
    default_route: 'blog.draft',
    cache_mode: 'private',
    metadata: { seed: true },
});

module.exports = { templates, workflows };
