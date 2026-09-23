'use strict';
/** Small helpers shared by every module: hashing, stable JSON, row decoding, errors. */
const crypto = require('crypto');

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

/** An error that the API layer turns into a problem+json response. */
class AiError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
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

module.exports = { stableStringify, sha256, parseJson, iso, AiError, resolveSecret, secretRefValid, parseJsonLoose };
