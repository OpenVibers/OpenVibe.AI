'use strict';
/**
 * Routing presets: the Exchange's saved routing profiles (the plan of 2026-11-06, "Product lines and
 * features", item 1: "Presets are saved routing profiles").
 *
 * A preset is a named set of routing constraints:
 *
 *   objective      cheapest | fastest | balanced | private   what the router optimises
 *   floor          fast | balanced | strong | frontier     the weakest offer that may answer
 *   ceiling        USD per million tokens                   the highest price that may be paid
 *   max_price      USD per million tokens                   the hard cap: no fitting offer is a refusal
 *   quantization   the quantizations that may answer        q4_k_m, q8_0, ...
 *   region         the regions that may answer               eu, us, ...
 *   data_policy    private | anonymized | community          the weakest privacy class that may answer
 *   community      may a community machine answer?           off unless the profile asks for it
 *   adult          may an uncensored model answer?           the 18+ gate is the pool's (server/policy)
 *
 * A preset belongs to an account (a person) or to a Network project; the service also ships five built-in
 * ones (cheapest, fastest, private, uncensored, eu-only), which are code and not rows: an owner cannot
 * edit them away, and a person's own preset of the same name wins over the built-in one.
 *
 * A request names a preset as `model: "@preset/<name>"` or as `preset: "<name>"`. The resolved policy
 * rides the run (options.preset) into the router (server/providers/index.js), which filters the offers
 * with it and refuses a request whose hard max_price no offer fits.
 */
const { AiError } = require('../util');
const { parseJson } = require('../util');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OBJECTIVES = ['cheapest', 'fastest', 'balanced', 'private'];
/** The catalogue's strength tiers (server/providers/task.js TIER_RANK). The task's own words map onto them. */
const FLOORS = ['fast', 'balanced', 'strong', 'frontier'];
const FLOOR_ALIASES = { light: 'fast', standard: 'balanced', heavy: 'strong' };
const DATA_POLICIES = ['private', 'anonymized', 'community'];
const REGIONS = ['eu', 'us', 'ca', 'uk', 'ch', 'global', 'apac'];

const BUILTINS = Object.freeze([
    { name: 'cheapest', description: 'The lowest cost per answer among the offers that can do the job.', policy: { objective: 'cheapest' } },
    { name: 'fastest', description: 'The quickest measured offer among the offers that can do the job.', policy: { objective: 'fastest' } },
    { name: 'private', description: 'Only offers that keep nothing and train on nothing; never a community machine.', policy: { objective: 'balanced', data_policy: 'private', community: false } },
    { name: 'uncensored', description: 'The abliterated models at the lowest healthy price. Adults only; the floor still applies.', policy: { objective: 'cheapest', adult: true } },
    { name: 'eu-only', description: 'Only offers that run in the European Union.', policy: { objective: 'balanced', region: ['eu'] } },
]);

const builtinNames = () => BUILTINS.map((b) => b.name);
const isBuiltin = (name) => BUILTINS.some((b) => b.name === name);

/** A name the presets may carry: lower case, a letter or a digit first, at most 64 characters. */
function checkName(name) {
    const n = String(name == null ? '' : name).trim().toLowerCase();
    if (!NAME_RE.test(n)) throw new AiError(422, 'ai.invalid', 'a preset name is lower case, starts with a letter or a digit and is at most 64 characters');
    return n;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * The policy as it is stored and read: every knob normalised, unknown knobs dropped (never stored, so a
 * typo cannot come back as a rule nobody reads).
 */
function normalizePolicy(input) {
    if (input == null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new AiError(422, 'ai.invalid', 'a preset policy must be an object');
    const out = {};
    const objective = String(input.objective || '').trim().toLowerCase();
    if (objective) {
        if (!OBJECTIVES.includes(objective)) throw new AiError(422, 'ai.invalid', `objective must be one of ${OBJECTIVES.join(', ')}`);
        out.objective = objective;
    }
    const floor = String(input.floor || '').trim().toLowerCase();
    if (floor) {
        const mapped = FLOOR_ALIASES[floor] || floor;
        if (!FLOORS.includes(mapped)) throw new AiError(422, 'ai.invalid', `floor must be one of ${FLOORS.join(', ')}`);
        out.floor = mapped;
    }
    for (const key of ['ceiling', 'max_price']) {
        const value = num(input[key]);
        if (value === null) continue;
        if (!Number.isFinite(value) || value < 0) throw new AiError(422, 'ai.invalid', `${key} must be a number of US dollars per million tokens (0 or more)`);
        out[key] = value;
    }
    if (input.quantization != null) {
        const list = Array.isArray(input.quantization) ? input.quantization : [input.quantization];
        const quant = list.map((q) => String(q || '').trim().toLowerCase()).filter(Boolean);
        if (quant.length !== list.length || quant.some((q) => !/^[a-z0-9_.+-]{1,32}$/.test(q))) throw new AiError(422, 'ai.invalid', 'quantization must be a list of names like q4_k_m');
        if (quant.length) out.quantization = [...new Set(quant)];
    }
    if (input.region != null) {
        const list = Array.isArray(input.region) ? input.region : [input.region];
        const regions = list.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean);
        if (!regions.length || regions.some((r) => !REGIONS.includes(r))) throw new AiError(422, 'ai.invalid', `region must be one of ${REGIONS.join(', ')}`);
        out.region = [...new Set(regions)];
    }
    const dataPolicy = String(input.data_policy || '').trim().toLowerCase();
    if (dataPolicy) {
        if (!DATA_POLICIES.includes(dataPolicy)) throw new AiError(422, 'ai.invalid', `data_policy must be one of ${DATA_POLICIES.join(', ')}`);
        out.data_policy = dataPolicy;
    }
    if (input.community != null) {
        if (typeof input.community !== 'boolean') throw new AiError(422, 'ai.invalid', 'community must be true or false');
        out.community = input.community;
    }
    if (input.adult != null) {
        if (typeof input.adult !== 'boolean') throw new AiError(422, 'ai.invalid', 'adult must be true or false');
        out.adult = input.adult;
    }
    return out;
}

/** The owners a request may look a preset up under: its project first, then the person it acts for. */
function ownersOf(principal) {
    const out = [];
    if (principal && principal.kind === 'app' && principal.projectId) out.push({ type: 'project', id: String(principal.projectId) });
    const ob = principal && (principal.onBehalfOf || (principal.claims && principal.claims.on_behalf_of));
    const id = ob && typeof ob === 'object' ? ob.id : ob;
    if (id) out.push({ type: 'user', id: String(id) });
    if (principal && principal.subject && principal.subject.id) out.push({ type: principal.subject.type || 'service', id: String(principal.subject.id) });
    return out;
}

function createPresets({ db, clock = { now: () => Date.now() }, log = console } = {}) {
    const iso = () => new Date(clock.now()).toISOString();

    const select = db.prepare('SELECT * FROM ai_presets WHERE owner_type = ? AND owner_id = ? AND name = ?');
    const insert = db.prepare(`INSERT INTO ai_presets (owner_type, owner_id, name, policy, created_at, updated_at)
        VALUES (@owner_type, @owner_id, @name, @policy, @created_at, @updated_at)
        ON CONFLICT(owner_type, owner_id, name) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`);
    const remove = db.prepare('DELETE FROM ai_presets WHERE owner_type = ? AND owner_id = ? AND name = ?');

    const decode = (row) => (row ? {
        name: row.name, scope: 'owner', builtin: false,
        owner: { type: row.owner_type, id: row.owner_id },
        // The policy column is JSON: it comes back as text or as an object, depending on the driver.
        policy: (row.policy && typeof row.policy === 'object') ? row.policy : (parseJson(row.policy, {}) || {}),
        created_at: row.created_at, updated_at: row.updated_at,
    } : null);

    /** One owner's stored presets. */
    async function list(owner) {
        if (!owner) return [];
        const rows = await db.prepare('SELECT * FROM ai_presets WHERE owner_type = ? AND owner_id = ? ORDER BY name').all(owner.type, owner.id);
        return rows.map(decode);
    }

    /** The built-in presets, as they are named in the plan. */
    function builtins() {
        return BUILTINS.map((b) => ({ name: b.name, description: b.description, scope: 'builtin', builtin: true, policy: { ...b.policy } }));
    }

    /**
     * Every preset a caller may name: the built-in ones and the owner's own. The owner's own wins over a
     * built-in of the same name.
     */
    async function visible(principal) {
        const own = [];
        for (const owner of ownersOf(principal)) own.push(...await list(owner));
        const seen = new Set(own.map((p) => p.name));
        return [...own, ...builtins().filter((b) => !seen.has(b.name))];
    }

    /**
     * The preset a request names: the owner's own first (the first owner that has it), then the built-in one.
     * A name nobody has is ai.preset_not_found — never a silent default, so a typo is visible.
     */
    async function resolve({ principal, owners, name }) {
        const wanted = checkName(name);
        for (const owner of (owners && owners.length ? owners : ownersOf(principal))) {
            const row = decode(await select.get(owner.type, owner.id, wanted));
            if (row) return row;
        }
        const builtin = BUILTINS.find((b) => b.name === wanted);
        if (builtin) return { name: builtin.name, description: builtin.description, scope: 'builtin', builtin: true, policy: { ...builtin.policy } };
        throw new AiError(404, 'ai.preset_not_found', `no preset ${wanted}: GET /api/v1/presets lists the ones you may name`);
    }

    /** Store (or replace) one of the owner's presets. A built-in name cannot be overwritten: it is not the owner's. */
    async function put({ owner, name, policy }) {
        if (!owner || !owner.id) throw new AiError(422, 'ai.invalid', 'a preset belongs to an account or a project');
        const key = checkName(name);
        if (isBuiltin(key)) throw new AiError(409, 'ai.preset_builtin', `${key} is a built-in preset: give your own a different name`);
        const value = normalizePolicy(policy);
        const now = iso();
        await insert.run({ owner_type: owner.type, owner_id: owner.id, name: key, policy: JSON.stringify(value), created_at: now, updated_at: now });
        return decode(await select.get(owner.type, owner.id, key));
    }

    /** Delete one of the owner's presets. A built-in one is not theirs to delete. */
    async function remove_({ owner, name }) {
        if (!owner || !owner.id) throw new AiError(422, 'ai.invalid', 'a preset belongs to an account or a project');
        const key = checkName(name);
        if (isBuiltin(key)) throw new AiError(409, 'ai.preset_builtin', `${key} is a built-in preset: it cannot be deleted`);
        const r = await remove.run(owner.type, owner.id, key);
        return { name: key, removed: r.changes > 0 };
    }

    return { list, builtins, visible, resolve, put, remove: remove_, normalizePolicy, ownersOf };
}

/** The prefix a request uses to name a preset as its model: "@preset/cheapest". */
const PRESET_MODEL_PREFIX = '@preset/';

/**
 * The preset a request names, and the policy that goes with it.
 *
 *   model: "@preset/<name>"   the preset as the model
 *   preset: "<name>"          the preset beside the model
 *   max_price: 0.42           the hard cap on its own (USD per million tokens), whatever the preset says
 *
 * A request that names none and caps nothing has no preset: null comes back and nothing changes.
 */
async function resolveRequest({ presets, principal, body = {} } = {}) {
    const raw = body.model == null ? '' : String(body.model).trim();
    let name = null;
    let inline = null;
    if (raw.toLowerCase().startsWith(PRESET_MODEL_PREFIX)) name = raw.slice(PRESET_MODEL_PREFIX.length).trim();
    if (!name && typeof body.preset === 'string') name = body.preset.trim();
    if (!name && body.preset && typeof body.preset === 'object' && body.preset.policy && typeof body.preset.policy === 'object') {
        // A profile written in the request itself: { name?, policy: { … } }.
        inline = body.preset;
        name = typeof body.preset.name === 'string' ? body.preset.name.trim() : null;
    }
    if (!name && body.preset && typeof body.preset === 'object' && typeof body.preset.name === 'string') name = body.preset.name.trim();
    const hasCap = body.max_price != null && body.max_price !== '';
    if (!name && !inline && !hasCap) return null;
    let policy = {};
    let scope = 'request';
    let resolved = null;
    if (inline) {
        policy = normalizePolicy(inline.policy);
        scope = 'request';
    } else if (name) {
        if (!presets) throw new AiError(503, 'ai.preset_unavailable', 'routing presets are not available on this service');
        resolved = await presets.resolve({ principal, name });
        policy = { ...(resolved.policy || {}) };
        scope = resolved.scope || 'owner';
    }
    if (hasCap) {
        const cap = Number(body.max_price);
        if (!Number.isFinite(cap) || cap < 0) throw new AiError(422, 'ai.invalid', 'max_price must be a number of US dollars per million tokens');
        policy.max_price = cap;
    }
    return { name: resolved ? resolved.name : (name || 'request'), scope, policy };
}

module.exports = { createPresets, normalizePolicy, checkName, ownersOf, resolveRequest, BUILTINS, builtinNames, isBuiltin, NAME_RE, OBJECTIVES, FLOORS, DATA_POLICIES, REGIONS, PRESET_MODEL_PREFIX };
