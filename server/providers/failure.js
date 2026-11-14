'use strict';
/**
 * Why a provider attempt failed, in one of five classes, and what the catalogue says about it.
 *
 *   balance     the provider's account has no money left: DeepSeek's 402 "Insufficient Balance",
 *               OpenAI's 429 `insufficient_quota`, Anthropic's 400 "credit balance is too low",
 *               OpenRouter's 402 "Insufficient credits", or any provider naming a credit/billing limit
 *   auth        the key was refused: HTTP 401, or a 403 that is not a balance answer
 *   rate_limit  the provider's capacity is used up (HTTP 429, RESOURCE_EXHAUSTED); shifts to another offer
 *               for this request but never opens a circuit
 *   transient   a timeout, a connection failure, a 5xx or a broken stream; a run of these opens a circuit
 *               for a backoff that starts at 30 seconds and doubles to 10 minutes
 *   request     the provider rejected the request itself (400, 404, 413, 422, context too long, a bad
 *               image or schema), or our own content floor refused the request or the answer
 *               (policy.floor_refused); the caller's fault and never a reason to open a circuit
 *
 * The class is pure and derived from the status and the provider's own error code/message. The body is
 * never stored: only the class (and the provider's short message) rides the request log and the circuit.
 */
const { insufficientBalance, retryable } = require('./common');

const CLASSES = Object.freeze(['balance', 'auth', 'rate_limit', 'transient', 'request']);

/** The provider's error code and message, wherever its shape puts them (OpenAI, Anthropic, Gemini, OpenRouter). */
function detailOf(err) {
    const body = err && err.body && typeof err.body === 'object' ? err.body : {};
    const inner = (body.error && typeof body.error === 'object') ? body.error : body;
    const code = String((inner && (inner.code || inner.type || inner.status)) || (err && err.code) || '');
    const message = String((inner && inner.message) || body.message || (err && err.message) || '');
    const status = Number.isInteger(err && err.status) ? err.status : null;
    return { code, message, status, text: `${code} ${message}` };
}

/** The one class this failure belongs to, or null for a cancellation (not a provider failure). */
function classifyFailure(err) {
    if (!err) return { class: 'transient', code: '', status: null };
    if (err.code === 'provider.cancelled') return null;
    const { code, message, status, text } = detailOf(err);
    // Our own content floor refusing a request or an answer is a 403 that says nothing about the provider. Read as auth
    // it opened the circuit: on 11-14 one refused request paused DeepSeek Flash for everyone for over ten hours (and
    // whisper.cpp), and the console and Compare said "the key was refused" over a key that worked.
    if (err.code === 'policy.floor_refused' || code === 'policy.floor_refused') return { class: 'request', code: 'policy.floor_refused', status, message };

    // Balance first: several providers say it with a 403 or 429, which would otherwise read as auth or
    // ordinary capacity. The helper also knows DeepSeek's 402 and OpenAI's `insufficient_quota`.
    if (insufficientBalance(err)) return { class: 'balance', code, status, message };

    if (status === 401 || status === 403) return { class: 'auth', code, status, message };
    // A streamed error can lose the HTTP status; the provider's own words still say what happened.
    if (/invalid\s+(api[ _-]?key|x-api-key)|incorrect\s+api\s+key|authentication[ _-]?error|unauthorized|permission[ _-]?denied/i.test(text)
        && !/quota|balance|credit/i.test(text)) return { class: 'auth', code, status, message };

    if (status === 429 || /rate[ _-]?limit|too many requests|resource[ _-]?exhausted/i.test(text)) {
        // A 429 that names an empty account was caught above; everything else is capacity for this request.
        return { class: 'rate_limit', code, status, message };
    }

    if (status === 408 || status === 425 || (status != null && status >= 500)) return { class: 'transient', code, status, message };
    if (err.code === 'provider.timeout' || err.code === 'provider.unreachable' || err.code === 'provider.stream_broken') return { class: 'transient', code, status, message };
    if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|connection (failed|reset)|no response within/i.test(text)) return { class: 'transient', code, status, message };

    if (status != null && status >= 400) return { class: 'request', code, status, message };
    if (err.code === 'provider.output' || err.code === 'provider.unsupported' || err.code === 'media.unreadable' || err.code === 'policy.floor_refused') return { class: 'request', code, status, message };
    if (/context (length|window)|too long|maximum context|invalid (request|schema|image)|could not (decode|read)|refus/i.test(text)) return { class: 'request', code, status, message };
    return { class: retryable(err) ? 'transient' : 'request', code, status, message };
}

/** The plain sentence the catalogue and the console show for a class. */
function reasonForClass(failureClass) {
    if (failureClass === 'balance') return 'the provider says the account is out of credit';
    if (failureClass === 'auth') return 'the key was refused';
    return 'too many errors in the last hour';
}

const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

/**
 * A circuit's status, before the measured error rate is folded in. An open circuit is down; a
 * half-open one is degraded, because the next real request may probe it and it is not yet serving
 * normally (the same mapping the placement states use).
 */
function circuitStatus(circuit) {
    if (!circuit || (circuit.state !== 'open' && circuit.state !== 'half_open')) return null;
    const failureClass = circuit.failure_class || (circuit.exhausted_at ? 'balance' : null);
    return {
        status: circuit.state === 'open' ? 'down' : 'degraded',
        status_reason: circuit.status_reason || reasonForClass(failureClass),
        status_since: iso(circuit.opened_at || circuit.status_since),
        status_class: failureClass,
    };
}

/**
 * The measured status of one offer:
 *   down      its circuit is open (or waiting for a half-open probe)
 *   degraded  more than 5% of the last hour's at least 10 requests failed
 *   up        anything else
 * plus status_reason in plain words and status_since (ISO), never an invented time.
 *
 * `measured` is { requests, failures, first_error, first_balance, first_auth, last_ok } from the request log.
 */
function offerStatus({ circuit = null, measured = null } = {}) {
    const down = circuitStatus(circuit);
    if (down) return down;
    const requests = Number(measured && measured.requests) || 0;
    const failures = Number(measured && measured.failures) || 0;
    if (requests >= 10 && failures / requests > 0.05) {
        const failureClass = measured.first_balance ? 'balance' : measured.first_auth ? 'auth' : null;
        return {
            status: 'degraded',
            status_reason: reasonForClass(failureClass),
            status_since: measured.first_error || null,
            status_class: failureClass,
        };
    }
    return { status: 'up', status_reason: null, status_since: null, status_class: null };
}

module.exports = { CLASSES, classifyFailure, detailOf, reasonForClass, circuitStatus, offerStatus, iso };
