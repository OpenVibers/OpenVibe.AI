'use strict';
/**
 * What each search provider's OWN terms allow, as read on their pages (plan §W.2 step 2, 11-13). Purpose, query
 * retention and storage are routing rules, not labels: an engine whose terms do not allow a request's purpose is never
 * called for it, and the receipt says why.
 *
 * Only what was read is written here, with the page, the day and the clause. A provider not listed is UNREVIEWED: it
 * still serves a person's own searches as before, but never a private request (its query retention is unknown) and
 * never an AI-use purpose (evaluation, benchmarks, training, internal quality measurement). Reviews move to a versioned
 * table fed by Sources and Watch (plan §W.2 step 2); this file is the first reviewed set.
 *
 *   purposeOf(b) → the request's purpose (default interactive_display)
 *   denial(engineId, b) → null, or the skip reason: terms_unreviewed | terms_disallow_purpose | privacy_incompatible |
 *                          retention_incompatible
 *   termsOf(engineId) → the reviewed entry, or null
 *   cacheOf(engineId) → what that provider's own terms allow us to keep: { scope, ttl_s }
 */

/**
 * What a provider's own terms allow us to keep of a search, and for how long (plan §W.2 step 6, 11-14).
 *
 *   none      the terms forbid caching the results at all
 *   same_user the results may be kept for the person who asked, and for nobody else
 *   shared    the terms allow the results to be kept for anyone
 *
 * A provider whose terms were never read is same_user for ten minutes: a short, transient cache that never
 * answers one person with another's results.
 */
const CACHE_SCOPES = Object.freeze(['none', 'same_user', 'shared']);
const DEFAULT_CACHE = Object.freeze({ scope: 'same_user', ttl_s: 600 });

const AI_PURPOSES = new Set(['internal_quality_measurement', 'public_benchmark', 'model_evaluation', 'model_training']);
const PURPOSES = ['interactive_display', 'answer_grounding', 'agent_research', 'asset_discovery', 'visual_match', 'product_match', 'monitoring', ...AI_PURPOSES];

const BRAVE = {
    reviewed_on: '2026-11-13',
    source: 'https://api-dashboard.search.brave.com/terms-of-service',
    storage: 'transient',
    query_retention: 'unknown',
    ai_use: false,
    resale: 'prohibited',
    cache: { scope: 'same_user', ttl_s: 300 },
    cache_clause: '§3(b)(i): no storing, caching or creating a database of Search Results beyond transient storage for '
        + 'operation — a kept result is transient, for the same person, and gone in minutes.',
    clauses: '§3(b)(i): no storing, caching or creating a database of Search Results beyond transient storage for operation; '
        + '§3(b)(xii): no redistributing, reselling or sublicensing Search Results; §3(b)(xiii): no using Search Results to '
        + 'create, evaluate, train, re-train, fine-tune, benchmark or otherwise improve AI models or services.',
};

const TERMS = Object.freeze({
    brave: BRAVE,
    'brave-images': BRAVE,
    perplexity: {
        reviewed_on: '2026-11-13',
        source: 'https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service-search',
        storage: 'unknown',
        query_retention: 'retained',
        ai_use: null,
        resale: 'unknown',
        personal_data: 'written_authorization_required',
        cache: { scope: 'same_user', ttl_s: 600 },
        cache_clause: '§2.2: Perplexity retains and copies Search Data anyway, so the cache only spares the price of a '
            + 'repeat search: the results are kept for the same person, for ten minutes, and never for anyone else.',
        clauses: 'Search Addendum, last updated 2025-09-22. §2.2: Perplexity may retain, copy, distribute and otherwise use '
            + 'Search Data (inputs and outputs) for its lawful business purposes, including improving its products; Search '
            + 'Data is not Customer Confidential Information. §2.3: no Personal Data to the Search Services without written '
            + 'authorization. §1.2.2(iii): zero data retention obligations do not apply to the Search Services.',
    },
    exa: {
        reviewed_on: '2026-11-13',
        source: 'https://exa.ai/terms',
        storage: 'unknown',
        query_retention: 'retained',
        ai_use: null,
        resale: 'prohibited',
        cache: { scope: 'same_user', ttl_s: 600 },
        cache_clause: '§1(c): Exa may host, cache and store the Output anyway, so our cache only spares the price of a '
            + 'repeat search: the results are kept for the same person, for ten minutes, and never for anyone else.',
        clauses: '§1(c): a perpetual licence to host, cache, store and use User Input and Output to provide, develop and '
            + 'improve its products; (e): no reselling, leasing or sublicensing the Services without consent; (f): no using '
            + 'the Services or Output to develop a competing product. Zero data retention is an enterprise agreement.',
    },
    mojeek: {
        reviewed_on: '2026-11-13',
        source: 'https://www.mojeek.com/about/legal/api-terms.html',
        storage: 'one_hour_cache',
        query_retention: 'retained',
        ai_use: true,
        resale: 'allowed',
        cache: { scope: 'same_user', ttl_s: 3600 },
        cache_clause: 'Exclusions 1: "Do not compile, copy or store any Data unless you subscribe to a plan with '
            + 'storage rights. Without storage rights, do not cache any Data except temporarily, to serve the same user, '
            + 'for up to 1 hour." Without storage rights (the Startup plan) the cache is that same person for an hour; '
            + 'a shared cache needs a plan with storage rights (Business or Enterprise).',
        clauses: 'Usage: "Data provided by the Services may be used in any application, including internet search '
            + 'experiences and artificial intelligence applications such as retrieval-augmented generation, grounding, AI '
            + 'agents and assistants, and model evaluation, subject to these Terms. You may reorder the ranking of search '
            + 'results. You may combine Data with search results from other sources." Exclusions: "Do not compile, copy or '
            + 'store any Data unless you subscribe to a plan with storage rights. Without storage rights, do not cache any '
            + 'Data except temporarily, to serve the same user, for up to 1 hour. Do not use Data as part of any search '
            + 'index." Standard retention is 90 days; Zero Data Retention is on request.',
    },
    parallel: {
        reviewed_on: '2026-11-13',
        source: 'https://parallel.ai/customer-terms',
        storage: 'one_customer',
        query_retention: 'unknown',
        ai_use: false,
        resale: 'prohibited',
        cache: { scope: 'none', ttl_s: 0 },
        cache_clause: '§2(b): "Customer Output generated from one query shall be primarily for the use of one End '
            + 'Customer only, and shall not be copied, cached, stored, or made available to other End Customers or other '
            + 'third parties." Parallel forbids caching the output at all, so nothing of it is kept.',
        clauses: '§2(b): Customer Output may be modified and shown to End Customers, but "Customer Output generated from '
            + 'one query shall be primarily for the use of one End Customer only, and shall not be copied, cached, stored, or '
            + 'made available to other End Customers or other third parties." §2(c)(iv): no reselling, sublicensing or '
            + 'otherwise making the Services or Customer Outputs available; §2(c)(vi): no use of the Services or Output to '
            + 'create synthetic training data or to train a model, to build data selling businesses, or for any competitive '
            + 'purpose.',
    },
    you: {
        reviewed_on: '2026-11-13',
        source: 'https://you.com/terms',
        storage: 'unknown',
        query_retention: 'unknown',
        ai_use: false,
        resale: 'prohibited',
        cache: { scope: 'same_user', ttl_s: 600 },
        cache_clause: 'Terms & Conditions, last updated August 27, 2024: nothing may be copied or distributed, and the '
            + 'Output may not be extracted programmatically. The storage rule is not published, so the conservative '
            + 'reading holds: the same person, ten minutes, nobody else.',
        clauses: 'Terms & Conditions, last updated August 27, 2024. Prohibited uses: "modifying, copying, sublicensing, '
            + 'leasing, selling or otherwise distributing any of our Services"; "automatically or programmatically extracting '
            + 'data or Output"; "developing any products or services that compete with our Services". The engine is a '
            + 'person\'s own key only (manual_only).',
    },
    dataforseo: {
        reviewed_on: '2026-11-13',
        source: 'https://dataforseo.com/pricing/',
        storage: 'unknown',
        query_retention: 'unknown',
        ai_use: null,
        resale: 'requires_contract',
        cache: { scope: 'same_user', ttl_s: 600 },
        cache_clause: 'No storage rule is published on the pricing page, and the white-label, MCP and reselling terms '
            + 'need a separate agreement, so the conservative reading holds: the same person, ten minutes, nobody else.',
        clauses: 'The published pricing page states the pay-as-you-go model and the $50 minimum top-up. White label, the '
            + 'MCP server and reselling the raw API need a separate agreement with DataForSEO, so those uses are not '
            + 'cleared for a shared Exchange key.',
    },
});

/**
 * A provider whose CACHE rule is read but whose routing terms are not reviewed yet. Pixabay's API docs require a
 * 24-hour cache, so its results may be shared for a day; it stays unreviewed for routing (no private request, no
 * AI-use purpose) until its own terms are read in full.
 */
const CACHE_ONLY = Object.freeze({
    pixabay: {
        scope: 'shared',
        ttl_s: 86400,
        source: 'https://pixabay.com/api/docs/',
        clause: 'Rate Limit: "To keep the Pixabay API fast for everyone, requests must be cached for 24 hours."',
    },
});

function purposeOf(b) {
    return (b && b.purpose) || 'interactive_display';
}

function termsOf(id) {
    return TERMS[id] || null;
}

function denial(id, b) {
    const t = TERMS[id] || null;
    const purpose = purposeOf(b);
    if (AI_PURPOSES.has(purpose)) {
        if (!t) return 'terms_unreviewed';
        if (t.ai_use !== true) return 'terms_disallow_purpose';
    }
    if (b && b.private === true && !(t && (t.query_retention === 'zero' || t.query_retention === 'transient'))) return 'privacy_incompatible';
    if (purpose === 'monitoring' && t && t.storage === 'transient') return 'retention_incompatible';
    return null;
}

/**
 * What this provider's own terms allow us to keep of a search, and for how long (plan §W.2 step 6, 11-14).
 * A provider whose terms were never read is same_user for ten minutes.
 */
function cacheOf(id) {
    const t = TERMS[id];
    if (t && t.cache) return t.cache;
    const only = CACHE_ONLY[id];
    if (only) return { scope: only.scope, ttl_s: only.ttl_s };
    return DEFAULT_CACHE;
}

module.exports = { PURPOSES, AI_PURPOSES, TERMS, CACHE_ONLY, CACHE_SCOPES, DEFAULT_CACHE, purposeOf, termsOf, denial, cacheOf };
