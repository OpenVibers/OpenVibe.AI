'use strict';
/**
 * A caller's loose JSON Schema in the strict form OpenAI's structured outputs decode against, and the answer brought
 * back to the caller's own schema.
 *
 * A request with `strict: false` is not constrained: the model only reads the schema. gpt-5-nano at minimal effort
 * then answered the deep dive's plan with a JSON Schema instead of the plan, every time (2026-11-15: every deep dive
 * failed at its first step). Strict decoding cannot answer anything but the shape, so a loose schema is converted:
 *
 *   - every object closed (additionalProperties: false) with every property required, as strict mode asks;
 *   - a property the caller left optional becomes nullable, and the null is taken out again afterwards;
 *   - keywords strict mode refuses (minLength, maxLength, default, …) are dropped, and the answer is fitted to the
 *     caller's limits afterwards (a string cut at its maxLength, a list at its maxItems).
 *
 * A schema that cannot be made strict (an object with no listed properties, a root that is not an object, a keyword
 * that cannot be expressed) returns null, and the request goes as the caller wrote it.
 *
 *   toStrict(schema) -> strict schema | null
 *   fitAnswer(value, schema) -> value fitted to the caller's schema
 */

// What strict mode accepts (OpenAI's structured outputs). Anything else in a schema is dropped or refuses conversion.
const KEEP = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf',
    'description', 'title', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf', 'minItems', 'maxItems', '$defs', 'definitions', '$ref']);
// Limits and notes strict mode refuses but the answer can be fitted to afterwards, or that change nothing.
const DROP = new Set(['minLength', 'maxLength', 'default', 'examples', 'example', '$schema', '$id', '$comment',
    'readOnly', 'writeOnly', 'deprecated', 'uniqueItems', 'contentMediaType', 'contentEncoding']);
const MAX_DEPTH = 5;   // strict mode's nesting limit is 10 levels of objects; deeper than this, leave it loose

const typesOf = (s) => (Array.isArray(s.type) ? s.type.slice() : s.type ? [s.type] : []);
const isObject = (s) => s && typeof s === 'object' && (typesOf(s).includes('object') || (s.properties && !s.type));

function nullable(s) {
    if (s.$ref) return { anyOf: [s, { type: 'null' }] };
    if (Array.isArray(s.anyOf)) return s.anyOf.some((x) => x && x.type === 'null') ? s : { ...s, anyOf: [...s.anyOf, { type: 'null' }] };
    const out = { ...s };
    if (Array.isArray(s.enum)) {
        if (!s.enum.includes(null)) out.enum = [...s.enum, null];
        if (!s.type) {
            const kinds = [...new Set(s.enum.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v)))];
            out.type = [...kinds.filter((k) => ['string', 'number', 'integer', 'boolean'].includes(k)), 'null'];
        }
    }
    if (s.const !== undefined) return { anyOf: [s, { type: 'null' }] };
    const types = typesOf(out);
    if (types.length && !types.includes('null')) out.type = [...types, 'null'];
    return out;
}

function convert(s, depth) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
        if (DROP.has(k)) continue;
        if (!KEEP.has(k)) return null;
        out[k] = v;
    }
    if (out.enum && !out.type) {
        const kinds = [...new Set(out.enum.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v)))];
        if (kinds.some((k) => !['string', 'number', 'integer', 'boolean', 'null'].includes(k))) return null;
        out.type = kinds.length === 1 ? kinds[0] : kinds;
    }
    if (isObject(s)) {
        if (depth >= MAX_DEPTH) return null;
        const props = s.properties || {};
        const keys = Object.keys(props);
        if (!keys.length) return null;   // a free-form object cannot be strict
        const required = new Set(Array.isArray(s.required) ? s.required : []);
        out.properties = {};
        for (const key of keys) {
            const inner = convert(props[key], depth + 1);
            if (!inner) return null;
            out.properties[key] = required.has(key) ? inner : nullable(inner);
        }
        out.required = keys;
        out.additionalProperties = false;
        if (!out.type) out.type = 'object';
    }
    if (out.items) {
        if (Array.isArray(out.items)) return null;
        const inner = convert(out.items, depth + 1);
        if (!inner) return null;
        out.items = inner;
    }
    if (Array.isArray(out.anyOf)) {
        const list = out.anyOf.map((x) => convert(x, depth + 1));
        if (list.some((x) => !x)) return null;
        out.anyOf = list;
    }
    for (const defs of ['$defs', 'definitions']) {
        if (!out[defs]) continue;
        const next = {};
        for (const [k, v] of Object.entries(out[defs])) { const c = convert(v, depth + 1); if (!c) return null; next[k] = c; }
        out[defs] = next;
    }
    return out;
}

function toStrict(schema) {
    if (!isObject(schema)) return null;
    try { return convert(schema, 0); } catch { return null; }
}

function fitAnswer(value, schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 12) return value;
    if (typeof value === 'string' && Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return value.slice(0, schema.maxLength);
    if (Array.isArray(value)) {
        const list = Number.isInteger(schema.maxItems) && value.length > schema.maxItems ? value.slice(0, schema.maxItems) : value;
        return schema.items && !Array.isArray(schema.items) ? list.map((v) => fitAnswer(v, schema.items, depth + 1)) : list;
    }
    if (value && typeof value === 'object' && schema.properties) {
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const inner = schema.properties[k];
            if (v === null && inner && !required.has(k) && !typesOf(inner).includes('null') && !(Array.isArray(inner.enum) && inner.enum.includes(null))) continue;
            out[k] = inner ? fitAnswer(v, inner, depth + 1) : v;
        }
        return out;
    }
    return value;
}

module.exports = { toStrict, fitAnswer };
