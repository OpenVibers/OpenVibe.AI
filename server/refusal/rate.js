'use strict';
/**
 * The arithmetic of a refusal rate.
 *
 * A rate is refusals over attempts: the share of the probes an offer refused. It is kept as a fraction
 * between 0 and 1 (0.75 means three probes out of four were refused), because that is what the public
 * catalog carries and what the Exchange's percentage rendering expects.
 *
 * An offer nobody measured has no rate at all. The rate of zero attempts is unknown, never zero: a
 * number that says "this offer refused nothing" when nothing was ever asked would be a lie, and the
 * catalog shows unknown as unknown.
 */
const PRECISION = 1e6;

/** refusals / attempts, rounded to six decimals; null when nothing was asked. */
function rateOf(refusals, attempts) {
    const asked = Math.max(0, Math.trunc(Number(attempts) || 0));
    if (asked === 0) return null;
    const refused = Math.max(0, Math.trunc(Number(refusals) || 0));
    return Math.round((refused / asked) * PRECISION) / PRECISION;
}

module.exports = { rateOf, PRECISION };
