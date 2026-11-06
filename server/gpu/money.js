'use strict';
/**
 * The money of the GPU provisioner: integer nano-USD in BigInt, never a float (AI's D1 rule; the same
 * rule server/credits.js follows for Credits). Nothing here multiplies or divides a float:
 *
 *   nanoCount()      an amount the owner set (the monthly cap): an integer count of nano-USD.
 *   nanoUsd()        a marketplace's own decimal price ("0.1348" dollars an hour) -> exact nano-USD.
 *   nanoForSeconds() what an instance at a known hourly rate costs for a known number of seconds,
 *                    rounded up to the nano: the ledger never charges less than the GPU was paid for.
 *   usdText()        nano-USD as a dollar string for a page (exact; a page never does arithmetic on it).
 */
const { AiError } = require('../util');
const { parseCostUsd } = require('../credits');

const NANO_PER_USD = 1000000000n;
const NANO_PER_MILLION = 1000000000000n;
const SECONDS_PER_HOUR = 3600n;

/** An integer count of nano-USD (the settings' money unit). null when absent; never a float. */
function nanoCount(value, field = 'amount') {
    if (value == null || value === '') return null;
    if (typeof value === 'bigint') return value;
    const raw = String(value).trim();
    if (!/^[0-9]+$/.test(raw)) throw new AiError(422, 'ai.invalid', field + ' must be an integer number of nano-USD');
    return BigInt(raw);
}

/** A plain decimal dollar amount (a marketplace's price) -> exact nano-USD. */
function nanoUsd(value, field = 'price') {
    if (value == null || value === '') return null;
    return parseCostUsd(value, field);
}

/** What an instance at hourlyNano costs for seconds: rounded up to the nano, never less. */
function nanoForSeconds(hourlyNano, seconds) {
    const s = BigInt(Math.max(0, Math.ceil(Number(seconds) || 0)));
    if (s === 0n) return 0n;
    return (BigInt(hourlyNano) * s + SECONDS_PER_HOUR - 1n) / SECONDS_PER_HOUR;
}

/** nano-USD as a dollar string (exact; for a page only). */
function usdText(nano) {
    const n = BigInt(nano == null ? 0 : nano);
    const abs = n < 0n ? -n : n;
    const whole = abs / NANO_PER_USD;
    const frac = (abs % NANO_PER_USD).toString().padStart(9, '0').replace(/0+$/, '');
    return (n < 0n ? '-' : '') + '$' + whole.toString() + (frac ? '.' + frac : '');
}

/**
 * The price of one million tokens on a GPU that costs hourlyNano an hour and serves tokensPerHour
 * tokens: the hourly rate spread over the tokens it can produce. It is an estimate for the router's
 * price comparison (the authoritative money is the GPU ledger), computed from the exact nano rate so
 * the two never drift apart.
 */
function usdPerMillionTokens(hourlyNano, tokensPerHour) {
    const t = BigInt(Math.max(1, Math.trunc(Number(tokensPerHour) || 0)));
    const nano = (BigInt(hourlyNano) * NANO_PER_MILLION + t - 1n) / t;
    return Number(nano) / 1e9;
}

module.exports = { NANO_PER_USD, NANO_PER_MILLION, nanoCount, nanoUsd, nanoForSeconds, usdText, usdPerMillionTokens };
