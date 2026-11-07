'use strict';
/**
 * The parsers that read a provider's own price listing and turn it into prices per million tokens.
 *
 * Every provider publishes its prices in its own shape: a JSON model list (DeepInfra, Novita, Featherless,
 * OpenRouter), a markdown table (Z.ai, Abliteration.ai, MiniMax, DeepSeek), an HTML table (Alibaba's Model
 * Studio) or a table the page builds in the browser (Moonshot's Kimi). One parser per shape, one rule for all of
 * them: a price nobody publishes is null, never a guess.
 *
 * The result is a map from a model's leaf name (its id without the namespace, in lower case) to the three prices
 * the catalogue holds: in, cached (the cache read) and out. A field the listing does not publish stays null, and
 * the price book leaves the live price of that field alone.
 *
 * These parsers read bytes, never a network: the weekly job hands them what the egress guard fetched, and the
 * tests replay the recorded listings (test/fixtures/pricebook/).
 */

/** A model's name without its namespace: "deepseek/deepseek-chat" -> "deepseek-chat". */
const leaf = (id) => String(id === null || id === undefined ? '' : id).split('/').pop().trim().toLowerCase();

/** A number, or null when the cell holds no number at all. */
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * A money cell: "$0.030", "\$1.4", "1,200" -> the number. A struck-through price is the old one, so it is
 * dropped first ("~~$0.60~~ $0.30" is $0.30). A cell that names no price is null, never a guess.
 */
function money(cell) {
    if (cell === null || cell === undefined) return null;
    const text = String(cell).replace(/~~[^~]*~~/g, ' ').replace(/\\?\$/g, ' ').replace(/,/g, '');
    const m = text.match(/-?\d+(?:\.\d+)?/);
    return m ? num(m[0]) : null;
}

/** A price cell: a money cell, or 0 when the provider says the model is free. */
function price(cell) {
    const m = money(cell);
    if (m !== null) return m;
    const t = String(cell === null || cell === undefined ? '' : cell).trim().toLowerCase();
    if (t === 'free' || t === 'free of charge') return 0;
    return null;
}

/** The leading identifier of a cell: "**MiniMax-M3** <= 512k input tokens" -> "MiniMax-M3". */
function leadingId(cell) {
    const t = String(cell === null || cell === undefined ? '' : cell).replace(/\*\*/g, '');
    const m = t.match(/[A-Za-z0-9][A-Za-z0-9._-]*/);
    return m ? m[0].toLowerCase() : null;
}

/** The trailing identifier of a cell: "**Abliterated Model**abliterated-model" -> "abliterated-model". */
function trailingId(cell) {
    const t = String(cell === null || cell === undefined ? '' : cell).replace(/\*\*/g, ' ');
    const token = t.trim().split(/\s+/).pop() || '';
    const id = token.replace(/^[^A-Za-z0-9._-]+/, '');
    return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id.toLowerCase() : null;
}

/** The header of a table, normalized: bold and dollars dropped, spaces collapsed, lower case. */
const normHead = (h) => String(h === null || h === undefined ? '' : h).replace(/\*\*/g, ' ').replace(/\?\$/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The markdown tables of a page. A table is a run of lines that start with a pipe; the quoted rows of an
 * accordion ("> | Model | ...") are tables of their own, so the quote marker is dropped first.
 * -> [{ header: [cell], rows: [[cell]] }]
 */
function markdownTables(text) {
    const tables = [];
    let cur = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/^\s*>\s?/, '').trim();
        if (!line.startsWith('|')) { if (cur) { tables.push(cur); cur = null; } continue; }
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (!cur) { cur = { header: cells, rows: [] }; continue; }
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;      // the separator row under the header
        cur.rows.push(cells);
    }
    if (cur) tables.push(cur);
    return tables;
}

/** The column of a table whose header starts with one of these words (the first that matches). */
function columnOf(header, prefixes) {
    const head = header.map(normHead);
    for (const p of prefixes) {
        const i = head.findIndex((h) => h === p || h.startsWith(p));
        if (i >= 0) return i;
    }
    return -1;
}

/** The HTML text of a cell: tags dropped, entities decoded, spaces collapsed. */
function htmlText(fragment) {
    return String(fragment || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The index of the matching bracket, ignoring the brackets inside a backticked string. */
function matchBracket(text, start) {
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (quoted) { if (ch === '\\') i++; else if (ch === '`') quoted = false; continue; }
        if (ch === '`') { quoted = true; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** The rows of a "rows:[[...]]" payload: each row is the text between the outer brackets. */
function payloadRows(text, start) {
    const end = matchBracket(text, start);
    if (end < 0) return [];
    const body = text.slice(start + 1, end);          // without the outer '[' and ']'
    const rows = [];
    let depth = 0;
    let quoted = false;
    let from = 0;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (quoted) { if (ch === '\\') i++; else if (ch === '`') quoted = false; continue; }
        if (ch === '`') { quoted = true; continue; }
        if (ch === '[') { if (depth === 0) from = i + 1; depth++; continue; }
        if (ch === ']') { depth--; if (depth === 0) { rows.push(body.slice(from, i)); from = i + 1; } continue; }
    }
    return rows;
}

/** The backticked strings of a payload row: the href, the model's name and the prices. */
const backticked = (text) => [...String(text || '').matchAll(/`([^`]*)`/g)].map((m) => m[1]);

// ── The parsers ───────────────────────────────────────────────

/**
 * Z.ai's pricing page (markdown): Model | Input | Cached Input | Cached Input Storage | Output. The model id
 * is the name in the first column.
 */
function glm(text) {
    const out = {};
    for (const t of markdownTables(text)) {
        const iModel = columnOf(t.header, ['model']);
        const iIn = columnOf(t.header, ['input']);
        const iOut = columnOf(t.header, ['output']);
        const iCached = columnOf(t.header, ['cached input']);
        if (iModel < 0 || iIn < 0 || iOut < 0) continue;
        for (const row of t.rows) {
            const id = leadingId(row[iModel]);
            if (!id || out[id]) continue;
            const entry = { in: price(row[iIn]), cached: iCached >= 0 ? price(row[iCached]) : null, out: price(row[iOut]) };
            if (entry.in === null && entry.out === null) continue;
            out[id] = entry;
        }
    }
    return out;
}

/**
 * Abliteration.ai's pricing page (markdown): Model | Input / 1M | Cached input / 1M | Output / 1M. The first
 * column holds the display name and the model's id side by side, so the id is the trailing word of the cell.
 */
function abliteration(text) {
    const out = {};
    for (const t of markdownTables(text)) {
        const iModel = columnOf(t.header, ['model']);
        const iIn = columnOf(t.header, ['input']);
        const iOut = columnOf(t.header, ['output']);
        const iCached = columnOf(t.header, ['cached input']);
        if (iModel < 0 || iIn < 0 || iOut < 0) continue;
        for (const row of t.rows) {
            const id = trailingId(row[iModel]);
            if (!id || out[id]) continue;
            const entry = { in: price(row[iIn]), cached: iCached >= 0 ? price(row[iCached]) : null, out: price(row[iOut]) };
            if (entry.in === null && entry.out === null) continue;
            out[id] = entry;
        }
    }
    return out;
}

/**
 * MiniMax's pricing page (markdown): Model | Input | Output | Prompt caching Read, per million tokens. The
 * page lists a model once per token tier and once per service tier; the first row wins, so the standard tier up
 * to 512K is the one the catalogue holds. A price the page struck through is the old one.
 */
function minimax(text) {
    const out = {};
    for (const t of markdownTables(text)) {
        const iModel = columnOf(t.header, ['model']);
        const iIn = columnOf(t.header, ['input']);
        const iOut = columnOf(t.header, ['output']);
        const iCached = columnOf(t.header, ['prompt caching read', 'cached']);
        if (iModel < 0 || iIn < 0 || iOut < 0) continue;
        for (const row of t.rows) {
            const id = leadingId(row[iModel]);
            if (!id || out[id]) continue;
            const entry = { in: price(row[iIn]), cached: iCached >= 0 ? price(row[iCached]) : null, out: price(row[iOut]) };
            if (entry.in === null && entry.out === null) continue;
            out[id] = entry;
        }
    }
    return out;
}

/**
 * DeepSeek's pricing page (markdown, transposed): the models are the columns and the prices the rows, with an
 * OFF-PEAK and a PEAK rate for each. The card carries the peak rate (the page halves it off-peak).
 */
function deepseekBand(text, want) {
    const out = {};
    for (const t of markdownTables(text)) {
        const columns = [];
        t.header.forEach((cell, index) => {
            const id = String(cell || '').replace(/\(\d+\)\s*$/, '').trim().toLowerCase();
            if (!id || id === 'model' || id.startsWith('pricing')) return;
            columns.push({ index, id });
        });
        if (!columns.length) continue;
        for (const row of t.rows) {
            const metric = String(row[1] || '').toUpperCase();
            const band = String(row[2] || '').toUpperCase();
            if (band !== want) continue;                         // one band at a time: the peak one, or the off-peak one
            let field = null;
            if (metric.includes('CACHE HIT')) field = 'cached';
            else if (metric.includes('CACHE MISS')) field = 'in';
            else if (metric.includes('OUTPUT TOKENS')) field = 'out';
            if (!field) continue;
            for (const c of columns) {
                const value = price(row[c.index]);
                if (value === null) continue;
                if (!out[c.id]) out[c.id] = { in: null, cached: null, out: null };
                if (out[c.id][field] === null) out[c.id][field] = value;
            }
        }
    }
    return out;
}

/** The DeepSeek listing's peak prices: the card the router charges. */
function deepseek(text) {
    return deepseekBand(text, 'PEAK');
}

/**
 * The off-peak hours (UTC) a listing publishes, if it publishes any. The window is read from the page's
 * own words; a listing that does not say when its off-peak price applies has no window, and a paid route
 * without a window is not eligible for a batch.
 */
function offPeakWindow(text) {
    const m = /off[-\s]?peak[^\n]{0,160}?(\d{1,2})[:.](\d{2})\s*(?:-|–|—|to|until)\s*(\d{1,2})[:.](\d{2})/i.exec(String(text || ''));
    if (!m) return null;
    const start = Number(m[1]) % 24;
    const end = Number(m[3]) % 24;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start_hour: start, end_hour: end };
}

/**
 * The off-peak window and the prices inside it, as the listing publishes them. DeepSeek's pricing page
 * carries an OFF-PEAK row for every model beside the PEAK one, and the hours the off-peak price applies.
 */
function deepseekOffPeak(text) {
    const prices = deepseekBand(text, 'OFF-PEAK');
    const window = offPeakWindow(text);
    if (!window || !Object.keys(prices).length) return { window: null, prices: {} };
    return { window, prices };
}

/**
 * Alibaba Model Studio's pricing page (HTML): a table per deployment, with the model id, the deployment scope,
 * the token tier and the input and output price. The catalogue holds the international deployment, so a row
 * without that scope is another deployment and is left alone.
 */
function qwen(html) {
    const out = {};
    for (const tr of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => htmlText(m[1]));
        if (cells.length < 4) continue;
        if (!cells.some((c) => c.toLowerCase() === 'international')) continue;
        const id = leadingId(cells[0]);
        if (!id || out[id]) continue;
        const prices = cells.filter((c) => /^\$[\d.,]+$/.test(c)).map((c) => price(c));
        if (prices.length < 2) continue;
        out[id] = { in: prices[0], cached: null, out: prices[1] };
    }
    return out;
}

/**
 * Moonshot's Kimi pricing page: the table is built in the browser, so the prices live in the page's own
 * payload next to its column titles (Model | Input | Output | Cached Input | 5m writes | 1h writes).
 */
function kimi(html) {
    const text = String(html || '');
    const out = {};
    let at = 0;
    while ((at = text.indexOf('columns:[', at)) !== -1) {
        const colsEnd = matchBracket(text, text.indexOf('[', at));
        if (colsEnd < 0) break;
        const titles = [...text.slice(at, colsEnd).matchAll(/title:(?:`([^`]*)`|[\s\S]*?children:`([^`]*)`)/g)]
            .map((m) => (m[1] || m[2] || '').trim().toLowerCase());
        const rowsAt = text.indexOf('rows:[', colsEnd);
        if (rowsAt === -1) break;
        for (const row of payloadRows(text, rowsAt + 'rows:'.length)) {
            const parts = backticked(row);
            if (parts.length < 3) continue;
            const id = leaf(parts[1]);
            if (!id || out[id]) continue;
            const entry = { in: null, cached: null, out: null };
            titles.forEach((title, index) => {
                if (index === 0) return;                       // the model column
                const value = price(parts[index + 1]);
                if (value === null) return;
                if (title === 'input') entry.in = value;
                else if (title === 'output') entry.out = value;
                else if (title.startsWith('cached input')) entry.cached = value;
            });
            if (entry.in === null && entry.out === null) continue;
            out[id] = entry;
        }
        at = rowsAt + 5;
    }
    return out;
}

/** DeepInfra's own model list: metadata.pricing per million tokens. */
function deepinfra(json) {
    const out = {};
    for (const m of (json && json.data) || []) {
        const p = (m.metadata && m.metadata.pricing) || null;
        if (!p) continue;
        const id = String(m.id || '').trim().toLowerCase();
        if (!id) continue;
        out[id] = { in: num(p.input_tokens), cached: num(p.cache_read_tokens), out: num(p.output_tokens) };
    }
    return out;
}

/** Novita's own model list: pricing.<metric>.price_per_m_decimal per million tokens. */
function novita(json) {
    const out = {};
    for (const m of (json && json.data) || []) {
        const p = (m && m.pricing) || null;
        if (!p) continue;
        const id = String(m.id || '').trim().toLowerCase();
        if (!id) continue;
        const pick = (key) => {
            const e = p[key];
            if (!e) return null;
            return num(e.price_per_m_decimal !== undefined ? e.price_per_m_decimal : e.price_per_m);
        };
        out[id] = { in: pick('prompt'), cached: pick('input_cache_read'), out: pick('completion') };
    }
    return out;
}

/** Featherless's own model list: pricing.input and pricing.output per million tokens. */
function featherless(json) {
    const out = {};
    for (const m of (json && json.data) || []) {
        const p = (m && m.pricing) || null;
        if (!p) continue;
        const id = String(m.id || '').trim().toLowerCase();
        if (!id) continue;
        let input = num(p.input);
        let output = num(p.output);
        if (input === null && p.prompt !== undefined) { const n = num(p.prompt); input = n === null ? null : n * 1e6; }
        if (output === null && p.completion !== undefined) { const n = num(p.completion); output = n === null ? null : n * 1e6; }
        out[id] = { in: input, cached: null, out: output };
    }
    return out;
}

/** OpenRouter's public model list: the prices are per token, so they are carried over per million tokens. */
function openrouter(json) {
    const out = {};
    for (const m of (json && json.data) || []) {
        const p = (m && m.pricing) || null;
        if (!p) continue;
        const id = String(m.id || '').trim().toLowerCase();
        if (!id) continue;
        const per = (v) => { const n = num(v); return n === null ? null : n * 1e6; };
        out[id] = { in: per(p.prompt), cached: null, out: per(p.completion) };
    }
    return out;
}

/**
 * Refuseless publishes its model list but no price at all (its pricing page answers a bot check). The parser
 * reads the list and finds no price, so the price book leaves every price of that provider alone.
 */
function refuseless(text) {
    const out = {};
    const body = String(text || '');
    // The page shows the API's own answer (a JSON block); the ids are what it names.
    const block = body.match(/```json[\s\S]*?```/);
    if (block) {
        try {
            const json = JSON.parse(block[0].replace(/^```json/, '').replace(/```$/, '').trim());
            for (const m of json.data || []) {
                const id = leaf(m.id);
                if (!id) continue;
                if (!out[id]) out[id] = { in: null, cached: null, out: null };
            }
        } catch { /* the page's answer is not JSON: the ids are read below */ }
    }
    if (!Object.keys(out).length) {
        for (const m of body.matchAll(/"id":\s*"([^"]+)"/g)) {
            const id = leaf(m[1]);
            if (!id) continue;
            if (!out[id]) out[id] = { in: null, cached: null, out: null };
        }
    }
    return out;
}

module.exports = {
    leaf, num, money, price, markdownTables, htmlText, columnOf, normHead, leadingId, trailingId,
    glm, abliteration, minimax, deepseek, qwen, kimi, deepinfra, novita, featherless, openrouter, refuseless,
};
