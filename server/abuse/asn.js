'use strict';
/**
 * Plan E5: a local IP-to-ASN table, with no API call (scripts/update-ip2asn.js downloads iptoasn.com's free
 * monthly TSV files into data/ip2asn/). The module answers two questions about a client address:
 *
 *   lookup(ip)   → { asn, country, org, hosting }   which ASN the address is in, and whether it is a hosting one
 *   prefixOf(ip) → { family, prefix }               the IPv4 /24 or IPv6 /48 the address belongs to
 *
 * Nothing here keeps the address: the caller hashes the prefix with its own salt and stores the ASN and that
 * hash only (server/abuse/index.js, migrations/0034_abuse.sql).
 *
 * A hosting ASN is one whose organisation name says so (hosting, cloud, data centre, a known provider), or one
 * an operator names in AI_HOSTING_ASNS. The list is deliberately broad: a false positive costs a smaller free
 * allowance, a false negative lets a data-centre farm through.
 */
const fs = require('fs');
const net = require('net');

const HOSTING_ORG = /(hosting|hosted|cloud|data[ -]?cent(er|re)|datacenter|colocat|colo\b|dedicated|vps|virtual server|serverhub|leaseweb|m247|datacamp|cdn77|equinix|fastly|cloudflare|amazon|aws|google|microsoft|azure|digitalocean|hetzner|ovh|linode|akamai|vultr|choopa|contabo|oracle|alibaba|aliyun|tencent|scaleway|upcloud|ionos|1&1|rack[ -]?space|kamatera|aiven|linode|hostkey|psychz|quadranet|hivelocity|servarica|incero|frantech|buyvm)/i;

/** An IPv4 address as an unsigned 32-bit number, or null. */
function ipv4ToInt(value) {
    const s = String(value || '').trim();
    const parts = s.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        out = (out * 256) + n;
    }
    return out >>> 0;
}

/** An IPv6 address as a BigInt, or null. An embedded IPv4 tail (::ffff:192.0.2.1) is accepted. */
function ipv6ToBigInt(value) {
    let s = String(value || '').trim().toLowerCase();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    s = s.split('%')[0];                       // zone id, never part of the address
    if (!s || !s.includes(':')) return null;
    if (s.includes('.')) {
        const at = s.lastIndexOf(':');
        const v4 = ipv4ToInt(s.slice(at + 1));
        if (v4 == null) return null;
        s = `${s.slice(0, at + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if (halves.length === 1 && (head.length !== 8 || tail.length)) return null;
    if (halves.length === 2 && head.length + tail.length > 8) return null;
    const groups = [];
    for (let i = 0; i < 8; i++) {
        if (i < head.length) groups.push(head[i]);
        else if (i >= 8 - tail.length) groups.push(tail[i - (8 - tail.length)]);
        else groups.push('0');
    }
    let out = 0n;
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out = (out << 16n) | BigInt(parseInt(g, 16));
    }
    return out;
}

/** { family: 'v4' | 'v6', value } for an address, or null. A v4-mapped IPv6 address is treated as v4. */
function parseIp(value) {
    const s = String(value || '').trim();
    if (net.isIP(s) === 4) return { family: 'v4', value: ipv4ToInt(s) };
    if (net.isIP(s) !== 6) return null;
    const big = ipv6ToBigInt(s);
    if (big == null) return null;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
    if (mapped) {
        const v4 = ipv4ToInt(mapped[1]);
        if (v4 != null) return { family: 'v4', value: v4 };
    }
    return { family: 'v6', value: big };
}

/** The IPv4 /24 or IPv6 /48 an address belongs to, as text (never the address). Null when unparseable. */
function prefixOf(value) {
    const p = parseIp(value);
    if (!p) return null;
    if (p.family === 'v4') {
        const base = p.value & 0xffffff00;
        return { family: 'v4', prefix: `${[(base >>> 24) & 255, (base >>> 16) & 255, (base >>> 8) & 255, 0].join('.')}/24` };
    }
    const base = (p.value >> 80n) << 80n;
    return { family: 'v6', prefix: `${ipv6Text(base)}/48` };
}

/** BigInt IPv6 → compressed-enough text (the :: rule, lower case). */
function ipv6Text(value) {
    const groups = [];
    for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
    let bestAt = -1;
    let bestLen = 0;
    for (let i = 0; i < 8;) {
        if (groups[i] !== 0) { i++; continue; }
        let j = i;
        while (j < 8 && groups[j] === 0) j++;
        if (j - i > bestLen) { bestAt = i; bestLen = j - i; }
        i = j;
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestLen < 2) return hex.join(':');
    return `${hex.slice(0, bestAt).join(':')}::${hex.slice(bestAt + bestLen).join(':')}`;
}

function hostingOf({ asn, org } = {}, explicit) {
    if (asn != null && explicit && explicit.has(Number(asn))) return true;
    return Boolean(org && HOSTING_ORG.test(String(org)));
}

/** The parsed rows of one iptoasn file. Missing/unreadable files are an empty table, never a crash. */
function readRows(file, family, log) {
    if (!file) return [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
        if (err && err.code !== 'ENOENT') log.warn(`[abuse] cannot read ${file}: ${err.message}`);
        return [];
    }
    const out = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const cols = line.split('\t');
        if (cols.length < 5) { bad++; continue; }
        const start = family === 'v4' ? ipv4ToInt(cols[0]) : ipv6ToBigInt(cols[0]);
        const end = family === 'v4' ? ipv4ToInt(cols[1]) : ipv6ToBigInt(cols[1]);
        const asn = Number(cols[2]);
        if (start == null || end == null || !Number.isFinite(asn)) { bad++; continue; }
        // The org is the last column; an org with a tab in it stays one org.
        out.push({ start, end, asn, country: cols[3] || '', org: cols.slice(4).join(' ').trim() });
    }
    if (bad) log.warn(`[abuse] ${file}: ${bad} malformed rows ignored`);
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return out;
}

function makeTable(rows, family) {
    if (!rows.length) return null;
    if (family === 'v4') {
        const starts = new Uint32Array(rows.length);
        const ends = new Uint32Array(rows.length);
        const asns = new Uint32Array(rows.length);
        const orgs = new Array(rows.length);
        const countries = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            starts[i] = rows[i].start; ends[i] = rows[i].end; asns[i] = rows[i].asn; orgs[i] = rows[i].org; countries[i] = rows[i].country;
        }
        return { family, starts, ends, asns, orgs, countries, n: rows.length };
    }
    return { family, rows, n: rows.length };
}

function findV4(table, value) {
    let lo = 0;
    let hi = table.starts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (value < table.starts[mid]) hi = mid - 1;
        else if (value > table.ends[mid]) lo = mid + 1;
        else return { asn: table.asns[mid], country: table.countries[mid], org: table.orgs[mid] };
    }
    return null;
}

function findV6(table, value) {
    const rows = table.rows;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (value < rows[mid].start) hi = mid - 1;
        else if (value > rows[mid].end) lo = mid + 1;
        else return { asn: rows[mid].asn, country: rows[mid].country, org: rows[mid].org };
    }
    return null;
}

/**
 * createAsnTable({ v4File, v6File, hostingAsns, log }): lazy, process-wide and read-only. `lookup(ip)` never
 * keeps the address and answers `{ asn: null, country: null, org: null, hosting: false }` when the table has
 * no row (a missing dataset, a private address, a new range).
 */
function createAsnTable({ v4File = '', v6File = '', hostingAsns = [], log = console } = {}) {
    const explicit = new Set((hostingAsns || []).map(Number).filter((n) => Number.isFinite(n)));
    let loaded = false;
    let v4 = null;
    let v6 = null;
    function load() {
        if (loaded) return;
        loaded = true;
        v4 = makeTable(readRows(v4File, 'v4', log), 'v4');
        v6 = makeTable(readRows(v6File, 'v6', log), 'v6');
        if (!v4 && !v6) log.warn(`[abuse] no IP-to-ASN table loaded (${v4File || '-'}, ${v6File || '-'}): ASN signals are off until scripts/update-ip2asn.js runs`);
    }
    function lookup(ip) {
        load();
        const p = parseIp(ip);
        if (!p) return { asn: null, country: null, org: null, hosting: false };
        const row = p.family === 'v4' ? (v4 && findV4(v4, p.value)) : (v6 && findV6(v6, p.value));
        if (!row) return { asn: null, country: null, org: null, hosting: false };
        return { ...row, hosting: hostingOf(row, explicit) };
    }
    return {
        lookup,
        prefixOf,
        hostingOf: (row) => hostingOf(row, explicit),
        status: () => { load(); return { v4_ranges: v4 ? v4.n : 0, v6_ranges: v6 ? v6.n : 0, hosting_asns: explicit.size }; },
    };
}

module.exports = { createAsnTable, parseIp, prefixOf, ipv4ToInt, ipv6ToBigInt, ipv6Text, hostingOf, HOSTING_ORG };
