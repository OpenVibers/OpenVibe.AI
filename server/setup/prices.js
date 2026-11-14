'use strict';
/**
 * The price table: what a GPU hour and an agent desktop cost, read from the providers themselves.
 *
 *   GET /api/v1/prices/gpus      every GPU marketplace the estate reads, one row per card and kind
 *   GET /api/v1/prices/servers   one row per host: the cheapest plan that fits an agent desktop
 *
 * A row is { provider, plan, vcpu, ram_gb, gpu?, usd_per_hour, usd_per_month, at, source_url }. ${at${ is the
 * moment the number was read and ${source_url${ is where it came from: a row is never a guess.
 *
 * The GPU rows are the readings the provisioner already keeps (server/gpu/market.js): Vast.ai's public offer
 * search, RunPod's price table, Salad's tiers, TensorDock's "from" prices, Shadeform's, Verda's, Thunder's -
 * each read from the provider's own page, each marked with the day it was read and whether it is stale.
 *
 * The server rows are read here, now, from the hosts' own price APIs and pages: Vultr, Linode (Akamai),
 * OVHcloud, Hetzner Cloud, the Hetzner Server Auction, and - with the owner's own key - DigitalOcean,
 * UpCloud and Lambda Labs. The prices that come in euros are converted with the day's rate from the European
 * Central Bank (api.frankfurter.dev); the row carries the rate it used, so the number can be checked.
 *
 * Nothing here spends anything: a read is a list, a catalog or a price page. The server table is cached for
 * an hour (the price of a GPU hour moves by the minute, the price of a small VPS by the month), so the table
 * is cheap to ask for and never hammers a provider.
 */
const HOUR_MS = 3600 * 1000;
const CACHE_MS = HOUR_MS;
const TIMEOUT_MS = 12_000;
const UA = 'OpenVibe.AI prices (openvibe.network)';
/** The day the recorded prices were read from the providers' own pages (the estate's price book). */
const RECORDED_ON = '2026-10-30';
/** Hours in a month, the divisor every hourly price is turned into a monthly one with. */
const HOURS_PER_MONTH = 730;

/** A number, or null when the value is not one. A missing value is null, never 0: 0 is a price. */
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const round = (v, places = 6) => (v == null ? null : Math.round(Number(v) * 10 ** places) / 10 ** places);
const iso = (ms) => new Date(ms).toISOString();

/** A fetch with a time limit; never throws, answers { status, json, text, error }. */
async function read(fetchImpl, url, { headers = {}, method = 'GET', body = null } = {}) {
    let res;
    try {
        res = await fetchImpl(url, {
            method,
            headers: { Accept: 'application/json', 'user-agent': UA, ...headers },
            ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        return { status: 0, json: null, text: '', error: err && err.name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached' };
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text, error: null };
}

/** The text of a page, without the tags: the prices of some providers sit inside their markup. */
function plainText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&euro;/g, '€')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');
}

/**
 * The euros-per-dollar rate of the day, from the European Central Bank's own feed
 * (api.frankfurter.dev). Null when it cannot be read: a price in euros is then left out of the table
 * rather than converted with a number nobody can check.
 */
async function eurUsd(fetchImpl) {
    const r = await read(fetchImpl, 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD');
    const rate = r.json && r.json.rates && num(r.json.rates.USD);
    if (!rate) return null;
    return { rate, at: r.json.date ? r.json.date + 'T00:00:00.000Z' : null, source_url: 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD' };
}

/** A row in the table's own shape. */
function row({ provider, plan, vcpu = null, ram_gb = null, gpu = null, usd_per_hour, usd_per_month = null, at, source_url, live = true, currency = 'USD', fx = null, note = null, stale = false }) {
    return {
        provider, plan,
        vcpu: num(vcpu), ram_gb: num(ram_gb), ...(gpu ? { gpu } : {}),
        usd_per_hour: round(usd_per_hour), usd_per_month: round(usd_per_month),
        at, source_url, live, currency,
        ...(fx ? { fx } : {}),
        ...(note ? { note } : {}),
        ...(stale ? { stale: true } : {}),
    };
}

/** A price in euros, in dollars, with the rate that did it. */
function toUsd(amountEur, fx) {
    if (!fx || !Number.isFinite(amountEur)) return null;
    return amountEur * fx.rate;
}

// ── The servers ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The cheapest plan of a host that fits an agent desktop: two vCPUs and four gigabytes of memory. A plan
 * that does not fit is not an answer, and a plan whose price the provider did not publish is not a price.
 */
function desktopFit(rows) {
    const fit = rows.filter((r) => Number.isFinite(r.vcpu) && Number.isFinite(r.ram_gb) && r.vcpu >= 2 && r.ram_gb >= 4 && Number.isFinite(r.usd_per_month) && r.usd_per_month > 0);
    if (!fit.length) return null;
    return fit.sort((a, b) => a.usd_per_month - b.usd_per_month || a.plan.localeCompare(b.plan))[0];
}

/** Vultr: its own plan list, public (https://api.vultr.com/v2/plans), read 2026-11-14. */
async function vultrPlans(fetchImpl, at) {
    const r = await read(fetchImpl, 'https://api.vultr.com/v2/plans?per_page=500');
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const out = [];
    for (const p of r.json.plans || []) {
        const monthly = num(p.monthly_cost);
        const hourly = num(p.hourly_cost);
        if (monthly == null && hourly == null) continue;
        out.push(row({
            provider: 'Vultr', plan: p.id, vcpu: num(p.vcpu_count), ram_gb: num(p.ram) == null ? null : num(p.ram) / 1024,
            usd_per_hour: hourly != null ? hourly : monthly / HOURS_PER_MONTH,
            usd_per_month: monthly != null ? monthly : hourly * HOURS_PER_MONTH,
            at, source_url: 'https://api.vultr.com/v2/plans',
        }));
    }
    return out;
}

/** Linode (Akamai): its own type list, public (https://api.linode.com/v4/linode/types). */
async function linodePlans(fetchImpl, at) {
    const r = await read(fetchImpl, 'https://api.linode.com/v4/linode/types');
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const out = [];
    for (const t of r.json.data || []) {
        const price = t.price || {};
        const monthly = num(price.monthly);
        const hourly = num(price.hourly);
        if (monthly == null && hourly == null) continue;
        out.push(row({
            provider: 'Linode (Akamai)', plan: t.label || t.id, vcpu: num(t.vcpus), ram_gb: num(t.memory) == null ? null : num(t.memory) / 1024,
            usd_per_hour: hourly != null ? hourly : monthly / HOURS_PER_MONTH,
            usd_per_month: monthly != null ? monthly : hourly * HOURS_PER_MONTH,
            at, source_url: 'https://api.linode.com/v4/linode/types',
        }));
    }
    return out;
}

/**
 * OVHcloud: its own public catalog (https://eu.api.ovh.com/1.0/order/catalog/public/vps), in euros. The
 * catalog names the plans but not their cores and memory, so the sizes are the ones the estate's price book
 * read from OVH's own VPS page on 2026-10-30 (research-2026-10-30/price-book/compute.csv).
 */
const OVH_SIZES = Object.freeze({
    'vps-2027-model1': { vcpu: 2, ram_gb: 4 },
    'vps-2027-model2': { vcpu: 4, ram_gb: 8 },
    'vps-2027-model3': { vcpu: 8, ram_gb: 16 },
    'vps-2025-model1': { vcpu: 2, ram_gb: 4 },
    'vps-2025-model2': { vcpu: 4, ram_gb: 8 },
    'vps-2025-model3': { vcpu: 8, ram_gb: 16 },
});
async function ovhPlans(fetchImpl, at, fx) {
    const url = 'https://eu.api.ovh.com/1.0/order/catalog/public/vps?ovhSubsidiary=IE';
    const r = await read(fetchImpl, url);
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const out = [];
    for (const p of r.json.plans || []) {
        const size = OVH_SIZES[p.planCode];
        if (!size) continue;
        const monthly = (p.pricings || []).find((x) => x.mode === 'default' && x.interval === 1 && x.intervalUnit === 'month');
        const eur = monthly ? num(monthly.price) / 1e8 : null;
        const usd = toUsd(eur, fx);
        if (usd == null) continue;
        out.push(row({
            provider: 'OVHcloud', plan: p.planCode, vcpu: size.vcpu, ram_gb: size.ram_gb,
            usd_per_hour: usd / HOURS_PER_MONTH, usd_per_month: usd, at, source_url: url, currency: 'EUR',
            fx: fx ? { rate: fx.rate, base: 'EUR', quote: 'USD', source_url: fx.source_url, at: fx.at } : null,
            note: 'the price OVH\'s own catalog lists, without VAT',
        }));
    }
    return out;
}

/**
 * Hetzner Cloud: the price page of the cloud itself, read as text (the price sits inside the markup). The
 * plan names do not carry their cores and memory, so the sizes are the ones the estate's price book read from
 * Hetzner's own pages on 2026-10-30.
 */
const HETZNER_SIZES = Object.freeze({
    CX23: { vcpu: 2, ram_gb: 4 }, CX33: { vcpu: 4, ram_gb: 8 }, CX43: { vcpu: 8, ram_gb: 16 },
    CPX22: { vcpu: 2, ram_gb: 4 }, CPX32: { vcpu: 4, ram_gb: 8 }, CPX42: { vcpu: 8, ram_gb: 16 },
    CAX11: { vcpu: 2, ram_gb: 4 }, CAX21: { vcpu: 4, ram_gb: 8 }, CAX31: { vcpu: 8, ram_gb: 16 },
});
async function hetznerCloud(fetchImpl, at, fx) {
    const url = 'https://www.hetzner.com/cloud/cost-optimized/';
    const r = await read(fetchImpl, url);
    if (r.status < 200 || r.status >= 300) return [];
    const flat = plainText(r.text);
    const out = [];
    const re = /\b(CX\d{2}|CPX\d{2}|CAX\d{2})\s*[\s\S]{0,300}?€\s*([\d.,]+)\s*per\s*hour/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(flat))) {
        const code = m[1];
        const size = HETZNER_SIZES[code];
        if (!size || seen.has(code)) continue;
        const eur = num(String(m[2]).replace(',', '.'));
        const usd = toUsd(eur, fx);
        if (usd == null) continue;
        seen.add(code);
        out.push(row({
            provider: 'Hetzner Cloud', plan: code, vcpu: size.vcpu, ram_gb: size.ram_gb,
            usd_per_hour: usd, usd_per_month: usd * HOURS_PER_MONTH, at, source_url: url, currency: 'EUR',
            fx: fx ? { rate: fx.rate, base: 'EUR', quote: 'USD', source_url: fx.source_url, at: fx.at } : null,
            note: 'the hourly price of the shared line, capped at the monthly price',
        }));
    }
    return out;
}

/**
 * The Hetzner Server Auction: refurbished dedicated servers, the cheapest first ("from EUR X per month" is
 * what the page says). It is a price read, not a key.
 */
async function hetznerAuction(fetchImpl, at, fx) {
    const url = 'https://www.hetzner.com/sb/';
    const r = await read(fetchImpl, url);
    if (r.status < 200 || r.status >= 300) return [];
    const flat = plainText(r.text);
    const m = /from\s*€\s*([\d.,]+)\s*per\s*month/i.exec(flat);
    if (!m) return [];
    const eur = num(String(m[1]).replace(',', '.'));
    const usd = toUsd(eur, fx);
    if (usd == null) return [];
    return [row({
        provider: 'Hetzner Server Auction', plan: 'Refurbished servers (from)', vcpu: null, ram_gb: null,
        usd_per_hour: usd / HOURS_PER_MONTH, usd_per_month: usd, at, source_url: url, currency: 'EUR',
        fx: fx ? { rate: fx.rate, base: 'EUR', quote: 'USD', source_url: fx.source_url, at: fx.at } : null,
        note: 'the auction\'s floor, without VAT; the stock rotates and a listing can be gone before an order',
    })];
}

/** DigitalOcean: its own size list, read with the owner's own token. */
async function digitaloceanPlans(fetchImpl, at, key) {
    if (!key) return [];
    const url = 'https://api.digitalocean.com/v2/sizes?per_page=200';
    const r = await read(fetchImpl, url, { headers: { Authorization: 'Bearer ' + key } });
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const out = [];
    for (const s of r.json.sizes || []) {
        const monthly = num(s.price_monthly);
        const hourly = num(s.price_hourly);
        if (monthly == null && hourly == null) continue;
        out.push(row({
            provider: 'DigitalOcean', plan: s.slug || s.name, vcpu: num(s.vcpus), ram_gb: num(s.memory) == null ? null : num(s.memory) / 1024,
            usd_per_hour: hourly != null ? hourly : monthly / HOURS_PER_MONTH,
            usd_per_month: monthly != null ? monthly : hourly * HOURS_PER_MONTH,
            at, source_url: url, note: 'the price of the owner\'s own DigitalOcean account',
        }));
    }
    return out;
}

/** UpCloud: its own price list, read with the owner's own key. */
async function upcloudPlans(fetchImpl, at, key, parts) {
    if (!key || !parts || !parts.user) return [];
    const url = 'https://api.upcloud.com/1.3/price';
    const auth = Buffer.from(parts.user + ':' + key).toString('base64');
    const r = await read(fetchImpl, url, { headers: { Authorization: 'Basic ' + auth } });
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const out = [];
    const zones = r.json.zones || {};
    const prices = r.json.prices || {};
    for (const zone of Object.values(zones)) {
        for (const p of zone.plans || []) {
            const entry = prices[zone.zone + '/' + p];
            const monthly = entry ? num(entry.monthly) : null;
            const hourly = entry ? num(entry.hourly) : null;
            if (monthly == null && hourly == null) continue;
            const cores = num((zone.core_config && zone.core_config.cores) || zone.cores);
            const memory = num((zone.memory_config && zone.memory_config.size) || zone.memory);
            out.push(row({
                provider: 'UpCloud', plan: zone.zone + '/' + p, vcpu: cores, ram_gb: memory == null ? null : memory / 1024,
                usd_per_hour: hourly != null ? hourly : monthly / HOURS_PER_MONTH,
                usd_per_month: monthly != null ? monthly : hourly * HOURS_PER_MONTH,
                at, source_url: url, note: 'the price of the owner\'s own UpCloud account',
            }));
        }
    }
    return out;
}

/**
 * Shadeform: its own public list of instance types, each with the on-demand price in cents. Shadeform is a
 * marketplace: it lists the same card in many clouds, so the cheapest one it offers is the price of that card.
 * A card nobody can rent right now (every region says it is unavailable) is not a price.
 */
async function shadeformCards(fetchImpl, at) {
    const url = 'https://api.shadeform.ai/v1/instances/types';
    const r = await read(fetchImpl, url);
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const list = Array.isArray(r.json) ? r.json : (r.json.instance_types || []);
    const out = [];
    for (const t of list) {
        // The price is in cents, and only a one-GPU instance is comparable with the other rows.
        const cents = num(t.hourly_price);
        const config = t.configuration || {};
        if (cents == null || Number(config.num_gpus) !== 1) continue;
        // The card's name: Shadeform names it in the configuration, with its own spelling.
        const name = String(config.gpu_type || t.gpu_type || '');
        const card = SHADEFORM_CARDS[name];
        if (!card) continue;
        // A card with no free region cannot be rented: its price is not a price.
        const free = (t.availability || []).filter((a) => a && a.available && a.rental_type !== 'spot');
        if (!free.length) continue;
        const price = cents / 100;
        out.push(row({
            provider: 'Shadeform', plan: t.shade_instance_type || t.cloud_instance_type || name, gpu: card,
            vcpu: num(t.vcpus) != null ? num(t.vcpus) : num(config.vcpus),
            ram_gb: num(t.memory_in_gb) != null ? num(t.memory_in_gb) : num(config.memory_in_gb),
            usd_per_hour: price, usd_per_month: price * HOURS_PER_MONTH, at, source_url: url,
            note: 'on-demand, in ' + free[0].display_name + '; Shadeform adds no fee of its own',
        }));
    }
    return out;
}

/** The cards Shadeform names the way the GPU table names them. */
const SHADEFORM_CARDS = Object.freeze({
    'RTX3090': 'RTX 3090', 'RTX4090': 'RTX 4090', 'RTX5090': 'RTX 5090',
    'A100_80G': 'A100 80GB', 'H100': 'H100', 'H200': 'H200',
});

/**
 * Verda (DataCrunch): its own public list of instance types, each with the on-demand and the spot price of the
 * hour. Its cards are named in the model field, and only a one-GPU instance is comparable with the other rows.
 */
async function verdaCards(fetchImpl, at) {
    const url = 'https://api.datacrunch.io/v1/instance-types';
    const r = await read(fetchImpl, url);
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const list = Array.isArray(r.json) ? r.json : (r.json.instance_types || []);
    const out = [];
    for (const t of list) {
        const gpu = t.gpu || {};
        if (Number(gpu.number_of_gpus) !== 1) continue;
        const card = VERDA_CARDS[String(t.model || '')];
        if (!card) continue;
        const price = num(t.price_per_hour);
        if (price == null) continue;
        const spot = num(t.spot_price);
        out.push(row({
            provider: 'Verda (DataCrunch)', plan: t.instance_type || t.name || card, gpu: card,
            vcpu: num((t.cpu || {}).number_of_cores),
            ram_gb: num((t.memory || {}).size_in_gigabytes),
            usd_per_hour: price, usd_per_month: price * HOURS_PER_MONTH, at, source_url: url,
            note: spot != null ? 'on-demand; the spot hour of the same card is ' + spot + ' USD' : 'on-demand',
        }));
    }
    return out;
}

/** The cards Verda names the way the GPU table names them. */
const VERDA_CARDS = Object.freeze({
    'H100': 'H100', 'H200': 'H200', 'A100 80GB': 'A100 80GB', 'A100 40GB': 'A100 40GB',
    'RTX A6000': 'RTX A6000', 'RTX 6000 Ada': 'RTX 6000 Ada', 'L40S': 'L40S',
});

/**
 * Lambda Labs: its own instance types, read with the owner's own key. The GPU market (server/gpu/market.js)
 * does not read Lambda, so this is where its cards come from.
 */
async function lambdaCards(fetchImpl, at, key) {
    if (!key) return [];
    const url = 'https://cloud.lambdalabs.com/api/v1/instance-types';
    const r = await read(fetchImpl, url, { headers: { Authorization: 'Bearer ' + key } });
    if (r.status < 200 || r.status >= 300 || !r.json) return [];
    const list = Array.isArray(r.json) ? r.json : (r.json.instance_types || r.json.data || []);
    const out = [];
    for (const t of list) {
        const price = num(t.price_cents_per_hour) != null ? num(t.price_cents_per_hour) / 100
            : num(t.priceCentsPerHour) != null ? num(t.priceCentsPerHour) / 100
                : num(t.hourly_cost) != null ? num(t.hourly_cost) : num(t.price_per_hour);
        if (price == null) continue;
        const name = t.name || t.id;
        // The card is in the instance type's name when the provider does not name it separately.
        const gpu = (t.gpu_info && (t.gpu_info.model || t.gpu_info.name)) || t.gpu || t.gpu_name || name || null;
        const specs = t.specs || {};
        out.push(row({
            provider: 'Lambda Labs', plan: name, gpu,
            vcpu: num(t.vcpus) != null ? num(t.vcpus) : num(specs.cpu_cores),
            ram_gb: num(t.memory_gb) != null ? num(t.memory_gb) : num(specs.ram_gb),
            usd_per_hour: price, usd_per_month: price * HOURS_PER_MONTH, at, source_url: url,
            note: 'the price of the owner\'s own Lambda account',
        }));
    }
    return out;
}

// ── The prices that are not read live ─────────────────────────────────────────────────────────────────────

/**
 * The prices the providers publish but do not serve as a price API: read from their own pages on the day the
 * estate's price book read them (research-2026-10-30/price-book/compute.csv, 2026-10-30). The row says so.
 */
const RECORDED = Object.freeze([
    {
        provider: 'Oracle Cloud', plan: 'Always Free (Ampere A1)', vcpu: 4, ram_gb: 24,
        usd_per_hour: 0, usd_per_month: 0, at: RECORDED_ON + 'T00:00:00.000Z', source_url: 'https://www.oracle.com/cloud/free/',
        note: 'the free tier costs nothing; capacity is not guaranteed and the paid shapes cost more',
    },
]);

// ── The table ─────────────────────────────────────────────────────────────────────────────────────────────

/** The cache: one entry per kind, an hour old at most. */
const cache = new Map();

/** The rows of the recorded prices, in the table's own shape. */
function recordedRows() {
    return RECORDED.map((r) => row(Object.assign({}, r, { live: false })));
}

/**
 * The server table: one row per host, the cheapest plan that fits an agent desktop (2 vCPU, 4 GB). The
 * hosts whose price we can only read with the owner's own key are left out when there is no key yet.
 */
async function serverRows({ fetchImpl, keys = {}, now = function () { return Date.now(); }, parts = {} }) {
    const at = iso(now());
    const fx = await eurUsd(fetchImpl);
    const live = [];
    live.push.apply(live, await vultrPlans(fetchImpl, at));
    live.push.apply(live, await linodePlans(fetchImpl, at));
    live.push.apply(live, await ovhPlans(fetchImpl, at, fx));
    live.push.apply(live, await hetznerCloud(fetchImpl, at, fx));
    live.push.apply(live, await hetznerAuction(fetchImpl, at, fx));
    live.push.apply(live, await digitaloceanPlans(fetchImpl, at, keys.digitalocean));
    live.push.apply(live, await upcloudPlans(fetchImpl, at, keys.upcloud, parts.upcloud));
    // One row per host: the cheapest plan that fits an agent desktop. A host that sells no such plan (the
    // Server Auction sells refurbished dedicated servers, and the page does not give their size) still belongs
    // in the table: its own cheapest price is the answer for that host.
    const byProvider = new Map();
    for (const r of live) {
        const list = byProvider.get(r.provider) || [];
        list.push(r);
        byProvider.set(r.provider, list);
    }
    const out = [];
    for (const list of byProvider.values()) {
        const best = desktopFit(list);
        if (best) { out.push(best); continue; }
        const cheapest = list.filter((r) => Number.isFinite(r.usd_per_month)).sort((a, b) => a.usd_per_month - b.usd_per_month)[0];
        if (cheapest) out.push(cheapest);
    }
    // The recorded servers (Oracle's free tier) join the live ones.
    for (const r of recordedRows()) {
        if (r.provider !== 'Oracle Cloud') continue;
        if (!out.some((x) => x.provider === r.provider)) out.push(r);
    }
    return out;
}

/**
 * The GPU table: the readings the provisioner already keeps (server/gpu/market.js) plus the owner's own
 * Lambda account. A reading that could not be refreshed is marked stale, and its day is the day it was read.
 */
async function gpuRows({ fetchImpl, gpuMarket = null, keys = {}, now = function () { return Date.now(); } }) {
    const out = [];
    if (gpuMarket) {
        let report = null;
        try { report = await gpuMarket.report(); } catch { report = null; }
        if (report && Array.isArray(report.gpus)) {
            for (const g of report.gpus) {
                for (const reading of g.readings || []) {
                    out.push(row({
                        provider: reading.provider_label || reading.provider,
                        plan: reading.variant || g.gpu,
                        gpu: g.gpu,
                        usd_per_hour: reading.hourly_usd,
                        usd_per_month: reading.hourly_usd * HOURS_PER_MONTH,
                        at: reading.observed_at || report.read_at || null,
                        source_url: reading.source || null,
                        live: true,
                        stale: Boolean(reading.stale),
                        note: [reading.kind, reading.region, reading.reliability == null ? '' : 'reliability ' + reading.reliability, reading.note].filter(Boolean).join(' · '),
                    }));
                }
            }
        }
    }
    out.push.apply(out, await lambdaCards(fetchImpl, iso(now()), keys.lambda));
    // Shadeform and Verda publish their prices as an API, not on the page the market reader used to read. When
    // the API answers, its rows are the ones of that provider: the market's saved page is older than the API.
    const shadeform = await shadeformCards(fetchImpl, iso(now()));
    const verda = await verdaCards(fetchImpl, iso(now()));
    // The market reader names them "Shadeform" and "Verda"; these rows carry the same provider, so the older
    // rows of the same provider are taken out when the API answers.
    const own = [];
    if (shadeform.length) { own.push('Shadeform'); out.push.apply(out, shadeform); }
    if (verda.length) { own.push('Verda', 'Verda (DataCrunch)'); out.push.apply(out, verda); }
    for (let i = out.length - 1; i >= 0; i -= 1) {
        if (own.includes(out[i].provider) && !shadeform.includes(out[i]) && !verda.includes(out[i])) out.splice(i, 1);
    }
    return out;
}

/**
 * The table, cached for an hour. ${kind${ is 'servers' or 'gpus'. The answer carries the rows and the moment
 * they were read; a cached answer says so.
 */
async function prices(kind, { fetchImpl, gpuMarket = null, keys = {}, parts = {}, now = function () { return Date.now(); }, force = false } = {}) {
    const what = kind === 'gpus' ? 'gpus' : 'servers';
    const hit = cache.get(what);
    const nowMs = now();
    if (!force && hit && nowMs - hit.at < CACHE_MS) return { kind: what, rows: hit.rows, at: iso(hit.at), cached: true };
    const rows = what === 'gpus'
        ? await gpuRows({ fetchImpl, gpuMarket, keys, now })
        : await serverRows({ fetchImpl, keys, parts, now });
    cache.set(what, { at: nowMs, rows });
    return { kind: what, rows, at: iso(nowMs), cached: false };
}

/** Forget the cached table (the tests, and the owner after a price moved). */
function clearCache() {
    cache.clear();
}

module.exports = {
    prices, clearCache, serverRows, gpuRows, recordedRows, desktopFit,
    CACHE_MS, HOURS_PER_MONTH, RECORDED_ON, read, plainText,
};
