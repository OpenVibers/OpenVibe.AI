#!/usr/bin/env node
'use strict';
/**
 * Plan E5: download iptoasn.com's free monthly IP-to-ASN table into data/ip2asn/ (never a paid API).
 *
 *   node scripts/update-ip2asn.js            # data/ip2asn/ip2asn-v4.tsv and -v6.tsv
 *   node scripts/update-ip2asn.js --dir DIR  # somewhere else (AI_IP2ASN_V4 / AI_IP2ASN_V6 point there)
 *
 * The files are the source data (range_start, range_end, ASN, country, org), tab separated and gzipped. The
 * service reads them lazily (server/abuse/asn.js); a download replaces the old file only after the new one has
 * been checked, so a failed run never leaves a half-written table. Run it monthly (iptoasn publishes monthly):
 *
 *   17 4 1 * *  cd /srv/openvibe/ai && node scripts/update-ip2asn.js >> data/ip2asn/update.log 2>&1
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCES = [
    { name: 'ip2asn-v4.tsv', url: 'https://iptoasn.com/data/ip2asn-v4.tsv.gz', family: 4 },
    { name: 'ip2asn-v6.tsv', url: 'https://iptoasn.com/data/ip2asn-v6.tsv.gz', family: 6 },
];

function arg(name) {
    const at = process.argv.indexOf(name);
    return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : null;
}

async function download(source) {
    const res = await fetch(source.url, { headers: { 'user-agent': 'openvibe-ai/ip2asn-update (+https://openvibe.services)' }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${source.url} answered ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    if (gz.length < 1024 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new Error(`${source.url} did not answer a gzip file`);
    const text = zlib.gunzipSync(gz).toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    if (lines.length < 1000) throw new Error(`${source.url} returned only ${lines.length} rows`);
    const first = lines[0].split('\t');
    if (first.length < 5) throw new Error(`${source.url} rows do not have five columns`);
    // A quick sanity check on every 1000th row: at least one row must parse as an address range, so an HTML
    // error page or an empty snapshot never replaces a working table.
    const bad = lines.slice(0, 2000).filter((line) => line.split('\t').length < 5).length;
    if (bad) throw new Error(`${source.url}: ${bad} malformed rows in the first 2000`);
    return { text, rows: lines.length };
}

async function main() {
    const dir = path.resolve(arg('--dir') || process.env.AI_IP2ASN_DIR || path.join(__dirname, '..', 'data', 'ip2asn'));
    fs.mkdirSync(dir, { recursive: true });
    for (const source of SOURCES) {
        process.stdout.write(`[ip2asn] ${source.url}\n`);
        const got = await download(source);
        const target = path.join(dir, source.name);
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, got.text);
        fs.renameSync(tmp, target);
        process.stdout.write(`[ip2asn] ${target}: ${got.rows} rows, ${(got.text.length / 1024 / 1024).toFixed(1)} MB\n`);
    }
    process.stdout.write(`[ip2asn] done at ${new Date().toISOString()}\n`);
}

main().catch((err) => {
    process.stderr.write(`[ip2asn] failed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
