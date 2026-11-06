'use strict';
/**
 * The memory import (OpenVibe Memory M3): a guided, preview-first import of a cloud assistant's export.
 *
 * The flow, and why it is in two steps:
 *   1. POST /api/v1/memory/import/preview  parse, redact, and hold the candidates in one sealed, two-hour draft.
 *      Nothing enters the memory store yet: the person sees every candidate and unticks what they do not want.
 *   2. POST /api/v1/memory/import/:id/commit  take the ticked keys and import them, through the same store path
 *      M2 reads (the batch import), then delete the draft. Left-out candidates are deleted with it.
 *
 * The draft is a row in memory_imports whose payload is sealed with the memory key and bound to its owner and id
 * (AAD `memory-import|<owner>|<id>`). The table holds no plaintext, the routes never log text, and an expired draft
 * is deleted on the next preview. A service token cannot preview or commit: this is the person's own memory.
 */

const { ids } = require('openvibe-contracts');
const { AiError, iso } = require('../../util');
const { readZip, ZipError } = require('./zip');
const { PROVIDERS, EXTRACTION_PROMPT, ImportError, normalizeProvider, parseExport, providerName } = require('./providers');

const IMPORT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PARTS = 20;
const MAX_KEEP = 500;
const KEEP_RE = /^k[1-9][0-9]{0,5}$/;

function aadFor(owner, id) { return `memory-import|${owner}|${id}`; }

/** The boundary and the one file / few fields of our own multipart form. Binary-safe through latin1. */
function parseMultipart(buf, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
    if (!m) throw new ImportError('That upload was not a valid form. Try again.');
    const boundary = '--' + (m[1] || m[2]);
    const text = buf.toString('latin1');
    const fields = {};
    let file = null;
    let parts = 0;
    for (const chunk of text.split(boundary).slice(1)) {
        if (chunk.startsWith('--')) break;
        parts++;
        if (parts > MAX_PARTS) throw new ImportError('That form had too many parts.');
        const part = chunk.replace(/^\r\n/, '');
        const split = part.indexOf('\r\n\r\n');
        if (split < 0) continue;
        const head = part.slice(0, split);
        let body = part.slice(split + 4);
        if (body.endsWith('\r\n')) body = body.slice(0, -2);
        const name = /name="([^"]+)"/i.exec(head);
        if (!name) continue;
        const filename = /filename="([^"]*)"/i.exec(head);
        if (filename && filename[1]) file = { name: filename[1], data: Buffer.from(body, 'latin1') };
        else fields[name[1]] = Buffer.from(body, 'latin1').toString('utf8');
    }
    return { fields, file };
}

function createMemoryImport({ memory, db, config, clock = { now: () => Date.now() }, log = console }) {
    const q = (sql) => db.prepare(sql);
    const expire = async (owner) => {
        await q('DELETE FROM memory_imports WHERE owner = ? AND expires_at < ?').run(owner, iso(clock.now()));
    };

    /** The request's bytes, as a file or as pasted text, with the provider named in the form or by its shape. */
    function readInput(req) {
        const asked = normalizeProvider((req.query && req.query.provider) || null);
        const type = String(req.get('content-type') || '').toLowerCase();
        let provider = asked;
        let filename = '';
        let text = null;
        let files = [];
        let body = req.body;
        if (Buffer.isBuffer(body)) {
            if (body.length > MAX_BYTES) throw new ImportError('That upload is larger than 25 MB. Export only the assistant’s data, or paste the extraction answer instead.');
            if (type.includes('multipart/form-data')) {
                const parsed = parseMultipart(body, type);
                if (parsed.fields.provider) provider = normalizeProvider(parsed.fields.provider) || provider;
                if (parsed.fields.text) text = parsed.fields.text;
                if (parsed.file) { filename = parsed.file.name; files = readZip(parsed.file.data); }
            } else if (type.includes('text/plain')) {
                text = body.toString('utf8');
            } else {
                files = readZip(body);
            }
        } else if (body && typeof body === 'object') {
            if (body.provider) provider = normalizeProvider(body.provider) || provider;
            if (typeof body.text === 'string') text = body.text;
        } else {
            throw new ImportError('Drop an export .zip or paste the answer to the extraction prompt.');
        }
        if (!files.length && (text == null || !String(text).trim())) {
            throw new ImportError('Drop an export .zip or paste the answer to the extraction prompt.');
        }
        return { provider, filename, files, text };
    }

    /** Parse and redact. Nothing is written here; the draft below is the only row. */
    async function preview(req, owner) {
        memory.assertConfigured();
        let parsed;
        try {
            const input = readInput(req);
            parsed = parseExport(input);
        } catch (err) {
            if (err instanceof ZipError) throw new AiError(422, 'import.bad_zip', err.message);
            if (err instanceof ImportError) throw new AiError(err.status || 422, err.code, err.message);
            throw err;
        }
        const now = iso(clock.now());
        await expire(owner);
        if (!parsed.items.length) {
            return { import: { id: null, provider: parsed.provider, summary: parsed.summary, items: [], expires_at: null } };
        }
        const id = `mimp_${ids.ulid()}`;
        const items = parsed.items.map((item, i) => ({ ...item, key: `k${i + 1}` }));
        const expires = new Date(clock.now() + IMPORT_TTL_MS).toISOString();
        const payload = { provider: parsed.provider, summary: parsed.summary, items };
        await q('INSERT INTO memory_imports (id, owner, provider, payload_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, owner, parsed.provider, memory.seal(JSON.stringify(payload), aadFor(owner, id)), now, expires);
        return {
            import: {
                id, provider: parsed.provider, provider_name: providerName(parsed.provider),
                summary: parsed.summary, items, created_at: now, expires_at: expires,
            },
        };
    }

    async function draft(owner, id) {
        if (!/^mimp_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw new AiError(404, 'import.not_found', 'That preview is no longer here.');
        const row = await q('SELECT * FROM memory_imports WHERE owner = ? AND id = ?').get(owner, id);
        if (!row) throw new AiError(404, 'import.not_found', 'That preview is no longer here.');
        if (String(row.expires_at) < iso(clock.now())) {
            await q('DELETE FROM memory_imports WHERE owner = ? AND id = ?').run(owner, id);
            throw new AiError(410, 'import.expired', 'That preview has expired. Drop the export again.');
        }
        let payload;
        try { payload = JSON.parse(memory.open(row.payload_enc, aadFor(owner, id))); }
        catch (err) { throw err instanceof AiError ? err : new AiError(500, 'memory.unreadable', 'the preview does not open'); }
        return { row, payload };
    }

    /** Keep the ticked candidates. The store's own batch path redacts again and dedupes; the draft is then gone. */
    async function commit(req, owner, id) {
        memory.assertConfigured();
        const { payload } = await draft(owner, id);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const raw = body.keep == null ? [] : Array.isArray(body.keep) ? body.keep : [body.keep];
        if (raw.length > MAX_KEEP) throw new AiError(422, 'import.too_many', `Keep at most ${MAX_KEEP} notes at a time.`);
        const keys = new Set();
        for (const key of raw) {
            if (!KEEP_RE.test(String(key))) throw new AiError(422, 'import.invalid', 'one of the chosen notes is not from this preview');
            keys.add(String(key));
        }
        const selected = (payload.items || []).filter((item) => keys.has(item.key));
        const leftOut = Math.max(0, (payload.items || []).length - selected.length);
        if (!selected.length) {
            await q('DELETE FROM memory_imports WHERE owner = ? AND id = ?').run(owner, id);
            return { kept: 0, created: 0, deduped: 0, left_out: leftOut };
        }
        const out = await memory.batch({ body: { items: selected }, principal: req.principal }, owner);
        await q('DELETE FROM memory_imports WHERE owner = ? AND id = ?').run(owner, id);
        log.log(`[memory] imported ${out.created + out.deduped} note(s) from ${payload.provider}; ${leftOut} left out`);
        return { kept: out.created + out.deduped, created: out.created, deduped: out.deduped, left_out: leftOut };
    }

    async function discard(owner, id) {
        const { payload } = await draft(owner, id);
        await q('DELETE FROM memory_imports WHERE owner = ? AND id = ?').run(owner, id);
        return { discarded: (payload.items || []).length };
    }

    /** The maintenance loop's sweep: expired drafts go without waiting for the person to come back. */
    async function expireDrafts(limit = 100) {
        const n = Math.max(1, Math.min(500, Number(limit) || 100));
        const rows = await q(`SELECT id FROM memory_imports WHERE expires_at < ? ORDER BY expires_at LIMIT ${n}`).all(iso(clock.now()));
        for (const row of rows) await q('DELETE FROM memory_imports WHERE id = ?').run(row.id);
        return rows.length;
    }

    /** The walkthrough copy and the extraction prompt. No note ever appears in it. */
    function providers() {
        return { providers: PROVIDERS, prompt: EXTRACTION_PROMPT };
    }

    return { preview, commit, discard, providers, expire, expireDrafts, aadFor };
}

module.exports = { createMemoryImport, parseMultipart, IMPORT_TTL_MS, MAX_BYTES };
