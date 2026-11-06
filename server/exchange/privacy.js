'use strict';
/**
 * The privacy label of an answer: private, anonymized or community (the plan of 2026-11-06: "a privacy
 * label on every answer (Private, Anonymized, Community), as Venice labels models but per request").
 *
 * The label is read off the offer that answered, never guessed:
 *
 *   private      the offer keeps nothing (no retention) and trains on nothing, and it is not a stranger's
 *                machine. A person's own machine is private, and so is an offer on the host's own hardware
 *                (metadata.local): the prompt never leaves the deployment OpenVibe runs.
 *   community    the offer runs on a community machine: that machine sees the prompt (as on AI Horde).
 *   anonymized   everything else: an external provider that may keep what it is sent.
 *
 * A provider that never declared a policy is labelled anonymized and its label says so (known: false):
 * the label is never better than the facts.
 *
 * The policy is declared on the provider record: metadata.data_policy =
 *   { retention: 'none' | 'limited' | 'standard', training: false, region: 'eu', trust: 'first-party' | 'community' }
 */

const LABELS = ['private', 'anonymized', 'community'];
/** A label satisfies a requirement when it is at least as strong as the one asked for. */
const RANK = { private: 0, anonymized: 1, community: 2 };

const labelRank = (label) => (RANK[label] === undefined ? RANK.anonymized : RANK[label]);
/** Does an answer with this label satisfy a requirement? ('community' asks for anything.) */
const satisfies = (label, required) => labelRank(label) <= labelRank(required);

/** The policy a provider record declares, or null when it declares none. */
function dataPolicyOf(record) {
    const meta = (record && record.metadata) || {};
    const p = meta.data_policy;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const retention = ['none', 'limited', 'standard'].includes(String(p.retention)) ? String(p.retention) : null;
    const training = typeof p.training === 'boolean' ? p.training : null;
    const region = typeof p.region === 'string' && p.region.trim() ? p.region.trim().toLowerCase() : null;
    const trust = ['first-party', 'community'].includes(String(p.trust)) ? String(p.trust) : null;
    if (!retention && training === null && !region && !trust) return null;
    return { retention, training, region, trust };
}

/**
 * The label of one answered request.
 *
 *   record      the provider record that answered (its metadata declares the policy)
 *   credential  the person's own key's descriptor, when the answer came from their key or their machine
 */
function labelFor({ record = null, credential = null } = {}) {
    // A person's own machine (a Node credential): the prompt never left their hardware.
    if (credential && credential.provider === 'node') {
        return { label: 'private', retention: 'none', training: false, region: null, trust: 'own_machine', known: true, source: 'your own machine' };
    }
    // The host's own deployment (the local models OpenVibe runs itself): nothing leaves the machine it manages.
    if (record && record.metadata && record.metadata.local === true) {
        return { label: 'private', retention: 'none', training: false, region: null, trust: 'own_deployment', known: true, source: 'OpenVibe\'s own deployment on its own hardware' };
    }
    const policy = dataPolicyOf(record);
    if (!policy) {
        return { label: 'anonymized', retention: null, training: null, region: null, trust: null, known: false, source: 'the provider declares no data policy' };
    }
    const trust = policy.trust || (record && record.metadata && record.metadata.local ? 'community' : 'first-party');
    if (trust === 'community') {
        return { label: 'community', retention: policy.retention, training: policy.training, region: policy.region, trust, known: true, source: 'a community machine sees the prompt' };
    }
    if (policy.retention === 'none' && policy.training === false) {
        return { label: 'private', retention: 'none', training: false, region: policy.region, trust, known: true, source: 'the offer keeps nothing and trains on nothing' };
    }
    return { label: 'anonymized', retention: policy.retention, training: policy.training, region: policy.region, trust, known: true, source: 'the offer may keep what it is sent' };
}

/** The label as it is written on a receipt and in x_openvibe: the class, and the facts behind it. */
function view(privacy) {
    if (!privacy) return null;
    return {
        label: privacy.label,
        retention: privacy.retention == null ? null : privacy.retention,
        training: privacy.training == null ? null : privacy.training,
        region: privacy.region == null ? null : privacy.region,
        trust: privacy.trust == null ? null : privacy.trust,
        known: Boolean(privacy.known),
    };
}

module.exports = { LABELS, labelRank, satisfies, dataPolicyOf, labelFor, view };
