'use strict';
/** Bounded, read-only extraction of ordinary ZIP and TAR archives attached to a turn. */
const zlib = require('node:zlib');

const MAX_ENTRIES = 100;
const MAX_EXTRACTED = 2 * 1024 * 1024;
const MAX_ENTRY = 512 * 1024;
const TEXT_NAME = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|log|xml|yaml|yml|toml|ini|cfg|conf|html?|css|scss|less|m?js|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|gql|proto|swift|lua|pl|r|m|vue|svelte|astro|tex|pdf)$/i;

const safeName = (name) => {
    const value = String(name || '').replace(/\\/g, '/');
    return value && !value.startsWith('/') && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(value) ? value.slice(0, 255) : null;
};
const readable = (name) => Boolean(safeName(name) && TEXT_NAME.test(name));

function zipEntries(buffer) {
    const start = Math.max(0, buffer.length - 65557);
    let end = -1;
    for (let i = buffer.length - 22; i >= start; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return { entries: [], reason: 'the ZIP directory is missing' };
    const count = buffer.readUInt16LE(end + 10);
    const size = buffer.readUInt32LE(end + 12);
    let offset = buffer.readUInt32LE(end + 16);
    if (count > MAX_ENTRIES || offset + size > buffer.length || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) {
        return { entries: [], reason: 'the ZIP is too large or uses multiple disks' };
    }
    const entries = [];
    let total = 0;
    let skipped = 0;
    for (let i = 0; i < count; i++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return { entries: [], reason: 'the ZIP directory is damaged' };
        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const packed = buffer.readUInt32LE(offset + 20);
        const length = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const local = buffer.readUInt32LE(offset + 42);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        if (next > buffer.length) return { entries: [], reason: 'the ZIP directory is damaged' };
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        offset = next;
        if (!readable(name) || (flags & 1) || ![0, 8].includes(method) || length > MAX_ENTRY || total + length > MAX_EXTRACTED) { skipped++; continue; }
        if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) { skipped++; continue; }
        const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        if (dataAt + packed > buffer.length) { skipped++; continue; }
        try {
            const compressed = buffer.subarray(dataAt, dataAt + packed);
            const bytes = method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY });
            if (bytes.length !== length) { skipped++; continue; }
            entries.push({ name: safeName(name), bytes });
            total += bytes.length;
        } catch { skipped++; }
    }
    return { entries, skipped };
}

function tarEntries(buffer) {
    const entries = [];
    let total = 0;
    let skipped = 0;
    let offset = 0;
    let count = 0;
    while (offset + 512 <= buffer.length && buffer[offset] !== 0) {
        if (++count > MAX_ENTRIES) return { entries: [], reason: 'the TAR has too many entries' };
        const head = buffer.subarray(offset, offset + 512);
        const name = head.subarray(0, 100).toString('utf8').replace(/\u0000.*$/, '');
        const rawSize = head.subarray(124, 136).toString('ascii').replace(/\u0000.*$/, '').trim();
        if (!/^[0-7]+$/.test(rawSize)) return { entries: [], reason: 'the TAR header is damaged' };
        const size = parseInt(rawSize, 8);
        const type = head[156];
        const dataAt = offset + 512;
        if (!Number.isSafeInteger(size) || dataAt + size > buffer.length) return { entries: [], reason: 'the TAR entry is incomplete' };
        if ((type === 0 || type === 48) && readable(name) && size <= MAX_ENTRY && total + size <= MAX_EXTRACTED) {
            entries.push({ name: safeName(name), bytes: buffer.subarray(dataAt, dataAt + size) });
            total += size;
        } else skipped++;
        offset = dataAt + Math.ceil(size / 512) * 512;
    }
    return { entries, skipped };
}

function extractArchive(buffer, type, name) {
    if (type === 'application/zip' || /\.zip$/i.test(name)) return zipEntries(buffer);
    if (/\.(?:tar\.gz|tgz)$/i.test(name) || type === 'application/gzip') {
        try { return tarEntries(zlib.gunzipSync(buffer, { maxOutputLength: MAX_EXTRACTED + MAX_ENTRIES * 512 })); }
        catch { return { entries: [], reason: 'the compressed TAR is damaged or too large' }; }
    }
    return tarEntries(buffer);
}

module.exports = { extractArchive, MAX_ENTRIES, MAX_EXTRACTED };
