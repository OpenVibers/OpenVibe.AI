'use strict';
/**
 * Auto's receipt (plan §V.1 routing item 4: "'Auto' is the default everywhere, and its receipt says what it chose and
 * why"). A run's explain already holds the router's objective and reasons ("objective cheapest", "no marginal cost
 * (already-paid capacity or a free allowance)", "pinned route: …", a reused answer, your own key or computer); this
 * turns them into one short sentence a person reads under an answer:
 *
 *   receiptOf(run) → { chose: 'gpt-5-nano', why: 'the cheapest model that fits this task; it cost nothing extra' } | null
 *
 * Plain words only, never a provider's error or a request's text. null when the run has not answered.
 */
const OBJECTIVE = {
    cheapest: 'the cheapest model that fits this task',
    balanced: 'the best balance of quality, speed and price for this task',
    quality: 'the strongest model for this task',
    fastest: 'the fastest model for this task',
    latency: 'the fastest model for this task',
    'own-key': 'your own key answered: no shared provider was called',
    'own-keys': 'your own keys are tried first',
    'own-machine': 'your own computer answered',
};

const shortModel = (m) => String(m || '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/^.*\//, '') || null;

function receiptOf(run) {
    if (!run) return null;
    const explain = run.explain && typeof run.explain === 'object' ? run.explain : null;
    const prov = run.provenance || {};
    const answered = run.answered && run.answered.model ? run.answered.model : prov.model;
    if (!answered && !prov.cached_from) return null;
    const chose = shortModel(answered);
    const reasons = explain && Array.isArray(explain.reasons) ? explain.reasons.map(String) : [];
    if (prov.cached_from || reasons.some((r) => /reused from run/.test(r))) return { chose, why: 'the same question was answered a moment ago; that answer was reused and no model was called' };
    const parts = [];
    const objective = explain && explain.objective ? String(explain.objective) : '';
    if (OBJECTIVE[objective]) parts.push(OBJECTIVE[objective]);
    else if (reasons.some((r) => /^pinned route/.test(r))) parts.push('the model set for this task');
    else if (run.choice && run.choice.model && run.choice.model !== 'openvibe/auto') parts.push('the model you chose');
    else parts.push('the router\'s pick for this task');
    if (reasons.some((r) => /no marginal cost/.test(r))) parts.push('it cost nothing extra');
    if (prov.fallback_used) parts.push('the first choice did not answer, so the next one did');
    return { chose, why: parts.join('; ') };
}

module.exports = { receiptOf, shortModel };
