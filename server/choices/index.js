'use strict';
/**
 * AI tasks and choices (rich-content plan §1): one system for which model does what, owned by OpenVibe.AI and managed
 * on Exchange. A task is a named piece of AI work with a kind; a choice names a model and the source it comes from
 * (OpenVibe's supply, the person's own key, or one of their machines through Link).
 *
 * Resolution, first match wins: the run's own choice, the person's saved choice for the task, their default for the
 * kind (ai.preferences.defaults), the owner's default for the task, and the network's built-in. The owner's defaults
 * are read through a 60-second cache and every change is audited with its before and after.
 */
const { AiError, iso } = require('../util');
const { PROVIDERS: ENGINES } = require('../research');

const KINDS = ['text', 'code', 'vision', 'image', 'search'];
const SOURCES = ['openvibe', 'keys', 'machines'];
const GENERAL = ['ai.generate', 'ai.complete', 'ai.image', 'research.gather'];
const MAX_COST_USD = 1000;
const CACHE_MS = 60000;

const built = (model = 'openvibe/auto') => ({ model, source: 'openvibe' });

// The tasks the plan names, seeded once. A service registers its own with POST /api/v1/tasks.
const SEEDS = [
    ['blog.devblog.write', 'text', 'Write a named devblog from the team’s changes.', 'ai.generate'],
    ['blog.devblog.art', 'image', 'Draw title art for a devblog.', 'ai.image'],
    ['wiki.article.write', 'text', 'Write a sourced wiki article.', 'ai.generate'],
    ['wiki.article.images', 'search', 'Find licensed pictures for a wiki article.', 'research.gather'],
    ['design.icon', 'code', 'Draw an original SVG icon.', 'ai.chat'],
    ['chat.reply', 'text', 'Answer a chat message.', 'ai.complete'],
    ['image.generate', 'image', 'Make an image from a description.', 'ai.image'],
    ['search.web', 'search', 'Find sources on the web.', 'research.gather'],
    ['search.images', 'search', 'Find licensed images.', 'research.gather'],
    ['blog.changelog.tag', 'text', 'Describe and tag a shipped change.', 'ai.generate'],
];

const MODEL_RE = /^[a-zA-Z0-9._:/@+\-]{1,200}$/;
const MACHINE_RE = /^(any|dev_[0-9A-HJKMNP-TV-Z]{26})$/;
const TASK_RE = /^[a-z][a-z0-9_-]*\.[a-z0-9_.-]{1,100}$/;
const ENGINE_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** One model and its source, or 422. A machine choice names the machine; no other source does. */
function choice(value) {
    const usable = value && typeof value === 'object' && !Array.isArray(value);
    const extra = usable ? Object.keys(value).filter((k) => !['model', 'source', 'machine'].includes(k)) : null;
    if (!usable || extra.length || !SOURCES.includes(value.source) || typeof value.model !== 'string' || !MODEL_RE.test(value.model)) {
        throw new AiError(422, 'choice.invalid', 'a choice needs a model and a source (openvibe, keys or machines)');
    }
    if (value.source === 'machines' ? !MACHINE_RE.test(value.machine || '') : value.machine != null) {
        throw new AiError(422, 'choice.invalid', 'only a machine choice names a machine');
    }
    return { model: value.model, source: value.source, ...(value.machine ? { machine: value.machine } : {}) };
}

/** The owner's default for one task (ai.task-defaults@1), checked field by field, or 422. */
function defaultValue(value) {
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || keys.some((k) => !['signed_out', 'signed_in', 'fallbacks', 'image_model', 'search_engines', 'max_cost_usd'].includes(k))
        || (value.fallbacks != null && !Array.isArray(value.fallbacks))) {
        throw new AiError(422, 'defaults.invalid', 'invalid task defaults');
    }
    const out = {
        signed_out: choice(value.signed_out),
        signed_in: choice(value.signed_in),
        fallbacks: (value.fallbacks || []).map(choice),
        image_model: value.image_model == null ? null : choice(value.image_model),
        search_engines: value.search_engines == null ? [] : value.search_engines,
        max_cost_usd: value.max_cost_usd == null ? null : value.max_cost_usd,
    };
    const all = [out.signed_out, out.signed_in, ...out.fallbacks, ...(out.image_model ? [out.image_model] : [])];
    if (all.some((c) => c.source !== 'openvibe')) throw new AiError(422, 'defaults.invalid', 'the owner’s defaults use OpenVibe supply');
    if (out.fallbacks.length > 10) throw new AiError(422, 'defaults.invalid', 'at most ten fallbacks');
    if (!Array.isArray(out.search_engines) || out.search_engines.length > 10
        || out.search_engines.some((e) => !e || !ENGINE_RE.test(e.engine) || typeof e.enabled !== 'boolean')
        || new Set(out.search_engines.map((e) => e.engine)).size !== out.search_engines.length) {
        throw new AiError(422, 'defaults.invalid', 'invalid search engine order');
    }
    if (out.max_cost_usd !== null && (typeof out.max_cost_usd !== 'number' || !Number.isFinite(out.max_cost_usd)
        || out.max_cost_usd < 0 || out.max_cost_usd > MAX_COST_USD)) {
        throw new AiError(422, 'defaults.invalid', `max_cost_usd must be 0–${MAX_COST_USD} or null`);
    }
    return out;
}

function createChoices({ db, registry, preferences, credentials, machines, catalog, adultStatus, ratings = async () => [], clock = { now: () => Date.now() } }) {
    let cached = null;
    let cachedAt = 0;

    const decode = (r) => r && ({ name: r.name, service: r.service, kind: r.kind, sentence: r.sentence, default: JSON.parse(r.builtin), workflow: r.workflow });
    const task = async (name) => decode(await db.prepare('SELECT * FROM ai_tasks WHERE name = ?').get(name));
    const tasks = async () => (await db.prepare('SELECT * FROM ai_tasks ORDER BY name').all()).map(decode);

    async function seed() {
        for (const [name, kind, sentence, workflow] of SEEDS) {
            const model = kind === 'search' ? (name === 'search.web' ? 'search/wikipedia' : 'search/commons') : 'openvibe/auto';
            await db.prepare('INSERT INTO ai_tasks (name, service, kind, sentence, builtin, workflow, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING')
                .run(name, name.split('.')[0], kind, sentence, JSON.stringify(built(model)), workflow, iso(clock.now()));
        }
        // Design's icon generator is the first consumer and what it already does becomes the owner's default:
        // signed out the cheapest good model, signed in Claude.
        await db.prepare('INSERT INTO ai_task_defaults (task, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (task) DO NOTHING')
            .run('design.icon', JSON.stringify({ signed_out: built('openvibe/cheapest'), signed_in: built('anthropic/claude-opus-5-5'), fallbacks: [built('openvibe/cheapest')], image_model: null, search_engines: [], max_cost_usd: 0.5 }), 'seed', iso(clock.now()));
    }

    async function register(body, service) {
        if (!body || !TASK_RE.test(body.name || '') || body.name.split('.')[0] !== service
            || !KINDS.includes(body.kind) || typeof body.sentence !== 'string' || !body.sentence.trim() || body.sentence.length > 300) {
            throw new AiError(422, 'task.invalid', 'register a named task in your service namespace with a kind and a sentence');
        }
        const c = choice(body.default);
        const workflow = body.workflow || body.name;
        if (!workflow.startsWith(`${service}.`) && !GENERAL.includes(workflow)) {
            throw new AiError(422, 'task.invalid', 'the workflow must belong to the service or be a general AI workflow');
        }
        await db.tx(async () => {
            await db.prepare(`INSERT INTO ai_tasks (name, service, kind, sentence, builtin, workflow, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, sentence = excluded.sentence, builtin = excluded.builtin, workflow = excluded.workflow, updated_at = excluded.updated_at`)
                .run(body.name, service, body.kind, body.sentence, JSON.stringify(c), workflow, iso(clock.now()));
            await registry.audit(service, 'task.register', 'task', body.name, { metadata: { kind: body.kind } });
        });
        return task(body.name);
    }

    async function defaults() {
        if (!cached || clock.now() - cachedAt >= CACHE_MS) {
            cached = Object.fromEntries((await db.prepare('SELECT * FROM ai_task_defaults ORDER BY task').all()).map((r) => [r.task, JSON.parse(r.value)]));
            cachedAt = clock.now();
        }
        return structuredClone(cached);
    }

    async function putDefaults(body, actor) {
        if (!body || !Array.isArray(body.defaults) || body.defaults.length > 200) throw new AiError(422, 'defaults.invalid', 'defaults must be a list of task settings');
        const list = [];
        for (const row of body.defaults) {
            if (!await task(row.task)) throw new AiError(404, 'task.not_found', 'unknown task');
            list.push([row.task, defaultValue(row.value)]);
        }
        await db.tx(async () => {
            for (const [name, value] of list) {
                const before = await db.prepare('SELECT value FROM ai_task_defaults WHERE task = ?').get(name);
                await db.prepare(`INSERT INTO ai_task_defaults (task, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (task) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
                    .run(name, JSON.stringify(value), actor, iso(clock.now()));
                await registry.audit(actor, 'task.defaults', 'task', name, { metadata: { before: before ? JSON.parse(before.value) : null, after: value } });
            }
        });
        cached = null;
        return defaults();
    }

    async function save(subject, name, value) {
        if (!await task(name)) throw new AiError(404, 'task.not_found', 'unknown task');
        const c = choice(value);
        await db.prepare(`INSERT INTO ai_task_choices (subject, task, choice, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (subject, task) DO UPDATE SET choice = excluded.choice, updated_at = excluded.updated_at`)
            .run(subject, name, JSON.stringify(c), iso(clock.now()));
        return c;
    }

    /** The resolved choice for a task: first match wins, and `why` says which step picked it. */
    async function resolve(name, { subject = null, choice: explicit = null } = {}) {
        let t = await task(name);
        if (!t) {
            // A workflow without a registered task resolves as one: the caller may use any workflow.
            const wf = await registry.activeWorkflow(name);
            if (!wf) throw new AiError(404, 'task.not_found', `unknown task ${name}`);
            t = { name, kind: wf.steps.some((s) => s.kind === 'image') ? 'image' : 'text', sentence: wf.name, default: built(), workflow: name };
        }
        const owner = (await defaults())[name] || null;
        const saved = subject ? await db.prepare('SELECT choice FROM ai_task_choices WHERE subject = ? AND task = ?').get(subject, name) : null;
        const prefs = subject && preferences ? await preferences.get(subject) : null;
        const perKind = prefs && prefs.defaults ? prefs.defaults[t.kind] : null;
        const fromOwner = (owner && (t.kind === 'image' && owner.image_model ? owner.image_model : subject ? owner.signed_in : owner.signed_out)) || null;
        const picked = explicit ? { value: choice(explicit), why: 'run' }
            : saved ? { value: JSON.parse(saved.choice), why: 'saved' }
                : perKind && perKind !== 'auto' ? { value: built(perKind), why: 'kind' }
                    : fromOwner ? { value: fromOwner, why: 'owner' }
                        : { value: t.default, why: 'builtin' };
        if (picked.value.source !== 'openvibe' && !subject) throw new AiError(401, 'choice.sign_in', 'sign in to use your keys or machines');
        if (prefs && prefs.only_my_keys && picked.value.source === 'openvibe') throw new AiError(422, 'ai.needs_key', 'only_my_keys is on; choose one of your keys or machines');
        return {
            task: t, choice: picked.value, why: picked.why, only_my_keys: Boolean(prefs && prefs.only_my_keys),
            // A fallback is the owner's list, so it applies only when the owner's default supplied the choice.
            fallbacks: picked.why === 'owner' ? owner.fallbacks : [],
            max_cost_usd: owner ? owner.max_cost_usd : null,
            search_engines: owner ? owner.search_engines : [],
        };
    }

    /** What the chip's sheet shows: the resolved choice, why, and the options grouped by source. */
    async function get(name, { subject = null } = {}) {
        const resolved = await resolve(name, { subject });
        if (resolved.task.kind === 'search') {
            return {
                ...resolved, recommended: resolved.choice, adult: false,
                options: {
                    openvibe: ENGINES.map((engine) => ({ model: `search/${engine}`, source: 'openvibe', name: engine, maker: null, price_estimate_usd: engine === 'deepseek' ? null : 0, speed_ms: null, quality: null, adult: false })),
                    keys: [], machines: [],
                },
            };
        }
        const [qualityRows, adult, raw, keys, own] = await Promise.all([
            ratings(),
            subject && adultStatus ? adultStatus.adultFor(subject).catch(() => false) : false,
            catalog.models({ kind: resolved.task.kind === 'image' ? 'image' : 'chat' }),
            subject && credentials ? credentials.listSelf(subject) : [],
            subject && machines ? machines.mine(subject).catch(() => []) : [],
        ]);
        const options = { openvibe: [], keys: [], machines: [] };
        for (const m of raw.models) {
            if (m.uncensored && !adult) continue;
            if (resolved.task.kind === 'vision' && !(m.capabilities && m.capabilities.vision)) continue;
            // An estimate for one run: 1,000 input and 1,000 output tokens, the plan's own measure.
            const prices = m.offers.filter((o) => o.price).map((o) => (o.price.in + o.price.out) / 1000);
            const speeds = m.offers.map((o) => o.speed && o.speed.p50_ms).filter((n) => n != null).sort((a, b) => a - b);
            const rated = qualityRows.find((r) => r.id === m.canonical);
            const row = {
                model: m.canonical, source: 'openvibe', name: m.name, maker: m.canonical.split('/')[0],
                price_estimate_usd: prices.length ? Math.min(...prices) : null,
                speed_ms: speeds.length ? speeds[0] : null,
                quality: rated && rated.rating ? (rated.rating.value ?? rated.rating.rating ?? null) : null,
                adult: Boolean(m.uncensored),
            };
            options.openvibe.push(row);
            if (keys.some((key) => m.offers.some((o) => o.provider === key.provider))) options.keys.push({ ...row, source: 'keys', price_estimate_usd: 0 });
        }
        for (const machine of own) {
            if (!machine.online) continue;
            for (const model of machine.models) {
                options.machines.push({ model, source: 'machines', machine: machine.id, name: model, maker: null, machine_name: machine.name, price_estimate_usd: 0, speed_ms: null, quality: null, adult: false });
            }
        }
        const owner = (await defaults())[name];
        const recommended = owner ? (subject ? owner.signed_in : owner.signed_out) : resolved.task.default;
        // A dynamic choice (openvibe/auto, openvibe/cheapest) shows the cheapest priced model it may use, so the chip
        // names a real model before it runs; the run itself still goes through the router.
        const priced = options.openvibe.filter((o) => o.price_estimate_usd != null && !o.adult).sort((a, b) => a.price_estimate_usd - b.price_estimate_usd);
        const concrete = (c) => !c.model.startsWith('openvibe/') || !priced.length ? c : choice({ model: priced[0].model, source: 'openvibe' });
        return { ...resolved, choice: concrete(resolved.choice), recommended: concrete(recommended), options, adult };
    }

    return { seed, tasks, task, register, defaults, putDefaults, save, resolve, get };
}

module.exports = { createChoices, choice, defaultValue, SEEDS, KINDS, SOURCES };
