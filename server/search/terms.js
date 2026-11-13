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
 */

const AI_PURPOSES = new Set(['internal_quality_measurement', 'public_benchmark', 'model_evaluation', 'model_training']);
const PURPOSES = ['interactive_display', 'answer_grounding', 'agent_research', 'asset_discovery', 'visual_match', 'product_match', 'monitoring', ...AI_PURPOSES];

const BRAVE = {
    reviewed_on: '2026-11-13',
    source: 'https://api-dashboard.search.brave.com/terms-of-service',
    storage: 'transient',
    query_retention: 'unknown',
    ai_use: false,
    resale: 'prohibited',
    clauses: '§3(b)(i): no storing, caching or creating a database of Search Results beyond transient storage for operation; '
        + '§3(b)(xii): no redistributing, reselling or sublicensing Search Results; §3(b)(xiii): no using Search Results to '
        + 'create, evaluate, train, re-train, fine-tune, benchmark or otherwise improve AI models or services.',
};

const TERMS = Object.freeze({
    brave: BRAVE,
    'brave-images': BRAVE,
    exa: {
        reviewed_on: '2026-11-13',
        source: 'https://exa.ai/terms',
        storage: 'unknown',
        query_retention: 'retained',
        ai_use: null,
        resale: 'prohibited',
        clauses: '§1(c): a perpetual licence to host, cache, store and use User Input and Output to provide, develop and '
            + 'improve its products; (e): no reselling, leasing or sublicensing the Services without consent; (f): no using '
            + 'the Services or Output to develop a competing product. Zero data retention is an enterprise agreement.',
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

module.exports = { PURPOSES, AI_PURPOSES, TERMS, purposeOf, termsOf, denial };
