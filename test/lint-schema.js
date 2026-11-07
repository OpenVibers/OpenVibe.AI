'use strict';
/**
 * A local stand-in for openvibe-shared/config's lintSchema and its annotation checks (Shared 4.125.0, Shared PR #310,
 * not tagged when this was written): the owner-setup design's clarity rules, checked on a namespace's schema, so a
 * schema that passes here also passes when the pin moves to 4.125.0. Returns a list of problems ([] is clean).
 *
 *   - every field has a title and a description of at least 30 characters;
 *   - every enum option has words (x-enum-labels: { value: { label, description } });
 *   - an x-owner-input names a Setup group, says what it unlocks, links an https page and says what to pick there;
 *   - x-required-for, when present, names a feature.
 */
// openvibe-shared 4.125.0's OWNER_INPUT_GROUPS ids, and the members an x-owner-input may have.
const GROUPS = new Set(['money', 'ai-providers', 'gpus', 'voices', 'chat-apps', 'sign-in-apps', 'data-sources',
    'design-publishing', 'domains', 'legal']);
const MEMBERS = new Set(['group', 'unlocks', 'get_it_at', 'get_it_how', 'test']);

function lintField(name, f, out) {
    if (!f || typeof f !== 'object') return;
    if (typeof f.title !== 'string' || !f.title.trim()) out.push(`${name}: no title`);
    if (typeof f.description !== 'string' || f.description.trim().length < 30) out.push(`${name}: the description is missing or under 30 characters`);
    const options = Array.isArray(f.enum) ? f.enum : (f.items && Array.isArray(f.items.enum) ? f.items.enum : null);
    if (options) {
        const labels = f['x-enum-labels'] || (f.items && f.items['x-enum-labels']);
        for (const v of options) {
            const l = labels && labels[String(v)];
            if (!l || typeof l.label !== 'string' || !l.label.trim() || typeof l.description !== 'string' || !l.description.trim()) out.push(`${name}: the option ${JSON.stringify(v)} has no label and line`);
        }
    }
    const oi = f['x-owner-input'];
    if (oi !== undefined) {
        if (!oi || typeof oi !== 'object') out.push(`${name}: x-owner-input must be an object`);
        else {
            for (const m of Object.keys(oi)) if (!MEMBERS.has(m)) out.push(`${name}: x-owner-input has an unknown member ${m}`);
            if (!GROUPS.has(oi.group)) out.push(`${name}: x-owner-input.group ${JSON.stringify(oi.group)} is not a Setup group`);
            if (typeof oi.unlocks !== 'string' || oi.unlocks.trim().length < 20) out.push(`${name}: x-owner-input.unlocks must say what it turns on`);
            if (oi.get_it_at !== undefined && !/^https:\/\/[^\s]+$/.test(String(oi.get_it_at))) out.push(`${name}: x-owner-input.get_it_at must be an https URL`);
            if (typeof oi.get_it_how !== 'string' || oi.get_it_how.trim().length < 10) out.push(`${name}: x-owner-input.get_it_how must say what to pick there`);
            if (typeof oi.test !== 'boolean') out.push(`${name}: x-owner-input.test must be true or false`);
        }
    }
    if (f['x-example'] !== undefined && !['string', 'number', 'boolean'].includes(typeof f['x-example'])) out.push(`${name}: x-example must be a string, a number or true/false`);
    if (f['x-advanced'] !== undefined && typeof f['x-advanced'] !== 'boolean') out.push(`${name}: x-advanced must be true or false`);
    if (f['x-enum-labels'] && options) for (const v of Object.keys(f['x-enum-labels'])) if (!options.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).includes(v)) out.push(`${name}: x-enum-labels names ${v}, which is not an option`);
    if (f['x-required-for'] !== undefined && (typeof f['x-required-for'] !== 'string' || !f['x-required-for'].trim())) out.push(`${name}: x-required-for must name a feature`);
    if (f.properties && typeof f.properties === 'object') for (const [k, sub] of Object.entries(f.properties)) lintField(`${name}.${k}`, sub, out);
}

function lintSchema(schema) {
    const out = [];
    if (!schema || typeof schema !== 'object') return ['no schema'];
    if (typeof schema.title !== 'string' || !schema.title.trim()) out.push('(namespace): no title');
    if (typeof schema.description !== 'string' || schema.description.trim().length < 30) out.push('(namespace): the description is missing or under 30 characters');
    for (const [k, f] of Object.entries(schema.properties || {})) lintField(k, f, out);
    return out;
}

module.exports = { lintSchema, GROUPS };
