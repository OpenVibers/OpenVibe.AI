'use strict';
/**
 * A small, read-only ZIP reader for the memory import (Memory M3).
 *
 * A person's data export arrives as a .zip from ChatGPT, Claude or Google Takeout. We never write it to disk: the
 * bytes are parsed in memory, only the JSON entries are inflated, and every limit is checked before anything is
 * decompressed. No archive library is added to the service for this; the format we need is the central directory,
 * stored (0) and deflate (8) entries, and the basic ZIP64 fields used by exports over 4 GB.
 *
 * Limits: at most 5,000 entries, at most 60 MB of JSON, and at most 60 MB for any one entry. A broken archive is a
 * 422 to the person, never a stack trace: the messages here name the problem, never the archive's content.
 */

const zlib = require('zlib');

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 5000;
const MAX_TOTAL = 60 * 1024 * 1024;
const MAX_ENTRY = 60 * 1024 * 1024;
const MAX_JSON_ENTRIES = 200;

class ZipError extends Error {
    constructor(message) {
        super(message);
        this.code = 'import.bad_zip';
    }
}

/** The offset of the end-of-central-directory record, or -1. It lives in the last 65,557 bytes. */
function eocdOffset(buf) {
    const from = Math.max(0, buf.length - 0xffff - 22);
    for (let i = buf.length - 22; i >= from; i--) if (buf.readUInt32LE(i) === EOCD) return i;
    return -1;
}

/** The central directory's offset and entry count, including the ZIP64 form. */
function directory(buf) {
    const eocd = eocdOffset(buf);
    if (eocd < 0) throw new ZipError('that file is not a zip archive');
    let count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || offset === 0xffffffff) {
        const locator = eocd - 20;
        if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new ZipError('that zip archive uses an unsupported ZIP64 layout');
        const z64 = Number(buf.readBigUInt64LE(locator + 8));
        if (z64 < 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== ZIP64_EOCD) throw new ZipError('that zip archive has a broken ZIP64 directory');
        count = Number(buf.readBigUInt64LE(z64 + 32));
        offset = Number(buf.readBigUInt64LE(z64 + 48));
    }
    if (count > MAX_ENTRIES) throw new ZipError(`that zip archive has more than ${MAX_ENTRIES} files`);
    if (offset < 0 || offset >= buf.length) throw new ZipError('that zip archive has a broken directory');
    return { count, offset };
}

/** The ZIP64 extra field, when a central entry says a size or offset lives there. */
function zip64Extra(extra, wants) {
    let at = 0;
    while (at + 4 <= extra.length) {
        const id = extra.readUInt16LE(at);
        const size = extra.readUInt16LE(at + 2);
        const body = extra.subarray(at + 4, at + 4 + size);
        if (id === 0x0001) {
            let p = 0;
            const take = () => {
                if (p + 8 > body.length) throw new ZipError('that zip archive has a broken ZIP64 field');
                const n = Number(body.readBigUInt64LE(p));
                p += 8;
                return n;
            };
            return {
                size: wants.size ? take() : null,
                compressed: wants.compressed ? take() : null,
                offset: wants.offset ? take() : null,
            };
        }
        at += 4 + size;
    }
    throw new ZipError('that zip archive has a broken ZIP64 field');
}

/**
 * Read one archive. Returns an array of `{ name, data }` for the JSON files only; a directory and any other file
 * are skipped, because a memory export is JSON and nothing here needs to inflate a picture.
 */
function readZip(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('that file is not a zip archive');
    const dir = directory(buf);
    const out = [];
    let total = 0;
    let actual = 0;
    let at = dir.offset;
    for (let n = 0; n < dir.count; n++) {
        if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('that zip archive has a broken directory');
        const flags = buf.readUInt16LE(at + 8);
        const method = buf.readUInt16LE(at + 10);
        let compressed = buf.readUInt32LE(at + 20);
        let size = buf.readUInt32LE(at + 24);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const commentLen = buf.readUInt16LE(at + 32);
        let local = buf.readUInt32LE(at + 42);
        const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
        const extra = buf.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
        if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
            const z = zip64Extra(extra, { size: size === 0xffffffff, compressed: compressed === 0xffffffff, offset: local === 0xffffffff });
            if (z.compressed != null) compressed = z.compressed;
            if (z.size != null) size = z.size;
            if (z.offset != null) local = z.offset;
        }
        at += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue;
        if (!/\.json$/i.test(name)) continue;
        if (out.length >= MAX_JSON_ENTRIES) throw new ZipError(`that zip archive has more than ${MAX_JSON_ENTRIES} JSON files`);
        if (flags & 0x1) throw new ZipError('that zip archive is encrypted');
        if (method !== 0 && method !== 8) throw new ZipError('that zip archive uses a compression this service does not read');
        if (size > MAX_ENTRY) throw new ZipError('a file in that zip archive is larger than 60 MB');
        total += size;
        if (total > MAX_TOTAL) throw new ZipError('that zip archive unpacks to more than 60 MB of JSON');
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new ZipError('that zip archive has a broken entry');
        const lName = buf.readUInt16LE(local + 26);
        const lExtra = buf.readUInt16LE(local + 28);
        const start = local + 30 + lName + lExtra;
        if (start + compressed > buf.length) throw new ZipError('that zip archive ends in the middle of a file');
        const raw = buf.subarray(start, start + compressed);
        let data;
        if (method === 0) {
            data = Buffer.from(raw);
        } else {
            try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(MAX_ENTRY, size || MAX_ENTRY) + 1 }); }
            catch { throw new ZipError('a file in that zip archive did not unpack'); }
            if (data.length > MAX_ENTRY) throw new ZipError('a file in that zip archive is larger than 60 MB');
        }
        actual += data.length;
        if (actual > MAX_TOTAL) throw new ZipError('that zip archive unpacks to more than 60 MB of JSON');
        out.push({ name, data });
    }
    return out;
}

module.exports = { readZip, ZipError, MAX_ENTRY, MAX_TOTAL, MAX_JSON_ENTRIES };
