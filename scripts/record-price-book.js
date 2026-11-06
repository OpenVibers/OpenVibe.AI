'use strict';
/**
 * Record the providers' own price listings as fixtures (test/fixtures/pricebook/).
 *
 * The price book reads the open internet once a week in production and never in the tests: the tests replay the
 * listings recorded here. This script is how a fixture is refreshed — it reads each listing through the same
 * egress guard the job uses, keeps the rows the catalogue cares about (the listing of a provider with a thousand
 * models is a megabyte of fixture nobody reads) and writes the result.
 *
 *   node scripts/record-price-book.js [outdir]
 *
 * The recorded date is in the file name of the manifest (test/fixtures/pricebook/manifest.json), so a test can say
 * when the listing was read.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../server/providers/pool-providers');
const { SOURCES } = require('../server/pricebook/sources');
const { readListing } = require('../server/pricebook/read');

const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'pricebook');

/** The models of a provider the catalogue knows, so the fixture keeps the rows that matter. */
function wantedFor(provider) {
    if (provider === 'deepseek') return ['deepseek-flash', 'deepseek-v4-pro'];
    const p = pool.byKey.get(provider);
    return p ? p.models.map((m) => m.model_key) : [];
}

const leaf = (id) => String(id || '').split('/').pop().toLowerCase();

/** The JSON listings: only the models the catalogue knows. */
function trimJson(body, wanted) {
    const json = JSON.parse(body);
    const leaves = new Set(wanted.map(leaf));
    const keep = (json.data || []).filter((m) => leaves.has(leaf(m.id)) || wanted.some((w) => String(m.id || '').toLowerCase() === w.toLowerCase()));
    return JSON.stringify({ ...json, data: keep }, null, 2);
}

/** Alibaba's page: the table rows of the models the catalogue knows. */
function trimQwen(body, wanted) {
    const rows = [...body.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    const keep = rows.filter((row) => wanted.some((w) => row.includes(w)));
    return keep.join('\n');
}

/** Kimi's page: the table payloads (the columns and the rows) that name a model the catalogue knows. */
function trimKimi(body, wanted) {
    const end = (text, start) => {
        let depth = 0;
        for (let i = start; i < text.length; i++) {
            if (text[i] === '[') depth++;
            else if (text[i] === ']') { depth--; if (depth === 0) return i; }
        }
        return -1;
    };
    const out = [];
    let at = 0;
    while ((at = body.indexOf('columns:[', at)) !== -1) {
        const colsStart = body.indexOf('[', at);
        const colsEnd = end(body, colsStart);
        const rowsAt = body.indexOf('rows:[', colsEnd);
        if (rowsAt === -1) break;
        const rowsStart = body.indexOf('[', rowsAt);
        const rowsEnd = end(body, rowsStart);
        const columns = body.slice(at, colsEnd + 1);
        const rows = body.slice(rowsAt, rowsEnd + 1);
        if (wanted.some((w) => rows.includes(w))) out.push(columns + '\n' + rows);
        at = rowsEnd;
    }
    return out.join('\n\n');
}

async function recordFixtures() {
    fs.mkdirSync(OUT, { recursive: true });
    const manifest = { recorded_at: new Date().toISOString().slice(0, 10), sources: [] };
    for (const source of SOURCES) {
        const res = await readListing(source.url);
        if (!res.ok) {
            console.error(`${source.key}: ${res.error}`);
            manifest.sources.push({ key: source.key, url: source.url, error: res.error });
            continue;
        }
        // The cross-reference is compared with every provider's models, so it keeps all of them.
        const wanted = source.role === 'cross-reference'
            ? pool.PROVIDERS.flatMap((p) => p.models.map((m) => m.model_key))
            : wantedFor(source.provider);
        let body = res.body;
        let file = source.key;
        if (source.kind === 'json') { body = trimJson(body, wanted); file += '.json'; }
        else if (source.key === 'qwen') { body = trimQwen(body, wanted); file += '.html'; }
        else if (source.key === 'kimi') { body = trimKimi(body, wanted); file += '.html'; }
        else file += '.md';
        fs.writeFileSync(path.join(OUT, file), body);
        console.log(`${source.key}: ${body.length} bytes -> ${file}`);
        manifest.sources.push({ key: source.key, url: source.url, file, bytes: body.length, listed: Object.keys(source.parse(source.kind === 'json' ? JSON.parse(body) : body)).length });
    }
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

module.exports = { wantedFor, trimJson, trimQwen, trimKimi, recordFixtures };

if (require.main === module) recordFixtures().catch((err) => { console.error(err.message); process.exitCode = 1; });
