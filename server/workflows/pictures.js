'use strict';
/**
 * The image task (rich-content plan §4/§5): one workflow, `image.picture`, with two modes.
 *
 *   find  licensed pictures from Wikimedia Commons and Openverse, with the licence, the author and the
 *         source page kept. Nothing without a licence that allows reuse is fetched or uploaded. Each
 *         picture goes to OpenVibe.Media; the answer names the Media object, never inline bytes.
 *   make  the owner's configured image model, through the ordinary provider routing: a dry run first
 *         (image count, model, per-image price, total), then a priced reserve/estimate, the provider
 *         call, and one Media object per returned image labelled "Made with AI (<model>)".
 *
 * The task is the one Blog's editor and Wiki's editor/writer share. It never publishes and never
 * attaches anything: a Media id is a candidate an editor chooses.
 */
const { AiError, sha256 } = require('../util');
const { canonicalOf } = require('../exchange/catalog');

const MODES = ['find', 'make'];
const SOURCES = ['commons', 'openverse'];
const STR = (n) => ({ type: 'string', maxLength: n });
const NULLABLE = (n) => ({ type: ['string', 'null'], maxLength: n });
const INT = (lo, hi) => ({ type: 'integer', minimum: lo, maximum: hi });

const MEDIA = {
    type: 'object', additionalProperties: false,
    required: ['media_id', 'url', 'ai'],
    properties: {
        media_id: STR(80), url: STR(2048), width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] },
        title: NULLABLE(300), alt: NULLABLE(400), caption: NULLABLE(500), credit: NULLABLE(300),
        author: NULLABLE(200), license: NULLABLE(200), license_url: NULLABLE(2048), source_url: NULLABLE(2048),
        provider: STR(80), ai: { type: 'boolean' }, model: NULLABLE(200),
    },
};

const ESTIMATE = {
    type: 'object', additionalProperties: false, required: ['model', 'source', 'images', 'per_image_usd', 'price_usd'],
    properties: {
        model: STR(200), source: STR(10), images: INT(1, 4),
        per_image_usd: { type: ['number', 'null'], minimum: 0 }, price_usd: { type: ['number', 'null'], minimum: 0 },
    },
};

const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const creditOf = (img) => [oneLine(img.author, 120), oneLine(img.license, 80)].filter(Boolean).join(', ');
const sourceOf = (provider) => (String(provider || '').toLowerCase().startsWith('openverse') ? 'openverse' : 'commons');
const slug = (s) => oneLine(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'picture';

/** The bytes' real type, from their first bytes: a provider or a source is not asked what it sent. */
function mimeOf(bytes) {
    if (bytes && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes && bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    if (bytes && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return 'image/png';
}

/** A provider whose capacity is already paid for: never metered, so a picture costs nothing. */
function freeProvider(provider) {
    return Boolean(provider) && (provider.kind === 'stub' || provider.kind === 'whisper'
        || Boolean(provider.metadata && (provider.metadata.local || provider.metadata.paid === false))
        || ['subscription', 'free', 'byok'].includes(provider.billing_profile));
}

const perImagePrice = (row) => {
    const n = Number(row && row.metadata && row.metadata.price_per_image_usd);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

const workflows = [{
    key: 'image.picture', name: 'Find or make a picture', namespace: 'image',
    description: 'One image task with two modes: find a licensed picture on Wikimedia Commons or Openverse (licence, author and source kept), or make one with the owner\'s configured image model. Every picture is stored in OpenVibe.Media and returned by reference.',
    input_schema: {
        type: 'object', additionalProperties: false, required: ['mode'],
        properties: {
            mode: { enum: MODES },
            query: STR(200), providers: { type: 'array', maxItems: SOURCES.length, uniqueItems: true, items: { enum: SOURCES } },
            count: INT(1, 12), prompt: STR(4000), alt: STR(300), n: INT(1, 4),
            // The Media tenant the calling product keeps its pictures in (Blog/Wiki pass theirs so their own
            // Media attach panel can see the object); absent, the AI tenant.
            media_app: { enum: ['ai', 'blog', 'wiki', 'media', 'pics'] },
            size: { type: 'string', pattern: '^[0-9]{3,4}x[0-9]{3,4}$' }, dry_run: { type: 'boolean' },
        },
    },
    output_schema: {
        type: 'object', additionalProperties: false,
        required: ['mode', 'task', 'media', 'count', 'gaps'],
        properties: {
            mode: { enum: MODES }, task: STR(40), query: NULLABLE(200), prompt: NULLABLE(4000), dry_run: { type: 'boolean' },
            estimate: { anyOf: [ESTIMATE, { type: 'null' }] },
            media: { type: 'array', maxItems: 12, items: MEDIA },
            count: INT(0, 12), gaps: { type: 'array', maxItems: 24, items: STR(300) }, note: NULLABLE(500),
        },
    },
    // Find reads our own picture sources (no route); make resolves default.image itself, so the workflow can be
    // created and find can run when no image model is configured yet.
    steps: [{ kind: 'picture' }], default_route: null, cache_mode: 'none',
    metadata: {
        creation: {
            id: 'picture', product: 'media', name: 'Find or make a picture', workflow: 'image.picture', task: 'image.picture',
            gives: 'A search for a licensed picture, or a description of one to make.',
            returns: 'Pictures in OpenVibe.Media, with their licence and author or the model that made them.',
            access: { guest: false, signed_in: true, floor_18: false }, costs_coins: true,
            start_url: 'https://openvibe.media/',
        },
    },
}];

function createPictures({ registry, pool, fetcher, config = {}, db = null, clock = { now: () => Date.now() }, mediaStore = null, research = null, routeFor = null, log = console } = {}) {
    const pictureConfig = config.pictures || {};
    const subjectOf = (ctx) => {
        const v = ctx && ctx.onBehalfOf;
        const id = typeof v === 'string' ? v : (v && v.id ? String(v.id) : null);
        return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || '')) ? String(id) : null;
    };

    /** The task's own choice (the owner's image model for make; the engines for find), or null. */
    const planOf = (ctx) => (ctx && ctx.taskChoice) || null;

    function enginesFor(plan, input) {
        const asked = Array.isArray(input.providers) && input.providers.length ? input.providers : null;
        const owner = plan && Array.isArray(plan.search_engines)
            ? plan.search_engines.filter((e) => e && e.enabled !== false && SOURCES.includes(e.engine)).map((e) => e.engine)
            : [];
        return (asked || (owner.length ? owner : SOURCES)).filter((e, i, a) => SOURCES.includes(e) && a.indexOf(e) === i);
    }

    /**
     * The model offers the owner's image choice names, cheapest first, with a per-image price. A paid
     * offer without metadata.price_per_image_usd is refused rather than guessed at; a prepaid, free or
     * local offer costs 0.
     */
    async function pricedOffers(picked) {
        const [rows, providers] = await Promise.all([registry.listModels(), registry.listProviders()]);
        const byKey = new Map(providers.map((p) => [p.key, p]));
        const dynamic = String(picked.model || '').startsWith('openvibe/');
        const out = [];
        for (const row of rows) {
            if (row.type !== 'image' || row.status !== 'active') continue;
            const provider = byKey.get(row.provider_key);
            if (!provider || provider.status !== 'active') continue;
            const id = canonicalOf(row, provider);
            if (!dynamic && id !== picked.model && row.model_key !== picked.model) continue;
            const adult = Boolean(row.metadata && row.metadata.uncensored) || /uncensor|abliterat/i.test(`${id} ${(row.metadata && row.metadata.variant) || ''}`);
            if (dynamic && adult) continue;
            const price = perImagePrice(row);
            out.push({ id, provider: provider.key, model: row.model_key, row, free: freeProvider(provider), price });
        }
        out.sort((a, b) => (a.price == null ? Infinity : a.price) - (b.price == null ? Infinity : b.price));
        if (!out.length) throw new AiError(422, 'choice.unavailable', `no deployment of ${picked.model} is available`);
        return out;
    }

    /** Pictures the subject has made today (UTC), in images: the owner's daily cap counts what was actually made. */
    async function madeToday(subject) {
        if (!db || !subject) return 0;
        const day = new Date(clock.now()).toISOString().slice(0, 10);
        const row = await db.prepare(
            "SELECT COALESCE(SUM(tokens_out), 0) AS n FROM runs WHERE workflow_key = 'image.picture' AND status = 'succeeded' AND created_at >= ? AND (on_behalf_of::jsonb->>'id') = ?",
        ).get(`${day}T00:00:00.000Z`, subject).catch(() => null);
        return Number(row && row.n) || 0;
    }

    async function find(input, plan, ctx) {
        const query = oneLine(input.query, 200);
        if (!query) throw new AiError(422, 'input.invalid', 'find needs a query');
        const limit = Math.max(1, Math.min(12, Number(input.count) || 8));
        const engines = enginesFor(plan, input);
        if (!engines.length) throw new AiError(422, 'choice.unavailable', 'no licensed picture source is enabled for this task');
        if (!research) throw new AiError(503, 'source.unavailable', 'picture research is not available');
        let gathered = null;
        const gaps = [];
        try {
            gathered = await research().gather({ query, images: true, providers: engines, max_images: Math.max(limit * 2, limit), content_chars: 800 }, { signal: ctx && ctx.signal, allowPaid: false, allowFabric: false });
        } catch (err) {
            if (ctx && ctx.signal && ctx.signal.aborted) throw err;
            throw new AiError(502, 'source.unavailable', `no picture source answered for "${query}": ${oneLine(err && err.message, 200)}`);
        }
        const found = (gathered && Array.isArray(gathered.images) ? gathered.images : [])
            .filter((img) => img && img.free === true && img.license && oneLine(img.license, 200))
            .filter((img) => SOURCES.includes(sourceOf(img.provider)));
        for (const [name, p] of Object.entries((gathered && gathered.providers) || {})) {
            if (p && p.ok === false) gaps.push(`${name}: ${oneLine(p.skipped || p.error, 160) || 'did not answer'}`);
        }
        const media = [];
        const seen = new Set();
        for (const img of found) {
            if (media.length >= limit) break;
            const source = sourceOf(img.provider);
            const page = img.source_url || img.original || img.url;
            if (!page || seen.has(page)) continue;
            seen.add(page);
            try {
                const got = await fetcher.fetchPicture(img.thumbnail || img.url, { signal: ctx && ctx.signal });
                const mime = got.mime && /^image\//.test(got.mime) ? got.mime : mimeOf(got.bytes);
                const stored = await mediaStore.put({
                    bytes: got.bytes, mime, filename: `${slug(img.title || query)}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'}`,
                    owner: subjectOf(ctx), app: input.media_app || null,
                    metadata: { title: oneLine(img.title, 200) || query, source_url: page, license: oneLine(img.license, 200), license_url: img.license_url || null, author: oneLine(img.author, 200) || null, provider: img.provider || source, origin: 'image.picture.find', free: true },
                });
                media.push({
                    media_id: stored.media_id, url: stored.url || mediaStore.publicUrl(stored.media_id),
                    width: Number.isInteger(stored.width) ? stored.width : (Number.isInteger(img.width) ? img.width : null),
                    height: Number.isInteger(stored.height) ? stored.height : (Number.isInteger(img.height) ? img.height : null),
                    title: oneLine(img.title, 300) || null, alt: oneLine(img.description || img.title, 400) || null,
                    caption: oneLine(img.description || img.title, 500) || null, credit: creditOf(img) || null,
                    author: oneLine(img.author, 200) || null, license: oneLine(img.license, 200),
                    license_url: img.license_url || null, source_url: page, provider: img.provider || source,
                    ai: false, model: null,
                });
            } catch (err) {
                if (ctx && ctx.signal && ctx.signal.aborted) throw err;
                gaps.push(`${img.title || source}: ${oneLine(err && err.message, 200) || 'not fetched'}`);
            }
        }
        const exec = { provider: 'research', model: engines.join('+'), usage: { input: 0, output: 0, cached: 0 }, cost: 0, synthetic: false, fallbackUsed: false, explain: null };
        return {
            output: {
                mode: 'find', task: 'image.picture', query, prompt: null, dry_run: false, estimate: null,
                media, count: media.length, gaps: gaps.slice(0, 24),
                note: media.length ? null : 'No licensed picture was found for this search.',
            },
            exec,
        };
    }

    async function make(input, plan, ctx, run) {
        const prompt = String(input.prompt || '').trim();
        if (!prompt) throw new AiError(422, 'input.invalid', 'make needs a prompt');
        const n = Math.max(1, Math.min(4, Number(input.n) || 1));
        const subject = subjectOf(ctx);
        if (!subject) throw new AiError(401, 'image.sign_in', 'Sign in to make an image');
        // The owner's switch: until an owner picks an image model for this task, make is off. The default
        // resolution never falls back to a signed-in model for image.picture's make mode.
        const picked = plan && plan.image_model ? plan.image_model : null;
        if (!picked) throw new AiError(503, 'image.make_unconfigured', 'The owner has not picked an image model for the picture task; set image_model in the image.picture task defaults.');
        const offers = await pricedOffers(picked);
        const chosen = offers[0];
        const perImage = chosen.price == null ? (chosen.free ? 0 : null) : chosen.price;
        if (perImage == null) throw new AiError(402, 'image.price_required', `the image model ${chosen.id} has no per-image price; set metadata.price_per_image_usd on the model before a paid picture can be made`);
        const estimate = { model: chosen.id, source: 'openvibe', images: n, per_image_usd: perImage, price_usd: perImage * n };
        if (plan.max_cost_usd != null && estimate.price_usd > plan.max_cost_usd) throw new AiError(402, 'choice.cost_ceiling', `the picture would cost about $${estimate.price_usd} and this task's per-run ceiling is $${plan.max_cost_usd}`);
        const cap = plan.daily_cap == null ? pictureConfig.defaultDailyCap : Number(plan.daily_cap);
        if (Number.isFinite(cap) && cap >= 0) {
            const made = await madeToday(subject);
            if (made + n > cap) throw new AiError(429, 'image.daily_cap', `this task's daily cap is ${cap} picture${cap === 1 ? '' : 's'} and ${made} ${made === 1 ? 'has' : 'have'} been made today`, { retry_after_seconds: 3600 });
        }
        if (input.dry_run) {
            return {
                output: {
                    mode: 'make', task: 'image.picture', query: null, prompt, dry_run: true, estimate, media: [], count: 0, gaps: [],
                    note: `Dry run: ${n} image${n === 1 ? '' : 's'} with ${chosen.id} at $${perImage} each, about $${estimate.price_usd}.`,
                },
                exec: { provider: null, model: chosen.model, usage: { input: 0, output: 0, cached: 0 }, cost: 0, synthetic: false, fallbackUsed: false, explain: null },
            };
        }
        const route = await ((routeFor || (async () => { throw new AiError(503, 'route.unavailable', 'the image route is not available'); }))('default.image'));
        const req = { prompt, size: input.size || ((config.image && config.image.size) || null), n, timeoutMs: route.timeout_ms || 180000 };
        const exec = await pool.execute(route, 'image', req, {
            ...ctx, taskChoice: null, exact: { id: chosen.id, offers: [{ provider: chosen.provider, model: chosen.model }] }, imagePriceUsd: perImage,
            routeKey: route.key, routeVersion: route.version, promptHash: sha256({ p: prompt, n }),
        });
        const images = ((exec.result && exec.result.images) || []).filter((i) => i && (i.b64 || i.url));
        if (!images.length) throw new AiError(502, 'output.invalid', 'no image was returned');
        exec.explain = {
            ...(exec.explain || {}),
            task_choice: {
                task: plan.task && plan.task.name ? plan.task.name : 'image.picture',
                requested: plan.choice, answered: { model: exec.model || chosen.model, source: 'openvibe' },
                why: plan.why || 'owner', fallback_index: 0,
            },
        };
        const model = exec.model || chosen.model;
        const label = `Made with AI (${model})`;
        const media = [];
        const gaps = [];
        for (const image of images) {
            try {
                let bytes; let mime;
                if (image.b64) {
                    bytes = Buffer.from(String(image.b64), 'base64');
                    mime = mimeOf(bytes);
                } else {
                    const got = await fetcher.fetchPicture(image.url, { signal: ctx && ctx.signal });
                    bytes = got.bytes;
                    mime = got.mime && /^image\//.test(got.mime) ? got.mime : mimeOf(bytes);
                }
                const alt = oneLine(input.alt, 300) || oneLine(prompt, 300);
                const stored = await mediaStore.put({
                    bytes, mime, filename: `${slug(input.alt || prompt)}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'}`, owner: subject, app: input.media_app || null,
                    metadata: { title: alt, alt, caption: label, ai: true, model, generated_with: model, prompt: prompt.slice(0, 1000), origin: 'image.picture.make' },
                });
                media.push({
                    media_id: stored.media_id, url: stored.url || mediaStore.publicUrl(stored.media_id),
                    width: Number.isInteger(stored.width) ? stored.width : null, height: Number.isInteger(stored.height) ? stored.height : null,
                    title: alt, alt, caption: alt ? `${alt} (${label})` : label, credit: label,
                    author: null, license: null, license_url: null, source_url: null, provider: exec.provider || 'image', ai: true, model,
                });
            } catch (err) {
                if (ctx && ctx.signal && ctx.signal.aborted) throw err;
                gaps.push(`the picture could not be stored: ${oneLine(err && err.message, 240)}`);
            }
        }
        if (!media.length) throw new AiError(502, 'media.upload_refused', `the image was made but no picture reached Media${gaps.length ? `: ${gaps[0]}` : ''}`);
        return {
            output: {
                mode: 'make', task: 'image.picture', query: null, prompt, dry_run: false, estimate, media,
                count: media.length, gaps: gaps.slice(0, 24), note: null,
            },
            exec,
        };
    }

    const step = async (s, input, wf, run, ctx) => {
        const plan = planOf(ctx);
        if (input.mode === 'find') {
            // Guest find is the owner's switch: a run with no person may read Commons and Openverse only when
            // the owner allowed it; the pictures then belong to the AI tenant.
            if (!subjectOf(ctx) && !(plan && plan.guest_find === true)) throw new AiError(401, 'image.guest_forbidden', 'Guests may not find pictures for this task; the owner can allow it in the image.picture task defaults.');
            return await find(input, plan, ctx);
        }
        if (input.mode === 'make') return await make(input, plan, ctx, run);
        throw new AiError(422, 'input.invalid', 'mode must be find or make');
    };

    return { step, modes: MODES, sources: SOURCES };
}

module.exports = { templates: [], workflows, createPictures, mimeOf, freeProvider, perImagePrice };
