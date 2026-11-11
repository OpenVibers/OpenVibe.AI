'use strict';
/**
 * Job classes for the GPU provisioner (2026-11-11): a job is `interactive` or `batch`.
 *
 * Interruptible capacity may take a batch job only when the job says where it resumes from (its
 * checkpoint). A batch job without one, and every interactive job, runs on non-interruptible
 * capacity only. The choice is deterministic: class first (a provider that does not serve the class
 * is out), then the hourly cost, then the owner's provider order, then the offer id.
 *
 * These are pure functions: no database, no network, no money. The provisioner applies them to the
 * offers its adapters return and to the owner's policy rows (server/gpu/policy.js).
 */
const { AiError } = require('../util');

const JOB_CLASSES = Object.freeze(['interactive', 'batch']);
const DEFAULT_CLASS = 'interactive';
const CHECKPOINT_MAX = 500;

function classOf(value) {
    if (value == null || value === '') return DEFAULT_CLASS;
    const key = String(value).trim().toLowerCase();
    if (!JOB_CLASSES.includes(key)) throw new AiError(422, 'gpu.invalid_class', 'a GPU job is interactive or batch');
    return key;
}

/**
 * Where a batch job resumes from. A path, a URL or an explicit storage reference, never a secret: it is
 * stored with the instance row and shown in the console.
 */
function checkpointOf(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw new AiError(422, 'gpu.invalid_checkpoint', 'a checkpoint is a path or URL');
    const text = value.trim();
    if (text.length < 3 || text.length > CHECKPOINT_MAX || /[\u0000-\u001f]/.test(text)) {
        throw new AiError(422, 'gpu.invalid_checkpoint', `a checkpoint must be 3-${CHECKPOINT_MAX} printable characters`);
    }
    return text;
}

/** May this provider take a job of the class at all? */
function providerTakesClass(policy, jobClass) {
    const classes = Array.isArray(policy && policy.classes) && policy.classes.length ? policy.classes : JOB_CLASSES;
    return classes.includes(jobClass);
}

/**
 * Is this offer allowed for the job? An interruptible offer needs all three: a batch job, a declared
 * checkpoint and the owner permitting interruptible capacity for that provider.
 */
function offerAllowed(offer, policy, jobClass, checkpoint) {
    if (!providerTakesClass(policy, jobClass)) return 'the provider is not allowed for ' + jobClass + ' jobs';
    if (!offer || !offer.interruptible) return null;
    if (jobClass !== 'batch') return 'interruptible capacity takes batch jobs only';
    if (!checkpoint) return 'interruptible capacity needs a checkpoint to resume from';
    if (!(policy && policy.interruptible_allowed)) return 'the owner does not allow interruptible capacity on this provider';
    return null;
}

const num = (value, fallback = Infinity) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};
const orderOf = (policy) => (Number.isInteger(policy && policy.order) ? policy.order : 50);

/**
 * Filter the offers for a job and pick the first one under the owner's deterministic rule.
 *
 *   offers   the adapters' offers; each carries marketplace, id, price_per_hour, interruptible
 *   policies a Map (or object) of marketplace key -> the owner's provider policy
 *   jobClass interactive | batch
 *   checkpoint where a batch job resumes, or null
 *   strategy  'cheapest' (cost then order) or 'fastest' (measured latency, then cost, then order)
 *
 * Returns { offers, selected, reasons }: `offers` is the eligible list in the chosen order, so the
 * console can show why the first one won.
 */
function pickOffer(offers, { policies = {}, jobClass = DEFAULT_CLASS, checkpoint = null, strategy = 'cheapest' } = {}) {
    const policyOf = (key) => (policies.get ? policies.get(key) : policies[key]) || null;
    const reasons = [];
    const eligible = [];
    for (const offer of offers || []) {
        const policy = policyOf(offer.marketplace);
        if (policy && policy.configured && policy.enabled === false) { reasons.push(offer.marketplace + ': disabled by the owner'); continue; }
        const why = offerAllowed(offer, policy, jobClass, checkpoint);
        if (why) { reasons.push(offer.marketplace + ': ' + why); continue; }
        eligible.push(offer);
    }
    const price = (offer) => num(offer.price_per_hour);
    const latency = (offer) => num(offer.latency_ms);
    eligible.sort((a, b) => {
        if (strategy === 'fastest') {
            const byLatency = latency(a) - latency(b);
            if (byLatency) return byLatency;
        }
        const byPrice = price(a) - price(b);
        if (byPrice) return byPrice;
        const byOrder = orderOf(policyOf(a.marketplace)) - orderOf(policyOf(b.marketplace));
        if (byOrder) return byOrder;
        return String(a.marketplace + ':' + a.id).localeCompare(String(b.marketplace + ':' + b.id));
    });
    if (!eligible.length) reasons.push('no offer serves the ' + jobClass + ' class' + (jobClass === 'batch' ? (checkpoint ? ' with a checkpoint' : ' on non-interruptible capacity') : ''));
    return {
        offers: eligible,
        selected: eligible[0] || null,
        reasons,
        job_class: jobClass,
        checkpoint,
    };
}

module.exports = { JOB_CLASSES, DEFAULT_CLASS, classOf, checkpointOf, providerTakesClass, offerAllowed, pickOffer };
