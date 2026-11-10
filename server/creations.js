'use strict';
/**
 * The catalogue of things AI can make (owner, 11-09, item 45): one entry per creation, built from the
 * registered workflows and tasks rather than a hand-kept list.
 *
 *   catalogue({ workflows, tasks })   the live entries, for GET /api/v1/creations
 *   renderMarkdown(creations)         the same list as Markdown, for GET /api/v1/creations.md
 *   problems({ workflows, tasks })    [] when the catalogue and the registry agree, else every drift
 *
 * An entry lives on the workflow that does the work: its definition carries `metadata.creation`, so
 * registering the workflow registers its catalogue entry. A creation that is a task rather than a
 * workflow (Design's icon drawing) is declared in TASK_CREATIONS and must name a registered task.
 *
 * The check is deliberately two-way:
 *   - every workflow in a product namespace has a catalogue entry or `metadata.internal: true`, so a
 *     new person-facing workflow cannot be registered without saying what it makes (or that it is not
 *     a creation);
 *   - every entry names a workflow or task that exists, and an entry on a workflow names that workflow.
 *
 * Only live things are listed: a workflow whose registry status is not `active`, or a task that is gone
 * or whose workflow is not active, is left out. The platform namespaces (live, network, ai, chat,
 * research) are not product surfaces and need no entry.
 */

// The product namespaces: a workflow here is something a person uses, so it declares what it makes.
const CATALOGUE_NAMESPACES = new Set(['blog', 'codes', 'coupons', 'deals', 'food', 'games', 'media', 'meme', 'moderation', 'news', 'pics', 'rent', 'reviews', 'space', 'tools', 'trade', 'wiki']);

const PRODUCTS = ['ai', 'blog', 'codes', 'community', 'design', 'food', 'games', 'live', 'media', 'meme', 'news', 'pics', 'quest', 'rent', 'reviews', 'space', 'tools', 'trade', 'wiki'];

const PRODUCT_NAMES = {
    ai: 'AI', blog: 'Blog', codes: 'Codes', community: 'Community', design: 'Design', food: 'Food', games: 'Games',
    live: 'Live', media: 'Media', meme: 'Meme', news: 'News', pics: 'Pics', quest: 'Quest', rent: 'Rent',
    reviews: 'Reviews', space: 'Space', tools: 'Tools', trade: 'Trade', wiki: 'Wiki',
};

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const KEY_RE = /^[a-z][a-z0-9_-]*\.[a-z0-9_.-]{1,100}$/;
const ENTRY_FIELDS = ['id', 'product', 'name', 'gives', 'returns', 'access', 'costs_coins', 'start_url'];

// Creations that are a registered task rather than a workflow (rich-content plan §1). The task names the
// workflow it runs, so the entry is listed only while both the task and that workflow are live.
const TASK_CREATIONS = [
    {
        id: 'icon',
        product: 'design',
        name: 'Draw an icon',
        gives: 'A name for the icon and what it stands for.',
        returns: 'Up to four line drawings in OpenVibe\'s hand, each with its solid twin, checked before you see them.',
        task: 'design.icon',
        workflow: 'ai.chat',
        access: { guest: true, signed_in: true, floor_18: false },
        costs_coins: true,
        start_url: 'https://openvibe.design/icons',
    },
];

/** One creation as the API answers it: the catalogue fields, with the workflow and task it names. */
function entryOf(source, { workflow = null, task = null } = {}) {
    return {
        id: source.id,
        product: source.product,
        name: source.name,
        gives: source.gives,
        returns: source.returns,
        workflow: source.workflow !== undefined ? source.workflow : workflow,
        task: source.task !== undefined ? source.task : task,
        access: { guest: Boolean(source.access && source.access.guest), signed_in: Boolean(source.access && source.access.signed_in), floor_18: Boolean(source.access && source.access.floor_18) },
        costs_coins: Boolean(source.costs_coins),
        start_url: source.start_url,
    };
}

/** What is wrong with one entry, as plain sentences ([] when it is complete). */
function entryProblems(entry, where) {
    const bad = [];
    if (!entry || typeof entry !== 'object') return [`${where}: not an object`];
    for (const k of Object.keys(entry)) if (!ENTRY_FIELDS.includes(k) && !['workflow', 'task'].includes(k)) bad.push(`${where}: unknown field ${k}`);
    if (!ID_RE.test(String(entry.id || ''))) bad.push(`${where}: id must be lowercase letters, digits and dashes`);
    if (!PRODUCTS.includes(entry.product)) bad.push(`${where}: unknown product ${entry.product}`);
    if (typeof entry.name !== 'string' || entry.name.length < 3 || entry.name.length > 80) bad.push(`${where}: name must be 3-80 characters`);
    if (typeof entry.gives !== 'string' || entry.gives.length < 3 || entry.gives.length > 300) bad.push(`${where}: gives must be 3-300 characters`);
    if (typeof entry.returns !== 'string' || entry.returns.length < 3 || entry.returns.length > 300) bad.push(`${where}: returns must be 3-300 characters`);
    if (typeof entry.costs_coins !== 'boolean') bad.push(`${where}: costs_coins must be a boolean`);
    if (typeof entry.start_url !== 'string' || !/^https:\/\/[^\s]+$/.test(entry.start_url)) bad.push(`${where}: start_url must be an https URL`);
    const a = entry.access;
    if (!a || typeof a.guest !== 'boolean' || typeof a.signed_in !== 'boolean' || typeof a.floor_18 !== 'boolean') bad.push(`${where}: access needs guest, signed_in and floor_18 booleans`);
    else if (!a.guest && !a.signed_in) bad.push(`${where}: nobody may use it (access.guest and access.signed_in are both false)`);
    if (entry.workflow != null && !KEY_RE.test(String(entry.workflow))) bad.push(`${where}: workflow is not a workflow key`);
    if (entry.task != null && !KEY_RE.test(String(entry.task))) bad.push(`${where}: task is not a task key`);
    if (entry.workflow == null && entry.task == null) bad.push(`${where}: names neither a workflow nor a task`);
    return bad;
}

function sortKey(entry) {
    return `${String(entry.product)} ${String(entry.name)} ${String(entry.id)}`;
}

/**
 * The live catalogue. `workflows` are registry records (key, status, metadata); `tasks` are the registered
 * tasks (name, workflow). Nothing is listed unless the workflow doing the work is active.
 */
function catalogue({ workflows = [], tasks = [] } = {}) {
    const live = new Map(workflows.filter((w) => w && w.status === 'active').map((w) => [w.key, w]));
    const taskByName = new Map(tasks.filter((t) => t && t.name).map((t) => [t.name, t]));
    const seen = new Set();
    const out = [];

    for (const w of live.values()) {
        const c = w.metadata && w.metadata.creation;
        if (!c) continue;
        if (c.workflow !== w.key) continue;                    // a typo: the check names it, the API leaves it out
        const entry = entryOf(c, { workflow: w.key });
        if (entryProblems(entry, w.key).length || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }

    for (const c of TASK_CREATIONS) {
        const t = taskByName.get(c.task);
        if (!t) continue;
        if (c.workflow && !live.has(c.workflow)) continue;
        const entry = entryOf(c);
        if (entryProblems(entry, c.id).length || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }

    return out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

/** Every way the catalogue and the registry disagree, as plain sentences ([] when they agree). */
function problems({ workflows = [], tasks = [] } = {}) {
    const bad = [];
    const workflowKeys = new Set(workflows.filter((w) => w && w.key).map((w) => w.key));
    const taskNames = new Set(tasks.filter((t) => t && t.name).map((t) => t.name));
    const ids = new Map();

    for (const w of workflows) {
        if (!w || !w.key) continue;
        const c = w.metadata && w.metadata.creation;
        if (!c) {
            if (CATALOGUE_NAMESPACES.has(String(w.key).split('.')[0]) && !(w.metadata && w.metadata.internal)) {
                bad.push(`${w.key}: a product workflow needs metadata.creation (what a person can make) or metadata.internal: true`);
            }
            continue;
        }
        const entry = entryOf(c);
        const where = `${w.key} (metadata.creation)`;
        bad.push(...entryProblems(entry, where));
        if (c.workflow !== w.key) bad.push(`${where}: workflow must be "${w.key}" (it names ${JSON.stringify(c.workflow)})`);
        if (c.task != null && !taskNames.has(c.task)) bad.push(`${where}: task ${c.task} is not registered`);
        if (ids.has(entry.id)) bad.push(`${where}: id ${entry.id} is also used by ${ids.get(entry.id)}`);
        else ids.set(entry.id, w.key);
    }

    for (const c of TASK_CREATIONS) {
        const entry = entryOf(c);
        const where = `${c.id} (TASK_CREATIONS)`;
        bad.push(...entryProblems(entry, where));
        if (!taskNames.has(c.task)) bad.push(`${where}: task ${c.task} is not registered`);
        if (c.workflow != null && !workflowKeys.has(c.workflow)) bad.push(`${where}: workflow ${c.workflow} does not exist`);
        if (ids.has(entry.id)) bad.push(`${where}: id ${entry.id} is also used by ${ids.get(entry.id)}`);
        else ids.set(entry.id, 'TASK_CREATIONS');
    }

    return bad;
}

const ACCESS = (a) => (a.guest && a.signed_in ? 'Anyone, signed in or not' : a.guest ? 'Anyone' : 'Signed in');

/** The same catalogue as Markdown, grouped by product: for GET /api/v1/creations.md and /llms.txt. */
function renderMarkdown(creations, { generatedAt = null, heading = true } = {}) {
    const byProduct = new Map();
    for (const c of creations) {
        if (!byProduct.has(c.product)) byProduct.set(c.product, []);
        byProduct.get(c.product).push(c);
    }
    const lines = [];
    if (heading) {
        lines.push(
            '# What AI can make on OpenVibe',
            '',
            `${creations.length} creation${creations.length === 1 ? '' : 's'}, built from the workflows and tasks that are live now${generatedAt ? ` (as of ${generatedAt})` : ''}.`,
            '',
            'The same list as data: GET https://ai.openvibe.services/api/v1/creations (public, cached, CORS open) and its contract `ai.creation-list@1`.',
            '',
        );
    }
    for (const [product, list] of [...byProduct.entries()].sort((a, b) => PRODUCT_NAMES[a[0]].localeCompare(PRODUCT_NAMES[b[0]]))) {
        lines.push(`## ${PRODUCT_NAMES[product] || product}`, '');
        for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`### ${c.name}`, '');
            lines.push(`- You give it: ${c.gives}`);
            lines.push(`- You get back: ${c.returns}`);
            lines.push(`- Who: ${ACCESS(c.access)}${c.access.floor_18 ? ', 18+ only' : ''}`);
            lines.push(`- Cost: ${c.costs_coins ? 'a run may use paid AI after your free allowance' : 'free'}`);
            lines.push(`- Start here: ${c.start_url}`);
            lines.push(`- Behind it: ${c.workflow ? `workflow \`${c.workflow}\`` : ''}${c.workflow && c.task ? ' · ' : ''}${c.task ? `task \`${c.task}\`` : ''}`);
            lines.push('');
        }
    }
    return lines.join('\n');
}

module.exports = { catalogue, problems, renderMarkdown, CATALOGUE_NAMESPACES, PRODUCTS, PRODUCT_NAMES, TASK_CREATIONS };
