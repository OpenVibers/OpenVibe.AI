'use strict';
/**
 * JSON Schema (2020-12) validation for workflow/template input and output schemas. Compiled
 * validators are cached by schema hash, so a new version of a workflow compiles once.
 */
const Ajv2020 = require('ajv/dist/2020');
const { sha256 } = require('./util');

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: false });
const compiled = new Map();

function compile(schema) {
    const key = sha256(schema || {});
    let fn = compiled.get(key);
    if (!fn) {
        fn = ajv.compile(schema || {});
        compiled.set(key, fn);
    }
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

module.exports = { compile, assertSchema, validate };
