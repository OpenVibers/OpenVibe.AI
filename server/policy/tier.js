'use strict';
/**
 * The content policy of a request (the Exchange remake, "Uncensored"): standard, or uncensored for adults.
 *
 *   standard    what every request gets. An offer marked uncensored never answers it.
 *   uncensored  only for an account that confirmed it is 18+ in OpenVibe.Network (server/policy/adult-status.js),
 *               only to an offer marked uncensored, and always labelled as such in the answer.
 *
 * The rules, in one place:
 *
 *   - a developer app never gets the adult tier (its token is a project's, not a person's);
 *   - the request must name the person it is for (`on_behalf_of`), and Network must say that account is 18+;
 *   - the floor (server/policy/floor.js) holds on every offer, uncensored or not.
 *
 * The tier never widens what a provider may do: it only decides which offers may answer and how the answer is
 * labelled.
 */
const pool = require('../providers/pool-providers');

const POLICIES = ['standard', 'uncensored'];
/** The label every uncensored answer carries (in the answer's metadata, never hidden in the text). */
const LABEL = 'Uncensored model — adults only (18+)';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The policy a request asks for. Unknown values are refused, never quietly treated as standard:
 * → { policy } or { error: 'input.invalid', detail }
 */
function parsePolicy(value) {
    if (value == null || value === '') return { policy: 'standard' };
    const v = String(value).trim().toLowerCase();
    if (!POLICIES.includes(v)) return { error: 'input.invalid', detail: `policy must be one of ${POLICIES.join(', ')}` };
    return { policy: v };
}

/** Is this offer an uncensored one? A provider or a model marked uncensored is (server/providers/pool-providers.js). */
function offerIsUncensored(provider, model) { return pool.isUncensored(provider, model); }

/**
 * May this request run under this policy? The answer is the 18+ gate.
 *
 *   policy     'standard' | 'uncensored'
 *   appRun     true for a developer app's run
 *   subject    the person the request is for ({ type: 'user', id: 'usr_…' }) or null
 *   adultFor   async (id) → boolean, from server/policy/adult-status.js (tests pass their own)
 *
 * → { ok: true, policy, uncensored, subject } or { ok: false, status, code, detail }
 */
async function admit({ policy = 'standard', appRun = false, subject = null, adultFor = null } = {}) {
    if (policy !== 'uncensored') return { ok: true, policy: 'standard', uncensored: false, subject: null };
    if (appRun) {
        return { ok: false, status: 403, code: 'policy.uncensored_refused', detail: 'a developer app may not use the adult tier: it is a project, not a person' };
    }
    const id = subject && subject.type === 'user' ? String(subject.id || '') : '';
    if (!SUBJECT_RE.test(id)) {
        return { ok: false, status: 400, code: 'policy.uncensored_needs_person', detail: 'an uncensored request must name the person it is for (on_behalf_of)' };
    }
    if (typeof adultFor !== 'function') {
        return { ok: false, status: 503, code: 'policy.adult_unavailable', detail: 'the adult account flag is not available on this service' };
    }
    let adult;
    try { adult = await adultFor(id); }
    catch (err) {
        return { ok: false, status: 503, code: 'policy.adult_unavailable', detail: String(err && (err.detail || err.message) || 'the adult account flag could not be read').slice(0, 300) };
    }
    if (!adult) {
        return { ok: false, status: 403, code: 'policy.adult_required', detail: 'the adult tier is for accounts that confirmed they are 18 or older' };
    }
    return { ok: true, policy: 'uncensored', uncensored: true, subject: { type: 'user', id } };
}

module.exports = { POLICIES, LABEL, SUBJECT_RE, parsePolicy, offerIsUncensored, admit };
