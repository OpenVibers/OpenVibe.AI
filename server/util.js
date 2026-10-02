'use strict';
/** Small helpers shared by every module: hashing, stable JSON, row decoding, errors. */
const crypto = require('crypto');
const svc = require('openvibe-sdk/service');

/** JSON with sorted object keys, so equal inputs always hash equal. */
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(value) {
    const s = typeof value === 'string' ? value : stableStringify(value);
    return crypto.createHash('sha256').update(s).digest('hex');
}

function parseJson(text, fallback = null) {
    if (text == null || text === '') return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** An error that the API layer turns into a problem+json response: (status, code, detail?, extra?). */
const AiError = svc.createServiceError('AiError');

const PROBLEMS = { name: 'api', internalCode: 'ai.internal', internalDetail: 'internal error' };

/**
 * Any error -> problem+json (openvibe-sdk/service sendError). Only an AiError answers with its own status,
 * code and extra (extra.errors is the problem's errors list; a 429 with retry_after_seconds sets Retry-After).
 * Anything else is logged and answers 500 ai.internal: it is passed on as its stack alone, so a provider
 * error's upstream HTTP status never becomes AI's answer.
 */
function sendError(res, err, ctx, log = console) {
    const req = { ov: ctx };
    if (!(err instanceof AiError)) return svc.sendError(res, req, { stack: (err && err.stack) || String(err) }, log, PROBLEMS);
    if (err.status === 429 && err.extra && err.extra.retry_after_seconds && !res.headersSent) res.setHeader('Retry-After', String(err.extra.retry_after_seconds));
    return svc.sendError(res, req, err, log, PROBLEMS);
}

/** 'env:NAME' -> the value of process.env.NAME (read by name; never logged). */
function resolveSecret(ref, env = process.env) {
    if (!ref) return '';
    const m = /^env:([A-Z][A-Z0-9_]{0,63})$/.exec(String(ref));
    if (!m) return '';
    return env[m[1]] ? String(env[m[1]]) : '';
}

function secretRefValid(ref) {
    return ref == null || ref === '' || /^env:[A-Z][A-Z0-9_]{0,63}$/.test(String(ref));
}

/** Loose JSON repair, ported from Live's llm.parseJsonLoose (models emit slightly broken JSON). */
function parseJsonLoose(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* */ }
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const raw = m[0];
    try { return JSON.parse(raw); } catch { /* repair */ }
    try {
        let t = raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1');
        const osq = (t.match(/\[/g) || []).length, csq = (t.match(/\]/g) || []).length;
        if (osq > csq) { t = t.replace(/\}\s*$/, ''); t += ']'.repeat(osq - csq); }
        const ocb = (t.match(/\{/g) || []).length, ccb = (t.match(/\}/g) || []).length;
        if (ocb > ccb) t += '}'.repeat(ocb - ccb);
        return JSON.parse(t);
    } catch { return null; }
}

module.exports = { stableStringify, sha256, parseJson, iso, AiError, sendError, resolveSecret, secretRefValid, parseJsonLoose };
