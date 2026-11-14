'use strict';
const { schema } = require('openvibe-contracts');
const { validate } = require('../schemas');

/**
 * The search result contracts, and the engine class they do not know yet (plan §W.2 step 4, 11-13).
 *
 * exchange.search-result@1 and exchange.image-result@1 close their receipt to the fields the contract knows.
 * This service now says which class of engine answered (an answer engine is never ranked against a raw index by
 * price alone) and which classes the request allowed, so the receipt has to carry three more fields and two more
 * reason codes: \`class\`, \`classes_allowed\` and \`class_not_considered\` (and the provider-terms codes the terms
 * work already used). OpenVibe.Contracts asks for the same shape; until that pin moves, the response is checked
 * against the shared contract extended here, and the part the shared contract does cover is still checked against
 * the shared contract itself. When the shared contract carries the fields, this file adds nothing.
 */

const RESULT_CONTRACT = { web: 'exchange.search-result@1', images: 'exchange.image-result@1' };

const RECEIPT_FIELDS = {
    class: { type: 'string', minLength: 1, maxLength: 40 },
    classes_allowed: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 8 },
    not_considered: {
        type: 'array', maxItems: 32,
        items: {
            type: 'object', required: ['engine', 'class', 'reason'], additionalProperties: false,
            properties: {
                engine: { type: 'string', minLength: 1, maxLength: 100 },
                class: { type: 'string', minLength: 1, maxLength: 40 },
                reason: { type: 'string', minLength: 1, maxLength: 40 },
            },
        },
    },
    // Receipt v2 (plan §W.2 step 3): the rate card that priced the call, the terms that allowed it, the
    // purpose it was made for, and the hold it reserved beside what it settled. The money is integer
    // nano-USD as text, never a float.
    rate_card: {
        type: 'object', required: ['id', 'version'], additionalProperties: false,
        properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, version: { type: 'integer', minimum: 1 } },
    },
    terms: {
        type: 'object', required: ['reviewed_on'], additionalProperties: false,
        properties: { reviewed_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    },
    purpose: { type: 'string', minLength: 1, maxLength: 40 },
    estimate: {
        type: 'object', required: ['nano_usd'], additionalProperties: false,
        properties: { nano_usd: { type: 'string', pattern: '^\\d+$' } },
    },
    actual: {
        type: 'object', required: ['nano_usd'], additionalProperties: false,
        properties: { nano_usd: { type: 'string', pattern: '^\\d+$' } },
    },
};
const ATTEMPT_FIELDS = { class: { type: 'string', minLength: 1, maxLength: 40 } };
const REASONS = [
    'class_not_considered',
    'terms_unreviewed',
    'terms_disallow_purpose',
    'privacy_incompatible',
    'retention_incompatible',
    'no_rate_card',
];

function contractOf(kind) {
    const { $id, $schema, ...rest } = schema(RESULT_CONTRACT[kind] || RESULT_CONTRACT.web);
    return rest;
}

/** The shared contract with this service's class fields added where the shared contract has none. */
function extended(kind) {
    const s = JSON.parse(JSON.stringify(contractOf(kind)));
    const receipt = s.properties.receipt;
    for (const [name, field] of Object.entries(RECEIPT_FIELDS))
        if (!receipt.properties[name]) receipt.properties[name] = field;
    const attempt = receipt.properties.attempts.items;
    for (const [name, field] of Object.entries(ATTEMPT_FIELDS))
        if (!attempt.properties[name]) attempt.properties[name] = field;
    for (const reason of REASONS)
        if (!attempt.properties.reason.enum.includes(reason)) attempt.properties.reason.enum.push(reason);
    return s;
}

/** The answer without the fields the shared contract does not know: what it does cover, exactly. */
function covered(out) {
    const copy = JSON.parse(JSON.stringify(out));
    const receipt = copy.receipt || {};
    delete receipt.class;
    delete receipt.classes_allowed;
    delete receipt.not_considered;
    delete receipt.rate_card;
    delete receipt.terms;
    delete receipt.purpose;
    delete receipt.estimate;
    delete receipt.actual;
    for (const attempt of receipt.attempts || []) {
        delete attempt.class;
        if (attempt.reason && REASONS.includes(attempt.reason)) delete attempt.reason;
    }
    return copy;
}

/**
 * Is this answer the shape we promise? The whole answer against the extended contract, and the part the shared
 * contract covers against the shared contract, so a change to either is caught.
 */
function check(kind, out) {
    const full = validate(extended(kind), out);
    if (!full.valid) return full;
    return validate(contractOf(kind), covered(out));
}

module.exports = { check, contractOf, extended, covered, REASONS, RECEIPT_FIELDS };