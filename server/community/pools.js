'use strict';
/**
 * The `pool` part of a community AI offer (ai.offer-pool@1; the pooled machines design, 2026-11-06): several of one
 * owner's machines on one local network serving one model through llama.cpp RPC, answering through the head.
 * Network adds it from its approved pool record; this module only reads it.
 *
 *   poolOf(value, machineId)  { machines, head } sorted, or null when it is not exactly a valid pool whose head is the
 *                             offer's own machine (a malformed pool drops the whole offer: fail closed)
 *   label(pool)               "Community pool (N machines)", or "Community" for one machine
 *   identity(pool)            the suffix of the verification key: another member or head is a new, unverified pool
 *   publicPool(pool)          the members as stable pseudonyms, for Exchange (never a machine id)
 */
const { sha256 } = require('../util');

const DEVICE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;

function poolOf(value, machine) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !['machines', 'head'].includes(k))) return null;
    const members = value.machines;
    if (!Array.isArray(members) || members.length < 2 || members.length > 8 || new Set(members).size !== members.length
        || members.some((m) => typeof m !== 'string' || !DEVICE.test(m)) || !members.includes(value.head) || value.head !== machine) return null;
    return { machines: [...members].sort(), head: value.head };
}
const label = (pool) => (pool ? `Community pool (${pool.machines.length} machines)` : 'Community');
const identity = (pool) => (pool ? `|pool:${sha256(JSON.stringify(pool)).slice(0, 24)}` : '');
function publicPool(pool) {
    const pseudonym = (id) => `machine_${sha256(id).slice(0, 16)}`;
    return { machines: pool.machines.map(pseudonym), head: pseudonym(pool.head) };
}

module.exports = { poolOf, label, identity, publicPool };
