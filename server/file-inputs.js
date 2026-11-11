'use strict';
/**
 * Files on a turn: Media-backed attachments read for the model, never stored in the run.
 *
 * A conversational request names its files by Media reference (`ai.file@1`: an `id`/`storage.key` that
 * is a `med_…` object id). The bytes are fetched from Media ONLY for this provider call and are never
 * written to the database: the run keeps the references (and a passthrough workflow does not keep its
 * prompt at all), the provider gets text or image content, and the buffers die with the request.
 *
 * What a file becomes depends on its real type (the Media content type, else the name's extension):
 *   text, markdown, code, CSV and JSON   a text block, cut at MAX_TEXT_CHARS with an honest "(truncated)" line
 *   PDF                                  its text, page by page, through the small extractor below (no dependency)
 *   PNG, JPEG, WebP, GIF                 an image part, when the model can see (vision); otherwise a named note
 *   audio                                a transcript from the host's local ASR, or an honest unavailable note
 *   ZIP, TAR, TAR.GZ                      bounded text/code/PDF entries with their paths; other entries named as skipped
 *   anything else                        a named note saying it could not be read, never silently dropped
 *
 * Limits: MAX_FILES per turn, MAX_FILE_BYTES each and MAX_TOTAL_BYTES together. Per-person, per-window
 * limits come from the existing quota system (server/quota.js `chargeFiles`), which counts the files a
 * person attaches before the provider is called.
 *
 * The virus scanner is a named extension point: `setScanner(fn)` (or the `scan` option) is awaited on
 * every file and may throw to refuse the turn. There is NO built-in scan and none is pretended: leaving
 * it null means no scan ran, and the turn says nothing to the model about scanning.
 */
const zlib = require('node:zlib');
const { AiError } = require('./util');
const { extractArchive } = require('./archive-inputs');

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const MAX_PDF_STREAMS = 500;
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const TEXT_EXT = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|log|xml|yaml|yml|toml|ini|cfg|conf|html?|css|scss|less|m?js|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|gql|proto|swift|lua|pl|r|m|vue|svelte|astro|tex|env)$/i;
const CODE_TYPE = /^(text\/[a-z0-9.+-]+|application\/(json|jsonl|xml|javascript|ecmascript|x-javascript|x-httpd-php|x-sh|x-shellscript|x-python|x-ruby|x-yaml|x-yml|x-toml|x-tex|x-latex|x-c|x-c\+\+|x-java-source|x-php|x-perl|x-rust|x-go|x-typescript|x-www-form-urlencoded))$/i;
const IMAGE_TYPE = /^image\/(png|jpe?g|webp|gif)$/i;
const PDF_TYPE = /^application\/pdf$/i;
const ARCHIVE_TYPE = /^(application\/(zip|x-tar|gzip|x-gzip|x-gtar|x-compressed-tar))$/i;
const AUDIO_TYPE = /^audio\/(mpeg|mp3|mp4|x-m4a|wav|x-wav|wave|ogg|webm|flac|x-flac)$/i;

/** The named virus-scan extension point; null means no scan is configured (and none is pretended). */
let scanner = null;

/** Install the virus scan (server start-up or a test). fn({ file, name, media_type, bytes }) → may throw. */
function setScanner(fn) {
    if (fn != null && typeof fn !== 'function') throw new TypeError('setScanner: pass a function or null');
    scanner = fn;
}

const typeOf = (ct) => String(ct || '').split(';')[0].trim().toLowerCase();

function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
}

/** The type a file is treated as: the bytes' own content type when Media knows it, else the name. */
function effectiveType(name, contentType, declared) {
    let type = typeOf(contentType);
    if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') type = typeOf(declared);
    if ((!type || type === 'application/octet-stream' || type === 'binary/octet-stream') && TEXT_EXT.test(String(name || ''))) type = 'text/plain';
    if ((!type || type === 'application/octet-stream') && extOf(name) === 'pdf') type = 'application/pdf';
    if ((!type || type === 'application/octet-stream') && /\.zip$/i.test(name)) type = 'application/zip';
    if ((!type || type === 'application/octet-stream') && /\.(?:tar|tar\.gz|tgz)$/i.test(name)) type = 'application/x-tar';
    if ((!type || type === 'application/octet-stream') && /\.(?:mp3|m4a|mp4|wav|ogg|webm|flac)$/i.test(name)) type = ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' })[extOf(name)];
    if ((!type || type === 'application/octet-stream') && /^(png|jpe?g|webp|gif)$/.test(extOf(name))) type = `image/${extOf(name).replace('jpg', 'jpeg')}`;
    return type || 'application/octet-stream';
}

/** The Media object id a file reference names: `storage.key` (the contract) or `id`. */
function mediaIdOf(file) {
    const id = String((file && ((file.storage && file.storage.key) || file.id)) || '');
    if (!MEDIA_ID.test(id)) throw new AiError(422, 'files.invalid', `file ${String((file && file.name) || '(unnamed)').slice(0, 80)} must reference a stored Media object (med_…)`);
    return id;
}

function nameOf(file) {
    const name = String((file && file.name) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 255);
    return name || 'unnamed file';
}

/** The text of a PDF, from its content streams, without a dependency. */
function pdfText(buffer) {
    const raw = buffer.toString('latin1');
    if (/\/Encrypt\s/.test(raw)) return { pages: [], reason: 'the PDF is encrypted' };
    const pages = [];
    let total = 0;
    let seen = 0;
    const re = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
    let m;
    while ((m = re.exec(raw)) && seen < MAX_PDF_STREAMS) {
        seen++;
        const before = raw.slice(Math.max(0, m.index - 400), m.index);
        let data = Buffer.from(m[1], 'latin1');
        if (/\/FlateDecode\b/.test(before)) {
            try { data = zlib.inflateSync(data, { maxOutputLength: 8 * 1024 * 1024 }); } catch { continue; }
        } else if (/\/Filter\b/.test(before) && !/\/FlateDecode\b/.test(before)) {
            continue;                                    // an image (DCT) or another filter, not text
        }
        const text = contentText(data.toString('latin1'));
        if (text) { pages.push(text); total += text.length; }
        if (total >= MAX_TEXT_CHARS) break;
    }
    if (!pages.length) return { pages: [], reason: 'the PDF has no readable text (it may be scanned images, or use a custom encoding)' };
    return { pages };
}

/** The text Tj/TJ/`'` operators show in one PDF content stream. */
function contentText(stream) {
    const parts = [];
    let i = 0;
    const n = stream.length;
    const readString = () => {
        let out = '';
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
            const c = stream[i++];
            if (c === '\\') {
                const d = stream[i++];
                if (d === 'n') out += '\n';
                else if (d === 'r') out += '\r';
                else if (d === 't') out += '\t';
                else if (d === 'b') out += '\b';
                else if (d === 'f') out += '\f';
                else if (d === '\n' || d === '\r') { if (d === '\r' && stream[i] === '\n') i++; }
                else if (/[0-7]/.test(d)) {
                    let oct = d;
                    while (oct.length < 3 && /[0-7]/.test(stream[i])) oct += stream[i++];
                    out += String.fromCharCode(parseInt(oct, 8));
                } else out += d;
            } else if (c === '(') { depth++; out += c; }
            else if (c === ')') { depth--; if (depth) out += c; }
            else out += c;
        }
        return out;
    };
    while (i < n) {
        const c = stream[i];
        if (c === '(') {
            const s = readString();
            let j = i;
            while (j < n && /\s/.test(stream[j])) j++;
            if (stream.startsWith('Tj', j)) { parts.push(s); i = j + 2; continue; }
            if (stream.startsWith("'", j)) { parts.push(`\n${s}`); i = j + 1; continue; }
            if (stream.startsWith('"', j)) { parts.push(`\n${s}`); i = j + 1; continue; }
            continue;
        }
        if (c === '[') {
            i++;
            const arr = [];
            while (i < n && stream[i] !== ']') {
                if (stream[i] === '(') arr.push(readString());
                else i++;
            }
            i++;
            const end = stream.slice(i, i + 8);
            const tm = /^\s*TJ/.exec(end);
            if (tm) { parts.push(arr.join('')); i += tm[0].length; }
            continue;
        }
        if (stream.startsWith('T*', i) || stream.startsWith('Td', i) || stream.startsWith('TD', i) || stream.startsWith('ET', i)) {
            parts.push('\n'); i += 2; continue;
        }
        i++;
    }
    return parts.join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** The ai.file@1 a turn keeps for its reference: metadata only, never the bytes. */
function referenceOf(file, mediaId, name, mediaType, size, read) {
    return {
        id: mediaId,
        name,
        media_type: mediaType,
        size,
        storage: { provider: 'media', key: mediaId },
        access: {
            readers: Array.isArray(file && file.access && file.access.readers) && file.access.readers.length
                ? file.access.readers.map(String).slice(0, 50)
                : ['ai'],
        },
        read,
        role: 'input',
    };
}

/** Read one Media-backed file for the model. → { reference, part, note } */
async function readFile(file, fetcher, { signal, format = 'openai', vision = true, scan = null, transcribe = null } = {}) {
    const mediaId = mediaIdOf(file);
    const name = nameOf(file);
    const declaredSize = Number(file && file.size);
    // A caller that already read the file (the SDK's ov.ai.files.read) may send the ai.file@1 read result;
    // that is used without a Media fetch. Only an actual reading is trusted: a `not_readable` marker is not.
    const supplied = file && file.read && typeof file.read === 'object' ? file.read : null;
    if (supplied && supplied.method === 'text' && typeof supplied.content === 'string') {
        const type = effectiveType(name, null, file && file.media_type);
        const size = Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : supplied.content.length;
        const hook = scan || scanner;
        if (hook) await hook({ file, media_id: mediaId, name, media_type: type, bytes: Buffer.from(supplied.content) });
        const text = capText(supplied.content);
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'text' }), part: textPart(format, `\n\n[Attached file: ${name} (${type})]\n${text}\n`), note: null };
    }
    if (supplied && supplied.method === 'pages' && Array.isArray(supplied.pages) && supplied.pages.length) {
        const type = effectiveType(name, null, file && file.media_type);
        const size = Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : supplied.pages.join('').length;
        const text = capText(supplied.pages.map((p, i) => `--- page ${i + 1} ---\n${String(p || '')}`).join('\n\n'));
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'pages' }), part: textPart(format, `\n\n[Attached PDF: ${name} (${type})]\n${text}\n`), note: null };
    }
    if (supplied && supplied.method === 'image' && typeof supplied.content === 'string' && /^data:image\//i.test(supplied.content)) {
        const type = effectiveType(name, null, file && file.media_type);
        const size = Number.isFinite(declaredSize) && declaredSize >= 0 ? declaredSize : 0;
        if (vision) {
            const mm = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(supplied.content);
            if (mm) {
                const part = format === 'anthropic'
                    ? { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } }
                    : { type: 'image_url', image_url: { url: supplied.content } };
                return { reference: referenceOf(file, mediaId, name, type, size, { method: 'image' }), part, note: null };
            }
        }
    }
    let fetched;
    try {
        fetched = await fetcher.fetchUrl(fetcher.mediaRefUrl({ media_id: mediaId }), { signal, maxBytes: MAX_FILE_BYTES, timeoutMs: 30000 });
    } catch (err) {
        if (err && (err.status === 404 || err.upstreamStatus === 404)) throw new AiError(422, 'files.unreadable', `file ${name} is not a readable Media object`);
        throw err;
    }
    const { buffer } = fetched;
    const type = effectiveType(name, fetched.contentType, file && file.media_type);
    const size = Number.isFinite(declaredSize) && declaredSize >= 0 ? Math.max(declaredSize, buffer.length) : buffer.length;
    const hook = scan || scanner;
    if (hook) await hook({ file, media_id: mediaId, name, media_type: type, bytes: buffer });
    if (PDF_TYPE.test(type) || extOf(name) === 'pdf') {
        const pdf = pdfText(buffer);
        if (pdf.pages.length) {
            const text = capText(pdf.pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join('\n\n'));
            return { reference: referenceOf(file, mediaId, name, type, size, { method: 'pages' }), part: textPart(format, `\n\n[Attached PDF: ${name} (${type})]\n${text}\n`), note: null };
        }
        const reason = `could not read this PDF: ${pdf.reason}`;
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'not_readable', reason }), part: null, note: `[Attached file: ${name} (${type}); ${reason}.]` };
    }
    if (IMAGE_TYPE.test(type)) {
        const data = buffer.toString('base64');
        if (vision) {
            const part = format === 'anthropic'
                ? { type: 'image', source: { type: 'base64', media_type: type, data } }
                : { type: 'image_url', image_url: { url: `data:${type};base64,${data}` } };
            return { reference: referenceOf(file, mediaId, name, type, size, { method: 'image' }), part, note: null };
        }
        const reason = 'this model cannot see images, so the picture itself was not passed';
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'not_readable', reason }), part: null, note: `[Attached image: ${name} (${type}); ${reason}.]` };
    }
    if (AUDIO_TYPE.test(type)) {
        let result = null;
        if (transcribe) {
            try { result = await transcribe({ bytes: buffer, media_type: type, name, signal }); }
            catch (err) { if (signal && signal.aborted) throw err; }
        }
        const transcript = result && typeof result.text === 'string' ? capText(result.text.trim()) : '';
        if (transcript) return { reference: referenceOf(file, mediaId, name, type, size, { method: 'text' }),
            part: textPart(format, `\n\n[Attached audio transcript: ${name} (${type})]\n${transcript}\n`), note: null };
        const reason = transcribe ? 'local speech recognition could not read this audio' : 'local speech recognition is unavailable';
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'not_readable', reason }), part: null,
            note: `[Attached audio: ${name} (${type}); ${reason}.]` };
    }
    if (ARCHIVE_TYPE.test(type) || /\.(?:zip|tar|tar\.gz|tgz)$/i.test(name)) {
        const archive = extractArchive(buffer, type, name);
        const parts = (archive.entries || []).map((entry) => {
            if (/\.pdf$/i.test(entry.name)) {
                const pdf = pdfText(entry.bytes);
                return pdf.pages.length ? `--- ${entry.name} (PDF) ---\n${pdf.pages.join('\n\n')}` : null;
            }
            return `--- ${entry.name} ---\n${entry.bytes.toString('utf8').replace(/\u0000/g, '')}`;
        }).filter(Boolean);
        if (parts.length) {
            const skipped = (archive.skipped || 0) + (archive.entries.length - parts.length);
            const text = capText(`${parts.join('\n\n')}${skipped ? `\n\n(${skipped} archive entries were not read)` : ''}`);
            return { reference: referenceOf(file, mediaId, name, type, size, { method: 'text' }), part: textPart(format, `\n\n[Attached archive: ${name} (${type})]\n${text}\n`), note: null };
        }
        const reason = archive.reason || 'the archive has no readable text, code or PDF entries';
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'not_readable', reason }), part: null, note: `[Attached archive: ${name} (${type}); ${reason}.]` };
    }
    if (CODE_TYPE.test(type) || TEXT_EXT.test(name) || /^text\//.test(type)) {
        const text = capText(buffer.toString('utf8').replace(/\u0000/g, ''));
        if (!text.trim()) {
            const reason = 'the file is empty';
            return { reference: referenceOf(file, mediaId, name, type, size, { method: 'not_readable', reason }), part: null, note: `[Attached file: ${name} (${type}); ${reason}.]` };
        }
        return { reference: referenceOf(file, mediaId, name, type, size, { method: 'text' }), part: textPart(format, `\n\n[Attached file: ${name} (${type})]\n${text}\n`), note: null };
    }
    const reason = 'this file type cannot be read as text or seen as an image';
    return {
        reference: referenceOf(file, mediaId, name, type, size, { method: 'not_readable', reason }),
        part: null,
        note: `[Attached file: ${name} (${type}); ${reason}. Use its name and type when you answer, and say what you could not read.]`,
    };
}

function textPart(format, text) {
    return { type: 'text', text };
}

function capText(text) {
    const s = String(text || '');
    if (s.length <= MAX_TEXT_CHARS) return s;
    return `${s.slice(0, MAX_TEXT_CHARS)}\n\n(truncated: ${s.length - MAX_TEXT_CHARS} more characters were not passed)`;
}

function capPages(pages) {
    let left = MAX_TEXT_CHARS;
    const out = [];
    for (const p of pages) {
        if (left <= 0) break;
        const s = String(p || '');
        out.push(s.length <= left ? s : `${s.slice(0, left)}\n(truncated)`);
        left -= Math.min(s.length, left);
    }
    return out;
}

/** The declared size of a file reference, for the count/byte limit before any fetch. */
function declaredSize(file) {
    const n = Number(file && file.size);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function checkLimits(files) {
    if (files.length > MAX_FILES) throw new AiError(413, 'files.too_many', `at most ${MAX_FILES} files may be attached to a turn`);
    let total = 0;
    for (const f of files) {
        const size = declaredSize(f);
        if (size > MAX_FILE_BYTES) throw new AiError(413, 'files.too_large', `each attached file may be up to ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
        total += size;
    }
    if (total > MAX_TOTAL_BYTES) throw new AiError(413, 'files.too_large', `attached files may be up to ${MAX_TOTAL_BYTES / 1024 / 1024} MiB together`);
    return total;
}

/** The last user message of a protocol message list (or a new one). */
function lastUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i] && messages[i].role === 'user') return i;
    return -1;
}

function userContent(format, content) {
    if (content == null || content === '') return [];
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content.map(x => (format === 'anthropic' && x && x.type === 'text' ? { type: 'text', text: String(x.text || '') } : x)) : [{ type: 'text', text: String(content) }];
}

/**
 * Resolve a turn's `files` (Media references) and add what the model can read to its last user message.
 * Returns a NEW input: the messages gain parts, the file references stay metadata-only (`read` says what
 * happened to each, which is the ai.file@1 shape). No bytes or extracted text are put into `input.files`.
 */
async function attachFiles(input, fetcher, { signal, format = 'openai', vision = true, scan = null, transcribe = null } = {}) {
    const files = Array.isArray(input && input.files) ? input.files : [];
    if (!files.length) return input;
    checkLimits(files);
    const references = [];
    const additions = [];
    let total = 0;
    let hasImage = false;
    for (const file of files) {
        const read = await readFile(file, fetcher, { signal, format, vision, scan, transcribe });
        total += read.reference.size;
        if (total > MAX_TOTAL_BYTES) throw new AiError(413, 'files.too_large', `attached files may be up to ${MAX_TOTAL_BYTES / 1024 / 1024} MiB together`);
        references.push(read.reference);
        if (read.part && read.part.type === 'image') hasImage = true;
        if (read.part && read.part.type === 'image_url') hasImage = true;
        if (read.part) additions.push(read.part);
        if (read.note) additions.push({ type: 'text', text: read.note });
    }
    const messages = Array.isArray(input.messages) ? input.messages.map(x => ({ ...x })) : [];
    let index = lastUserIndex(messages);
    if (index < 0) { messages.push({ role: 'user', content: [] }); index = messages.length - 1; }
    messages[index] = { ...messages[index], content: [...userContent(format, messages[index].content), ...additions] };
    return { ...input, messages, files: references, hasImage };
}

module.exports = {
    attachFiles, readFile, pdfText, effectiveType, mediaIdOf, checkLimits, setScanner, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_TEXT_CHARS,
};
