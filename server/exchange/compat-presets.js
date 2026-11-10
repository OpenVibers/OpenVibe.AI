'use strict';
const { normalizePreset } = require('./import-preset');
const { AiError } = require('../util');
function createCompatPresets(db) {
    const decode = row => row ? (typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition) : null;
    async function get(owner, name) {
        return decode(await db.prepare('SELECT definition FROM exchange_compat_presets WHERE owner = ? AND name = ?').get(owner, name));
    }
    async function expand(owner, body, protocol) {
        if (typeof body.model !== 'string' || !body.model.startsWith('@preset/')) return body;
        const saved = await get(owner, body.model.slice(8));
        if (!saved) return body; // Existing routing-only presets retain their namespace.
        const { name, system, ...defaults } = saved;
        const out = { ...defaults, ...body, model: defaults.model || defaults.models[0] };
        if (system && protocol === 'messages') out.system = body.system ?? system;
        if (system && protocol !== 'messages') out.messages = [{ role: 'system', content: system }, ...(body.messages || [])];
        return out;
    }
    return {
        get, expand,
        async list(owner) {
            return (await db.prepare('SELECT definition FROM exchange_compat_presets WHERE owner = ? ORDER BY name').all(owner)).map(decode);
        },
        async put(owner, body) {
            const value = normalizePreset(body);
            await db.prepare(`INSERT INTO exchange_compat_presets(owner,name,definition) VALUES(?,?,?)
                ON CONFLICT(owner,name) DO UPDATE SET definition = excluded.definition`).run(owner, value.name, JSON.stringify(value));
            return value;
        },
        async remove(owner, name) {
            if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new AiError(400, 'input.invalid', 'Invalid preset name');
            const result = await db.prepare('DELETE FROM exchange_compat_presets WHERE owner = ? AND name = ?').run(owner, name);
            return { name, deleted: result.changes > 0 };
        },
    };
}
module.exports = { createCompatPresets };
