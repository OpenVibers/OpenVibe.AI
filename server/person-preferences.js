'use strict';
/**
 * A person's ai.preferences (L36 Y3; Contracts ai.me-preferences@1): only_my_keys, free_first, a price ceiling for
 * the network's paid fallback, and a default model (or `auto`) per kind of work. Stored per person in
 * ai_person_preferences (migrations/0020), JSON so another preference adds without a migration.
 *
 * A row that predates the table or a field it never saw reads the default, never undefined. There is no default key
 * and no network budget here: own keys are free to their owner.
 */
const contracts = require('openvibe-contracts');
const { AiError, iso } = require('./util');

const DEFAULTS = Object.freeze({
    only_my_keys: false,
    free_first: true,
    price_ceiling_usd_per_mtok: null,
    defaults: Object.freeze({ text: 'auto', code: 'auto', vision: 'auto', image: 'auto' }),
});

/** The same rules ai.me-preferences@1 states, for a service whose contracts pin predates 0.257.0. */
function manualPreferences(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
    if (typeof body.only_my_keys !== 'boolean' || typeof body.free_first !== 'boolean') return 'only_my_keys and free_first are booleans';
    if (body.price_ceiling_usd_per_mtok != null && !(Number(body.price_ceiling_usd_per_mtok) >= 0 && Number(body.price_ceiling_usd_per_mtok) <= 1000)) return 'price_ceiling_usd_per_mtok must be 0-1000 or null';
    const d = body.defaults;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'defaults is an object';
    for (const k of ['text', 'code', 'vision', 'image']) {
        if (typeof d[k] !== 'string' || !d[k].length || d[k].length > 120) return `defaults.${k} must be a model id or auto (1-120 characters)`;
    }
    return null;
}

function createPreferences({ db, clock = { now: () => Date.now() } }) {
    const read = async (subject) => {
        const row = await db.prepare('SELECT preferences FROM ai_person_preferences WHERE subject = ?').get(String(subject));
        let stored = {};
        try { stored = row ? JSON.parse(row.preferences || '{}') : {}; } catch { stored = {}; }
        return {
            only_my_keys: stored.only_my_keys === true,
            free_first: stored.free_first == null ? DEFAULTS.free_first : stored.free_first === true,
            price_ceiling_usd_per_mtok: typeof stored.price_ceiling_usd_per_mtok === 'number' ? stored.price_ceiling_usd_per_mtok : null,
            defaults: { ...DEFAULTS.defaults, ...(stored.defaults && typeof stored.defaults === 'object' ? stored.defaults : {}) },
            updated_at: row ? row.updated_at : null,
        };
    };

    async function get(subject) { return await read(subject); }

    async function put(subject, body) {
        // ai.me-preferences@1 arrives with openvibe-contracts 0.257.0; before that pin the shape is checked here.
        let v = null;
        try { v = contracts.schema('ai.me-preferences@1') ? contracts.validate('ai.me-preferences@1', body) : null; } catch { v = null; }
        const manual = v ? null : manualPreferences(body);
        if ((v && !v.valid) || manual) throw new AiError(422, 'input.invalid', 'body does not match ai.me-preferences@1', { errors: v ? v.errors : [{ path: '', message: manual }] });
        const value = {
            only_my_keys: body.only_my_keys === true,
            free_first: body.free_first === true,
            price_ceiling_usd_per_mtok: body.price_ceiling_usd_per_mtok == null ? null : Number(body.price_ceiling_usd_per_mtok),
            defaults: {
                text: String(body.defaults.text), code: String(body.defaults.code),
                vision: String(body.defaults.vision), image: String(body.defaults.image),
            },
        };
        const at = iso(clock.now());
        const prev = await db.prepare('SELECT created_at FROM ai_person_preferences WHERE subject = ?').get(String(subject));
        await db.prepare(`INSERT INTO ai_person_preferences (subject, preferences, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(subject) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`)
            .run(String(subject), JSON.stringify(value), prev ? prev.created_at : at, at);
        return await read(subject);
    }

    return { get, put, DEFAULTS };
}

module.exports = { createPreferences, DEFAULTS };
