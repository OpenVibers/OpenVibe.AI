'use strict';
/**
 * The latency class of a run: how long the caller may wait, and what the router may do with the wait.
 *
 *   interactive  the default: today's routing, the answer as soon as the provider can give it.
 *   background   the answer may take minutes: the router looks for the cheapest tier that can wait
 *                (idle local capacity, a Flex tier, a provider's off-peak hours), and the run is priced
 *                on the tier it really ran on.
 *   batch        the answer may take hours: the run is queued and answered through a provider's own
 *                batch API (BA2).
 *
 * The class is the workflow's own, read from the route it uses (constraints.latency_class). A caller may
 * ask for a SLOWER class with options.latency — never a faster one: a background workflow stays in the
 * background whatever the caller asks for, because the work it does is the work it does.
 *
 * The order is the whole rule: interactive < background < batch.
 */
const CLASSES = ['interactive', 'background', 'batch'];
const ORDER = { interactive: 0, background: 1, batch: 2 };
const DEFAULT = 'interactive';

/**
 * How long a run of each class may take. A background run waits for a Flex tier, which is slower than the
 * standard one, so it is given more room; a batch run has a deadline of its own (BA2).
 */
const TIMEOUT_MS = { interactive: 30000, background: 180000, batch: 600000 };

/** Is this a class name we know? */
function isClass(v) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ORDER, v); }
/** Where a class sits in the order (an unknown class is the default). */
function rank(v) { return isClass(v) ? ORDER[v] : ORDER[DEFAULT]; }
/** Is `a` at least as slow as `b`? */
function slowerOrEqual(a, b) { return rank(a) >= rank(b); }

/** The class a route declares: its own constraint, or interactive. */
function ofRoute(route) {
    const c = route && route.constraints && route.constraints.latency_class;
    return isClass(c) ? c : DEFAULT;
}

/**
 * The class a run may take: the workflow's own class, or a slower one the caller asked for.
 * → { class } or { error } (the caller asked for something the workflow does not allow).
 */
function resolve(workflowClass, asked) {
    const base = isClass(workflowClass) ? workflowClass : DEFAULT;
    if (asked == null || asked === '') return { class: base };
    if (!isClass(asked)) return { error: `latency must be one of ${CLASSES.join(', ')}` };
    if (!slowerOrEqual(asked, base)) {
        return { error: `this workflow runs in the ${base} class: ${asked} would make it faster than it may be` };
    }
    return { class: asked };
}

/** The timeout a class gets (the route's own timeout still applies when it is longer). */
function timeoutMs(v) { return TIMEOUT_MS[isClass(v) ? v : DEFAULT] || TIMEOUT_MS[DEFAULT]; }

module.exports = { CLASSES, ORDER, DEFAULT, TIMEOUT_MS, isClass, rank, slowerOrEqual, ofRoute, resolve, timeoutMs };
