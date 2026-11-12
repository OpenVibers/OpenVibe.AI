'use strict';
/**
 * Public GPU marketplace prices: what the cards the provisioner uses (and the next sizes up) cost per hour,
 * on demand and interruptible, read from the providers' own public pages.
 *
 *   Vast.ai     POST /api/v0/bundles/          the public offer search (no account is needed to search)
 *   RunPod      GET  /pricing                  the public price table (secure and community columns)
 *   Salad       GET  /pricing/                 the public priority tiers (high is never preempted, lowest is)
 *   TensorDock  GET  /                         the public "from" prices on its home page
 *   CloudRift   GET  /pricing                  the public on-demand table (H100/H200 are quoted on request)
 *
 * The rules:
 *
 *   - Read only public pages. No account, key, rental, start or stop is ever made here.
 *   - One row per provider, card and kind: the lowest price that provider publishes right now. A source that
 *     cannot be read changes nothing; its last rows stay and are marked stale until it answers again.
 *   - The reading carries where it came from, when it was read, the region when the provider states one, and
 *     the reliability words the provider publishes. A number without those is not a price the owner can trust.
 *
 * The cache is in the database (migrations/0061_gpu_market_prices.sql) because AI is deployed several times a
 * day: a timer in the process would be reset by every deploy. The refresh is due-based, like the price book.
 */
const { AiError } = require('../util');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * HOUR_MS;
const DEFAULT_TICK_MS = HOUR_MS;
const DEFAULT_FIRST_TICK_MS = 2 * 60 * 1000;
const DEFAULT_STALE_MS = 12 * HOUR_MS;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The cards the owner asked about: the two the catalog runs on, and the next sizes up. `minVramMb` keeps a
 * 40 GB A100 out of the 80 GB row (Vast lists both under the same family names).
 */
const TARGETS = Object.freeze([
    { key: 'rtx-3090', gpu: 'RTX 3090', vram_mb: 24576, minVramMb: 24000, aliases: ['RTX 3090'] },
    { key: 'rtx-4090', gpu: 'RTX 4090', vram_mb: 24576, minVramMb: 24000, aliases: ['RTX 4090'] },
    { key: 'rtx-5090', gpu: 'RTX 5090', vram_mb: 32768, minVramMb: 32000, aliases: ['RTX 5090'] },
    { key: 'a100-80gb', gpu: 'A100 80GB', vram_mb: 81920, minVramMb: 80000, aliases: ['A100 SXM4', 'A100 PCIE', 'A100 80GB', 'A100-SXM4', 'A100-PCIE'] },
    { key: 'h100', gpu: 'H100', vram_mb: 81920, minVramMb: 80000, aliases: ['H100 SXM', 'H100 SXM5', 'H100 PCIE', 'H100 NVL', 'H100 80GB'] },
    { key: 'h200', gpu: 'H200', vram_mb: 141312, minVramMb: 140000, aliases: ['H200', 'H200 NVL', 'H200 SXM'] },
]);
const BY_KEY = new Map(TARGETS.map((t) => [t.key, t]));

const VAST_NAMES = TARGETS.flatMap((t) => t.aliases.filter((a) => !/^(A100 80GB|H100 80GB|H100 SXM5)$/.test(a)));

function nameOf(value) {
    return String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, ' ');
}

/** The target a marketplace name (and, when it publishes one, its memory) names, or null. */
function targetFor(name, memoryMb = null) {
    const normalized = nameOf(name);
    for (const target of TARGETS) {
        if (!target.aliases.some((a) => nameOf(a) === normalized)) continue;
        if (memoryMb != null && Number.isFinite(Number(memoryMb)) && Number(memoryMb) < target.minVramMb) continue;
        return target;
    }
    return null;
}

function usd(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function reliabilityOf(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** A reading in the one shape every source returns. */
function reading(target, kind, price, { region = '', reliability = null, note = '', source, variant = '' } = {}) {
    if (!target || !usd(price)) return null;
    return {
        gpu_key: target.key,
        gpu: target.gpu,
        vram_mb: target.vram_mb,
        kind,
        hourly_usd: usd(price),
        region: String(region || ''),
        reliability,
        note,
        variant: String(variant || ''),
        source,
    };
}

/** Vast.ai's public offer JSON: one reading per target, the caller keeps the lowest per provider/key/kind. */
function parseVast(bytes, kind) {
    const body = typeof bytes === 'string' ? JSON.parse(bytes) : bytes;
    const offers = (body && body.offers) || [];
    const out = [];
    for (const offer of offers) {
        // dph_total is the whole single-GPU hour (GPU plus the offer's storage); min_bid is the interruptible bid,
        // with storage billed on top. A multi-GPU offer's total is not comparable with a one-GPU hour.
        if (Number(offer.num_gpus) !== 1) continue;
        const target = targetFor(offer.gpu_name, offer.gpu_ram);
        if (!target) continue;
        const price = kind === 'spot' ? offer.min_bid : offer.dph_total;
        const verification = String(offer.verification || 'unknown');
        const note = kind === 'spot'
            ? `minimum bid; storage billed on top; ${verification} host`
            : `total includes the offer's storage; ${verification} host`;
        const row = reading(target, kind, price, {
            region: offer.geolocation || '',
            reliability: reliabilityOf(offer.reliability2 == null ? offer.reliability : offer.reliability2),
            note,
            variant: String(offer.gpu_name || ''),
            source: 'https://vast.ai/pricing',
        });
        if (row) out.push(row);
    }
    return out;
}

/** RunPod publishes on-demand rates for both Secure and Community Cloud; neither column is a spot quote. */
function parseRunpod(html) {
    const out = [];
    for (const chunk of String(html).split(/class="gpu_table-row"/).slice(1)) {
        const name = (chunk.match(/class="gpu_name[^"]*">([^<]+)</) || [])[1];
        if (!name) continue;
        const target = targetFor(name);
        if (!target) continue;
        const secure = (chunk.match(/data-secure="([\d.]+)"/) || [])[1];
        const community = (chunk.match(/data-community="([\d.]+)"/) || [])[1];
        const on = reading(target, 'on_demand', secure, {
            note: 'secure cloud (verified hosts)', variant: name.trim(), source: 'https://www.runpod.io/pricing',
        });
        const communityRate = reading(target, 'on_demand', community, {
            note: 'community cloud on-demand (third-party hosts; no spot quote published)',
            variant: name.trim(), source: 'https://www.runpod.io/pricing',
        });
        if (on) out.push(on);
        if (communityRate) out.push(communityRate);
    }
    return out;
}

/** Salad's price table: High is never preempted; Lowest is the most interruptible. */
function parseSalad(html) {
    const match = String(html).match(/<script[^>]*id=["']?gpu-prices["']?[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error('Salad pricing page has no gpu-prices table');
    const rows = JSON.parse(match[1]);
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const target = targetFor(row && row.name);
        if (!target) continue;
        const on = reading(target, 'on_demand', row.high, {
            note: 'high priority tier (never preempted by other workloads); vCPU and RAM included',
            variant: String(row.name || ''), source: 'https://salad.com/pricing/',
        });
        const spot = reading(target, 'spot', row.lowest, {
            note: 'lowest priority tier (the most interruptible); vCPU and RAM included',
            variant: String(row.name || ''), source: 'https://salad.com/pricing/',
        });
        if (on) out.push(on);
        if (spot) out.push(spot);
    }
    return out;
}

/** TensorDock's home page publishes a "from" price for its two most popular enterprise cards. */
function parseTensordock(html) {
    const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const out = [];
    for (const [key, re] of [
        ['h100', /H100 SXM5\s+From\s+\$([\d.]+)\s*\/hr/i],
        ['a100-80gb', /A100 SXM4\s+From\s+\$([\d.]+)\s*\/hr/i],
    ]) {
        const m = text.match(re);
        if (!m) continue;
        const target = BY_KEY.get(key);
        const row = reading(target, 'on_demand', m[1], {
            note: 'published "from" price on the TensorDock home page; the full marketplace list is behind its dashboard; no reliability score published',
            variant: key === 'h100' ? 'H100 SXM5' : 'A100 SXM4',
            source: 'https://www.tensordock.com/',
        });
        if (row) out.push(row);
    }
    return out;
}

/** RunPod's Serverless flex rates: the same pricing page, the per-second flex column. */
function parseRunpodServerless(html) {
    const out = [];
    for (const chunk of String(html).split(/class="gpu_table-row"/).slice(1)) {
        const name = (chunk.match(/class="gpu_name[^"]*">([^<]+)</) || [])[1];
        if (!name) continue;
        const target = targetFor(name);
        if (!target) continue;
        const flex = (chunk.match(/data-serverless="([\d.]+)"/) || [])[1];
        const row = reading(target, 'on_demand', flex, {
            note: 'Serverless flex, billed per second from worker start to stop and scaling to zero; the OpenAI-compatible vLLM endpoint is the same card hour',
            variant: name.trim(), source: 'https://www.runpod.io/pricing',
        });
        if (row) out.push(row);
    }
    return out;
}

/** A plain public price page: the card name followed by its published hourly rate. */
function parsePlainPrices(html, source, rows) {
    const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const out = [];
    for (const row of rows) {
        const normalized = row.name.replace(/ /g, '\\s+');
        const m = text.match(new RegExp(normalized + row.between + '\\$([\\d.]+)', 'i'));
        if (!m) continue;
        const parsed = reading(BY_KEY.get(row.key), row.kind, m[1], {
            note: row.note, variant: row.name, source,
        });
        if (parsed) out.push(parsed);
    }
    return out;
}

/** Verda's public price page: on-demand and, where it lists them, spot rates. */
function parseVerda(html) {
    return parsePlainPrices(html, 'https://verda.ai/pricing', [
        { key: 'h100', name: 'H100', between: '[\\s\\S]{0,120}?on.?demand[\\s\\S]{0,80}?', kind: 'on_demand', note: 'published on-demand rate; spot is listed on the same page and may be evicted without warning' },
        { key: 'h100', name: 'H100', between: '[\\s\\S]{0,160}?spot[\\s\\S]{0,80}?', kind: 'spot', note: 'published spot rate; Verda may evict it at any time without warning' },
        { key: 'a100-80gb', name: 'A100 80GB', between: '[\\s\\S]{0,120}?on.?demand[\\s\\S]{0,80}?', kind: 'on_demand', note: 'published on-demand rate' },
        { key: 'a100-80gb', name: 'A100 80GB', between: '[\\s\\S]{0,160}?spot[\\s\\S]{0,80}?', kind: 'spot', note: 'published spot rate; Verda may evict it at any time without warning' },
    ]);
}

/** Thunder Compute's public price page: on-demand, billed per minute. */
function parseThunder(html) {
    return parsePlainPrices(html, 'https://www.thundercompute.com/pricing', [
        { key: 'h100', name: 'H100', between: '[\\s\\S]{0,80}?', kind: 'on_demand', note: 'on-demand, billed per minute' },
        { key: 'a100-80gb', name: 'A100 80GB', between: '[\\s\\S]{0,80}?', kind: 'on_demand', note: 'on-demand, billed per minute' },
    ]);
}

/** Shadeform's public marketplace: the lowest on-demand rate it advertises across its clouds. */
function parseShadeform(html) {
    return parsePlainPrices(html, 'https://shadeform.ai/pricing', [
        { key: 'h100', name: 'H100', between: '[\\s\\S]{0,100}?(?:from|starting at)?[\\s\\S]{0,20}?', kind: 'on_demand', note: 'the lowest on-demand rate advertised across Shadeform\'s clouds; the marketplace adds no fee' },
        { key: 'a100-80gb', name: 'A100 80GB', between: '[\\s\\S]{0,100}?(?:from|starting at)?[\\s\\S]{0,20}?', kind: 'on_demand', note: 'the lowest on-demand rate advertised across Shadeform\'s clouds; the marketplace adds no fee' },
    ]);
}

/** CloudRift's public table: only the cards whose on-demand rate is a number; its H100/H200 say "Upon request". */
function parseCloudrift(html) {
    const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const out = [];
    for (const [name, key] of [['RTX 4090', 'rtx-4090'], ['RTX 5090', 'rtx-5090'], ['A100 SXM4', 'a100-80gb'], ['H100', 'h100'], ['H200', 'h200']]) {
        const normalized = name.replace(/ /g, '\\s+');
        const m = text.match(new RegExp(normalized + '\\s+NVIDIA\\s+On.?Demand\\s+\\$([\\d.]+)', 'i'));
        if (!m) continue;
        const row = reading(BY_KEY.get(key), 'on_demand', m[1], {
            note: 'on-demand rate from the public table; reserved rates are lower, H100/H200 on demand are quoted on request, and no reliability score is published',
            variant: name, source: 'https://www.cloudrift.ai/pricing',
        });
        if (row) out.push(row);
    }
    return out;
}

async function read(fetchImpl, url, { method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const headers = { Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'OpenVibe.AI GPU price reader (+https://openvibe.exchange)' };
    if (body != null) headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetchImpl(url, {
            method, headers, redirect: 'follow', signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
            body: body != null ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        throw new Error(`${url} did not answer: ${String(err && err.message || err).slice(0, 120)}`);
    }
    if (!res || !res.ok) throw new Error(`${url} answered ${res ? res.status : 'no status'}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`${url} answered ${text.length} bytes (over ${MAX_BYTES})`);
    return text;
}

const SOURCES = Object.freeze([
    {
        id: 'vast', label: 'Vast.ai', source: 'https://vast.ai/pricing',
        async read({ fetchImpl, timeoutMs }) {
            const body = (type, order) => ({
                type, gpu_name: { in: VAST_NAMES }, num_gpus: { eq: 1 }, rentable: { eq: true }, limit: 500,
                order: [[order, 'asc']],
            });
            const [onDemand, bid] = await Promise.all([
                read(fetchImpl, 'https://console.vast.ai/api/v0/bundles/', { method: 'POST', body: body('ondemand', 'dph_total'), timeoutMs }),
                read(fetchImpl, 'https://console.vast.ai/api/v0/bundles/', { method: 'POST', body: body('bid', 'min_bid'), timeoutMs }),
            ]);
            return [...parseVast(onDemand, 'on_demand'), ...parseVast(bid, 'spot')];
        },
    },
    {
        id: 'runpod', label: 'RunPod', source: 'https://www.runpod.io/pricing',
        async read({ fetchImpl, timeoutMs }) {
            return parseRunpod(await read(fetchImpl, 'https://www.runpod.io/pricing', { timeoutMs }));
        },
    },
    {
        id: 'salad', label: 'Salad', source: 'https://salad.com/pricing/',
        async read({ fetchImpl, timeoutMs }) {
            return parseSalad(await read(fetchImpl, 'https://salad.com/pricing/', { timeoutMs }));
        },
    },
    {
        id: 'tensordock', label: 'TensorDock', source: 'https://www.tensordock.com/',
        async read({ fetchImpl, timeoutMs }) {
            return parseTensordock(await read(fetchImpl, 'https://www.tensordock.com/', { timeoutMs }));
        },
    },
    {
        id: 'cloudrift', label: 'CloudRift', source: 'https://www.cloudrift.ai/pricing',
        async read({ fetchImpl, timeoutMs }) {
            return parseCloudrift(await read(fetchImpl, 'https://www.cloudrift.ai/pricing', { timeoutMs }));
        },
    },
    {
        id: 'verda', label: 'Verda', source: 'https://verda.ai/pricing',
        async read({ fetchImpl, timeoutMs }) {
            return parseVerda(await read(fetchImpl, 'https://verda.ai/pricing', { timeoutMs }));
        },
    },
    {
        id: 'thunder', label: 'Thunder Compute', source: 'https://www.thundercompute.com/pricing',
        async read({ fetchImpl, timeoutMs }) {
            return parseThunder(await read(fetchImpl, 'https://www.thundercompute.com/pricing', { timeoutMs }));
        },
    },
    {
        id: 'runpod_serverless', label: 'RunPod Serverless', source: 'https://www.runpod.io/pricing',
        async read({ fetchImpl, timeoutMs }) {
            return parseRunpodServerless(await read(fetchImpl, 'https://www.runpod.io/pricing', { timeoutMs }));
        },
    },
    {
        id: 'shadeform', label: 'Shadeform', source: 'https://shadeform.ai/pricing',
        async read({ fetchImpl, timeoutMs }) {
            return parseShadeform(await read(fetchImpl, 'https://shadeform.ai/pricing', { timeoutMs }));
        },
    },
]);
const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/** The lowest reading per (provider, card, kind): one row is what a provider actually charges for that hour. */
function lowest(readings) {
    const out = new Map();
    for (const row of readings || []) {
        if (!row || !usd(row.hourly_usd)) continue;
        const key = `${row.gpu_key}\u0000${row.kind}`;
        const held = out.get(key);
        if (!held || row.hourly_usd < held.hourly_usd) out.set(key, row);
    }
    return [...out.values()];
}

function createGpuMarket({ db, config = {}, clock = { now: () => Date.now() }, fetchImpl = null, log = console } = {}) {
    const settings = {
        enabled: false,
        intervalMs: DEFAULT_INTERVAL_MS,
        tickMs: DEFAULT_TICK_MS,
        firstTickMs: DEFAULT_FIRST_TICK_MS,
        staleMs: DEFAULT_STALE_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        ...(config.gpuMarket || {}),
    };
    const iso = (at = clock.now()) => new Date(at).toISOString();
    let timer = null;
    let first = null;
    let busy = false;

    /** Fetch every source and write what it said; a failed source leaves its last readings in place. */
    async function refresh({ fetchImpl: seam = null } = {}) {
        const fetcher = seam || fetchImpl;
        if (!fetcher) throw new AiError(503, 'gpu.market_unavailable', 'No GPU price transport is available');
        const outcomes = await Promise.all(SOURCES.map(async (source) => {
            try {
                const rows = await source.read({ fetchImpl: fetcher, timeoutMs: settings.timeoutMs });
                return { source, rows: lowest(rows) };
            } catch (err) {
                return { source, error: String(err && err.message || err).slice(0, 300) };
            }
        }));
        const at = iso();
        let refreshed = 0;
        let failed = 0;
        for (const outcome of outcomes) {
            const { source } = outcome;
            if (outcome.error) {
                failed += 1;
                await db.prepare(`INSERT INTO gpu_market_sources(provider,label,source,status,read_at,ok_at,error,offers)
                    VALUES(?,?,?,?,?,NULL,?,0)
                    ON CONFLICT(provider) DO UPDATE SET status=excluded.status, read_at=excluded.read_at,
                        error=excluded.error, label=excluded.label, source=excluded.source`)
                    .run(source.id, source.label, source.source, 'failed', at, outcome.error);
                continue;
            }
            refreshed += 1;
            await db.prepare('DELETE FROM gpu_market_prices WHERE provider = ?').run(source.id);
            for (const row of outcome.rows) {
                await db.prepare(`INSERT INTO gpu_market_prices(provider,gpu_key,gpu,kind,hourly_usd,region,reliability,note,variant,source,observed_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(provider,gpu_key,kind) DO UPDATE SET hourly_usd=excluded.hourly_usd, region=excluded.region,
                        reliability=excluded.reliability, note=excluded.note, variant=excluded.variant, source=excluded.source,
                        observed_at=excluded.observed_at`)
                    .run(source.id, row.gpu_key, row.gpu, row.kind, row.hourly_usd, row.region, row.reliability,
                        row.note, row.variant, row.source, at);
            }
            await db.prepare(`INSERT INTO gpu_market_sources(provider,label,source,status,read_at,ok_at,error,offers)
                VALUES(?,?,?,?,?,?,NULL,?)
                ON CONFLICT(provider) DO UPDATE SET status='ok', read_at=excluded.read_at, ok_at=excluded.ok_at,
                    error=NULL, offers=excluded.offers, label=excluded.label, source=excluded.source`)
                .run(source.id, source.label, source.source, 'ok', at, at, outcome.rows.length);
        }
        return { refreshed, failed, sources: (await report()).sources };
    }

    /** The cached readings, with the stale facts: a failed source keeps its last numbers, marked stale. */
    async function report() {
        const [sourceRows, priceRows] = await Promise.all([
            db.prepare('SELECT * FROM gpu_market_sources').all().catch(() => []),
            db.prepare('SELECT * FROM gpu_market_prices').all().catch(() => []),
        ]);
        const now = clock.now();
        const state = new Map((sourceRows || []).map((row) => [row.provider, row]));
        const sources = SOURCES.map((source) => {
            const row = state.get(source.id) || null;
            const okAt = row && row.ok_at ? Date.parse(row.ok_at) : NaN;
            const stale = !row || row.status !== 'ok' || !Number.isFinite(okAt) || now - okAt > settings.staleMs;
            return {
                provider: source.id,
                label: source.label,
                source: source.source,
                status: row ? String(row.status) : 'never',
                read_at: row && row.read_at ? String(row.read_at) : null,
                ok_at: row && row.ok_at ? String(row.ok_at) : null,
                stale,
                error: row && row.error ? String(row.error) : null,
                offers: row ? Number(row.offers) || 0 : 0,
            };
        });
        const sourceState = new Map(sources.map((s) => [s.provider, s]));
        const rows = (priceRows || []).map((row) => ({ ...row, hourly_usd: Number(row.hourly_usd), reliability: row.reliability == null ? null : Number(row.reliability) }))
            .filter((row) => usd(row.hourly_usd));
        const byTarget = new Map(TARGETS.map((t) => [t.key, []]));
        for (const row of rows) {
            if (!byTarget.has(row.gpu_key)) continue;
            const source = sourceState.get(row.provider);
            byTarget.get(row.gpu_key).push({
                provider: row.provider,
                provider_label: source ? source.label : row.provider,
                kind: row.kind,
                hourly_usd: row.hourly_usd,
                region: row.region || '',
                reliability: row.reliability,
                note: row.note || '',
                variant: row.variant || '',
                source: row.source,
                observed_at: row.observed_at,
                stale: source ? source.stale : true,
            });
        }
        const best = (readings, kind) => {
            const of = readings.filter((r) => r.kind === kind).sort((a, b) => a.hourly_usd - b.hourly_usd);
            const fresh = of.filter((r) => !r.stale);
            return (fresh.length ? fresh : of)[0] || null;
        };
        const gpus = TARGETS.map((target) => {
            const readings = byTarget.get(target.key);
            return {
                key: target.key, gpu: target.gpu, vram_mb: target.vram_mb,
                on_demand: best(readings, 'on_demand'),
                spot: best(readings, 'spot'),
                readings,
            };
        });
        const readAt = sources.map((s) => s.ok_at).filter(Boolean).sort().pop() || null;
        return { read_at: readAt, stale_after_ms: settings.staleMs, sources, gpus };
    }

    /** The book is due when the last answered read is older than the interval (a deploy does not reset it). */
    async function due() {
        const row = await db.prepare('SELECT MAX(ok_at) AS at FROM gpu_market_sources').get().catch(() => null);
        const at = row && row.at ? Date.parse(row.at) : NaN;
        return !Number.isFinite(at) || clock.now() - at >= settings.intervalMs;
    }

    function start() {
        if (!settings.enabled || timer) return;
        const tick = async () => {
            if (busy) return;
            busy = true;
            try {
                if (await due()) await refresh();
            } catch (err) {
                log.warn(`[ai] GPU market prices failed: ${String(err && err.message || err).slice(0, 200)}`);
            } finally { busy = false; }
        };
        timer = setInterval(tick, Math.max(60000, settings.tickMs));
        if (timer.unref) timer.unref();
        first = setTimeout(tick, Math.max(1000, settings.firstTickMs));
        if (first.unref) first.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        if (first) clearTimeout(first);
        timer = null;
        first = null;
    }

    return { refresh, report, due, start, stop, settings, SOURCES, TARGETS };
}

module.exports = {
    createGpuMarket, parseVast, parseRunpod, parseSalad, parseTensordock, parseCloudrift, parseVerda, parseThunder, parseShadeform, parseRunpodServerless, targetFor, lowest,
    TARGETS, SOURCES, SOURCE_BY_ID, HOUR_MS,
};
