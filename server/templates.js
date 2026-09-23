'use strict';
/**
 * Prompt template rendering — a deliberately small, logic-less subset of Mustache:
 *
 *   {{path.to.value}}        the value (objects/arrays as JSON, missing as '')
 *   {{json path}}            JSON.stringify(value)
 *   {{#path}} … {{/path}}    section, rendered when the value is truthy (non-empty for arrays/strings)
 *   {{^path}} … {{/path}}    inverted section
 *
 * No HTML escaping (these are prompts, not pages) and no code: anything that needs logic lives in
 * a named prepare hook (server/workflows/hooks.js) that turns the run input into template vars.
 */

function lookup(vars, path) {
    if (path === '.') return vars;
    let cur = vars;
    for (const part of String(path).split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

function truthy(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim().length > 0;
    return Boolean(v);
}

function show(v) {
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

const SECTION_RE = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const TAG_RE = /\{\{\s*(json\s+)?([\w.]+)\s*\}\}/g;

function render(template, vars = {}) {
    let out = String(template || '');
    // Sections (innermost last is fine: templates here do not nest the same key).
    for (let i = 0; i < 5 && SECTION_RE.test(out); i++) {
        SECTION_RE.lastIndex = 0;
        out = out.replace(SECTION_RE, (_, kind, path, body) => {
            const on = truthy(lookup(vars, path));
            return (kind === '#' ? on : !on) ? body : '';
        });
        SECTION_RE.lastIndex = 0;
    }
    return out.replace(TAG_RE, (_, json, path) => {
        const v = lookup(vars, path);
        return json ? JSON.stringify(v === undefined ? null : v) : show(v);
    });
}

module.exports = { render, lookup };
