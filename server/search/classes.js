'use strict';
/**
 * What kind of engine each search adapter is (plan §W.2 step 4, 11-13).
 *
 * A class says what an engine IS, not what it costs. A raw index, a SERP proxy, an answer engine and a page
 * reader do not sell the same thing, so their prices are not comparable: an answer engine that costs a few cents
 * a call must never beat a raw index that costs less than a cent a query just because the numbers happen to sort.
 * Auto therefore keeps the classes the request asked for first (or the kind's default classes), and only then
 * compares price, health and terms inside that set.
 *
 *   first_party_index       an index of the provider's own content (OpenVibe's own services)
 *   independent_index       the provider's own index of the web (Brave, Mojeek, Kagi, Google, DeepSeek, Tavily)
 *   serp_proxy              a proxy to somebody else's results page (SerpApi, Serper, SearchAPI, DataForSEO)
 *   semantic                meaning-first search over its own index (Exa, Parallel)
 *   answer_engine           an engine that answers, with sources (Perplexity, You.com, Meta)
 *   metasearch              other engines' results, gathered (SearXNG)
 *   page_reader             reads a page and returns its text (Jina, OpenVibe's egress)
 *   open_asset_catalog      an open media catalog with the licence it claims (Openverse, Commons, Europeana,
 *                           Smithsonian, NASA)
 *   provider_asset_catalog  the provider's own pictures under its own licence (Unsplash, Pexels, Pixabay)
 *   web_image_discovery     finds where a picture appears and grants nothing (Brave images, the SERP image APIs)
 *   icon_catalog            an icon set (Iconify)
 *   reverse_image           finds the pages that carry an image (TinEye, SerpApi reverse)
 *   visual_web_detection    recognises what is in a picture (Google Vision web detection) - planned
 *   product_visual_search   finds a product from its picture (eBay image search) - planned
 *
 * The class of an adapter is named in the adapter itself (class: beside kinds), and an adapter without a known
 * class is refused when the registry loads: a nameless engine cannot be compared with another one.
 */

const CLASSES = Object.freeze({
    FIRST_PARTY_INDEX: 'first_party_index',
    INDEPENDENT_INDEX: 'independent_index',
    SERP_PROXY: 'serp_proxy',
    SEMANTIC: 'semantic',
    ANSWER_ENGINE: 'answer_engine',
    METASEARCH: 'metasearch',
    PAGE_READER: 'page_reader',
    OPEN_ASSET_CATALOG: 'open_asset_catalog',
    PROVIDER_ASSET_CATALOG: 'provider_asset_catalog',
    WEB_IMAGE_DISCOVERY: 'web_image_discovery',
    ICON_CATALOG: 'icon_catalog',
    REVERSE_IMAGE: 'reverse_image',
    VISUAL_WEB_DETECTION: 'visual_web_detection',
    PRODUCT_VISUAL_SEARCH: 'product_visual_search',
});

const CLASS_NAMES = Object.freeze(Object.values(CLASSES));

// The classes a kind uses when the request names none. A web search is an index, a proxy, OpenVibe's own
// services or a metasearch; an image search is an open catalog, a provider's own pictures or web discovery.
const DEFAULT_CLASSES = Object.freeze({
    web: Object.freeze(['independent_index', 'serp_proxy', 'first_party_index', 'metasearch']),
    images: Object.freeze(['open_asset_catalog', 'provider_asset_catalog', 'web_image_discovery']),
    icons: Object.freeze(['icon_catalog']),
    fetch: Object.freeze(['page_reader']),
    reverse_image: Object.freeze(['reverse_image']),
});

// The classes that answer instead of returning raw results. They are used when the request asks for them, or
// when the request is for an answer or for research; never because they happen to be cheap.
const ANSWERING_CLASSES = Object.freeze(['answer_engine', 'semantic']);
const ANSWERING_PURPOSES = Object.freeze(['answer_grounding', 'agent_research']);

function isClass(value) {
    return typeof value === 'string' && CLASS_NAMES.includes(value);
}

/** The classes the request asked for, as a list; null when it named none. */
function asked(body) {
    if (!body || body.class == null) return null;
    const list = (Array.isArray(body.class) ? body.class : [body.class]).map(String);
    return list.length ? list : null;
}

/**
 * The classes a request may use.
 *   asked    the request named classes: only those.
 *   purpose  answer_grounding and agent_research may use the answering classes as well.
 *   defaults otherwise: the classes the kind uses.
 */
function allowedFor(kind, body) {
    const named = asked(body);
    if (named) return named;
    const base = DEFAULT_CLASSES[kind] ? [...DEFAULT_CLASSES[kind]] : [];
    const purpose = (body && body.purpose) || 'interactive_display';
    if (ANSWERING_PURPOSES.includes(purpose)) return [...base, ...ANSWERING_CLASSES];
    return base;
}

/** The class an adapter belongs to; an adapter without one is refused. */
function classOf(adapter) {
    if (!adapter || !isClass(adapter.class))
        throw new Error('Search adapter "' + (adapter && adapter.id) + '" has no known class (one of ' + CLASS_NAMES.join(', ') + ')');
    return adapter.class;
}

/** Every adapter names a class the catalog knows; the registry refuses the ones that do not. */
function checkAdapters(adapters) {
    for (const a of adapters) classOf(a);
    return adapters.length;
}

module.exports = {
    CLASSES, CLASS_NAMES, DEFAULT_CLASSES, ANSWERING_CLASSES, ANSWERING_PURPOSES,
    isClass, asked, allowedFor, classOf, checkAdapters,
};