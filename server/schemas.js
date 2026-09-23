'use strict';
/**
 * JSON Schema (2020-12) validation for workflow/template input and output schemas. Compiled
 * validators are cached by schema hash, so a new version of a workflow compiles once.
 *
 * The cache is shared by every caller and some schemas are caller-supplied (ai.extract / ai.enrich
 * send their own), so it is an LRU bounded by entry count and by the total size of the cached
 * schemas (AI_SCHEMA_CACHE_MAX, AI_SCHEMA_CACHE_MAX_BYTES). Ajv keeps its own reference to every
 * schema it compiles; an evicted entry is removed from Ajv too, so neither side grows without bound.
 * A schema larger than the whole byte budget is compiled for that call and not kept.
 */
const Ajv2020 = require('ajv/dist/2020');
const { sha256, stableStringify } = require('./util');

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: false });
const compiled = new Map();          // hash -> { fn, schema, bytes }; Map order is recency (oldest first)
const limits = { maxEntries: 500, maxBytes: 8 * 1024 * 1024 };
let bytesHeld = 0;

function forget(key) {
    const e = compiled.get(key);
    if (!e) return;
    compiled.delete(key);
    bytesHeld -= e.bytes;
    try { ajv.removeSchema(e.schema); } catch { /* not held by Ajv */ }
}

function trim() {
    for (const key of compiled.keys()) {
        if (compiled.size <= limits.maxEntries && bytesHeld <= limits.maxBytes) break;
        forget(key);
    }
}

/** Set the bounds (server/index.js passes config.schemaCache); shrinking evicts at once. */
function configure({ maxEntries, maxBytes } = {}) {
    if (Number.isFinite(maxEntries) && maxEntries >= 1) limits.maxEntries = Math.floor(maxEntries);
    if (Number.isFinite(maxBytes) && maxBytes >= 1) limits.maxBytes = Math.floor(maxBytes);
    trim();
}

function compile(schema) {
    const s = schema || {};
    const text = stableStringify(s);
    const key = sha256(text);
    const hit = compiled.get(key);
    if (hit) {
        compiled.delete(key);            // most recently used goes to the end
        compiled.set(key, hit);
        return hit.fn;
    }
    let fn;
    try { fn = ajv.compile(s); } catch (e) {
        try { ajv.removeSchema(s); } catch { /* */ }
        throw e;
    }
    const bytes = Buffer.byteLength(text);
    if (bytes > limits.maxBytes) {
        try { ajv.removeSchema(s); } catch { /* */ }
        return fn;
    }
    compiled.set(key, { fn, schema: s, bytes });
    bytesHeld += bytes;
    trim();
    return fn;
}

/** Throws when the schema itself is not a valid JSON Schema. */
function assertSchema(schema, label = 'schema') {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${label} must be a JSON Schema object`);
    try { compile(schema); } catch (e) { throw new Error(`${label} does not compile: ${e.message}`); }
}

/** { valid, errors: [{path, message}] } */
function validate(schema, value) {
    const fn = compile(schema);
    const valid = fn(value);
    return { valid: Boolean(valid), errors: valid ? [] : (fn.errors || []).slice(0, 20).map(e => ({ path: e.instancePath || '/', message: e.message })) };
}

/** Cache occupancy (tests, status): our entries and bytes, and the schemas Ajv itself still holds. */
function stats() {
    return { entries: compiled.size, bytes: bytesHeld, max_entries: limits.maxEntries, max_bytes: limits.maxBytes, ajv_held: ajv._cache ? ajv._cache.size : null };
}

module.exports = { compile, assertSchema, validate, configure, stats };
