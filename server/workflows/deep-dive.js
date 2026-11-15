'use strict';
/**
 * Deep dive (the owner's 11-11 design research): expert research over every search we have, screenshots of the
 * best sites at phone and computer sizes, a vision and a text model reading them, and an ai.deep-dive@1 report
 * that OpenVibe.Exchange shows and OpenVibe.Design can attach. The whole run is one step: server/deep-dive/
 * writes its own seven-step progress, so the page sees Plan, Search, Choose, Capture, Analyse, Synthesise and
 * Report as they happen, and a person can add or drop sites before Capture.
 *
 * No cache: a deep dive is expensive, its screenshots are private to its owner, and its sources change daily.
 * The price shown before the run is held on the tier budgets by POST /api/v1/deep-dives; the real cost is on the
 * run's receipt (and in the report's receipt models).
 */
const { INPUT_SCHEMA, REPORT, RESEARCH_REPORT } = require('../deep-dive/schema');

const workflows = [
    {
        key: 'design.deep_dive', name: 'Deep dive: expert design research', namespace: 'design',
        description: 'Search every source we have, capture the best sites at 390 and 1280 px in light and dark, read them with a vision and a text model, and write an ai.deep-dive@1 report with its evidence and receipts.',
        input_schema: INPUT_SCHEMA,
        output_schema: REPORT,
        steps: [{ kind: 'deep_dive' }],
        default_route: null,
        cache_mode: 'none', cache_ttl_sec: 0,
        metadata: { seed: true, owner: 'exchange', retain_input: true },
    },
    {
        key: 'research.deep_dive', name: 'Deep dive: any question, researched', namespace: 'research',
        description: 'Plan the questions an expert would ask, search every way we have, read the best pages in full, take notes on each, and write an ai.research@1 answer where every claim cites its pages. OpenVibe.Exchange\'s search starts it; OpenVibe.Design\'s design deep dive builds on it.',
        input_schema: INPUT_SCHEMA,
        output_schema: RESEARCH_REPORT,
        steps: [{ kind: 'deep_dive' }],
        default_route: null,
        cache_mode: 'none', cache_ttl_sec: 0,
        metadata: { seed: true, owner: 'exchange', retain_input: true },
    },
];

module.exports = { templates: [], workflows };
