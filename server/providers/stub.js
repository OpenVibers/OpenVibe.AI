'use strict';
/**
 * The deterministic no-key stub provider (mandatory for local and test operation).
 *
 * Every answer is a pure function of the request: the same request always yields the same output,
 * so tests are exact and browsers can exercise Wiki/Blog/News flows without keys or network.
 * Outputs are realistically SHAPED — a JSON answer follows the requested schema (enums, bounds,
 * arrays, nested objects), text has sentences, embeddings are unit vectors, transcripts have
 * timed segments — and are clearly marked synthetic: free-text strings start with "(synthetic)"
 * and every result carries synthetic: true, which the run records and returns. Downstream
 * products treat a synthetic run as "no real answer" (Live does; the publication gate keeps it
 * noindex).
 *
 * Drill modes (provider metadata, for fallback/breaker drills): { fail: 'error' | 'timeout' }.
 */
const crypto = require('crypto');
const { ProviderError, approxTokens, sleep } = require('./common');

const WORDS = ['signal', 'stream', 'moment', 'chat', 'overview', 'context', 'detail', 'summary', 'topic', 'source',
    'evidence', 'draft', 'highlight', 'session', 'update', 'note', 'theme', 'story', 'entity', 'record'];

function seeded(seedText) {
    let h = crypto.createHash('sha256').update(seedText).digest();
    let i = 0;
    return function next() {
        if (i + 4 > h.length) { h = crypto.createHash('sha256').update(h).digest(); i = 0; }
        const v = h.readUInt32BE(i);
        i += 4;
        return v / 0x100000000;
    };
}

function lastUserText(req) {
    const msgs = req.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const c = msgs[i].content;
        if (msgs[i].role === 'user') return typeof c === 'string' ? c : JSON.stringify(c);
    }
    return '';
}

function phrase(rnd, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    return out.join(' ');
}

/** A value shaped like `schema`, drawn from rnd. Strings are marked synthetic. */
function synthesize(schema, rnd, depth = 0, name = 'value') {
    if (!schema || typeof schema !== 'object' || depth > 6) return null;
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[Math.floor(rnd() * schema.enum.length)];
    const alt = schema.oneOf || schema.anyOf;
    if (Array.isArray(alt) && alt.length) return synthesize(alt[0], rnd, depth + 1, name);
    let type = schema.type;
    if (Array.isArray(type)) type = type.find(t => t !== 'null') || 'null';
    if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
    switch (type) {
        case 'object': {
            const out = {};
            const props = schema.properties || {};
            for (const [k, sub] of Object.entries(props)) out[k] = synthesize(sub, rnd, depth + 1, k);
            return out;
        }
        case 'array': {
            const max = Number.isInteger(schema.maxItems) ? schema.maxItems : 3;
            const min = Number.isInteger(schema.minItems) ? schema.minItems : Math.min(1, max);
            const n = Math.max(min, Math.min(max, min + Math.floor(rnd() * 3)));
            return Array.from({ length: n }, (_, i) => synthesize(schema.items || { type: 'string' }, rnd, depth + 1, `${name}_${i + 1}`));
        }
        case 'integer': {
            const min = Number.isFinite(schema.minimum) ? schema.minimum : 0;
            const max = Number.isFinite(schema.maximum) ? schema.maximum : min + 100;
            return Math.floor(min + rnd() * (max - min + 1));
        }
        case 'number': {
            const min = Number.isFinite(schema.minimum) ? schema.minimum : 0;
            const max = Number.isFinite(schema.maximum) ? schema.maximum : 1;
            return Math.round((min + rnd() * (max - min)) * 1000) / 1000;
        }
        case 'boolean': return rnd() < 0.5;
        case 'null': return null;
        default: {
            let s = `(synthetic) ${name.replace(/_/g, ' ')}: ${phrase(rnd, 4 + Math.floor(rnd() * 5))}`;
            if (Number.isInteger(schema.maxLength)) s = s.slice(0, Math.max(0, schema.maxLength));
            if (Number.isInteger(schema.minLength) && s.length < schema.minLength) s = s.padEnd(schema.minLength, '.');
            return s;
        }
    }
}

function textFor(op, req, rnd) {
    const src = lastUserText(req).replace(/\s+/g, ' ').trim();
    const firstWords = src.split(' ').slice(0, 10).join(' ');
    switch (op) {
        case 'summarize': return `(synthetic) Summary: ${firstWords ? `${firstWords}…` : 'no input text'} — ${phrase(rnd, 6)}.`;
        case 'classify': return `(synthetic) ${phrase(rnd, 1)}`;
        case 'extract': return `(synthetic) extracted ${phrase(rnd, 3)}`;
        case 'enrich': return `(synthetic) enriched ${phrase(rnd, 5)}`;
        default: return `(synthetic) ${phrase(rnd, 8 + Math.floor(rnd() * 8))}. ${phrase(rnd, 6)}.`;
    }
}

function createStubProvider(record = { key: 'stub', metadata: {} }, { stats = null } = {}) {
    const fail = record.metadata && record.metadata.fail;

    async function run(op, req) {
        if (stats) stats.calls = (stats.calls || 0) + 1;
        if (req.signal && req.signal.aborted) throw new ProviderError('cancelled', { code: 'provider.cancelled' });
        if (fail === 'error') throw new ProviderError('stub drill: provider error', { status: 503, code: 'provider.http' });
        if (fail === 'timeout') { await sleep(Math.min(req.timeoutMs || 1000, 60000), req.signal); throw new ProviderError('stub drill: timeout', { code: 'provider.timeout' }); }
        if (record.metadata && Number(record.metadata.delay_ms) > 0) await sleep(Number(record.metadata.delay_ms), req.signal);
        const seed = JSON.stringify({ op, m: req.model || null, s: (req.system || []).map(x => x.text), u: req.messages, j: req.json ? req.json.schema : null, i: req.input || null, img: req.image ? req.image.base64.length : 0 });
        const rnd = seeded(seed);
        const model = req.model || 'stub-1';
        if (op === 'embed') {
            const inputs = Array.isArray(req.input) ? req.input : [String(req.input || '')];
            const vectors = inputs.map((t) => {
                const r = seeded(`embed:${t}`);
                const v = Array.from({ length: 64 }, () => r() * 2 - 1);
                const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
                return v.map(x => Math.round((x / norm) * 1e6) / 1e6);
            });
            return { vectors, model, synthetic: true, usage: { input: inputs.reduce((n, t) => n + approxTokens(t), 0), output: 0, cached: 0, estimated: true } };
        }
        if (op === 'transcribe') {
            const n = 2 + Math.floor(rnd() * 3);
            const segments = Array.from({ length: n }, (_, i) => ({ start: i * 4, end: i * 4 + 3.5, text: `(synthetic) ${phrase(rnd, 5)}` }));
            return { text: segments.map(s => s.text).join(' '), segments, model, synthetic: true, usage: { input: 0, output: 0, cached: 0, estimated: true } };
        }
        let json = null;
        let text;
        if (req.json && req.json.schema) {
            json = synthesize(req.json.schema, rnd, 0, req.json.name || 'result');
            text = JSON.stringify(json);
        } else {
            text = textFor(op, req, rnd);
        }
        const inTok = approxTokens((req.system || []).map(x => x.text).join('')) + approxTokens(lastUserText(req)) + (req.image ? 800 : 0);
        return { text, json, model, synthetic: true, usage: { input: inTok, output: approxTokens(text), cached: 0, estimated: true } };
    }

    const adapter = {
        key: record.key,
        kind: 'stub',
        synthetic: true,
        supports: () => true,
        transcribe: (req) => run('transcribe', req),
        embed: (req) => run('embed', req),
    };
    for (const op of ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich']) adapter[op] = (req) => run(op, req);
    return adapter;
}

module.exports = { createStubProvider, synthesize, seeded };
