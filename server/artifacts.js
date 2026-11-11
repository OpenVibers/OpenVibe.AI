'use strict';
/**
 * Files a model produced on a turn, returned as stored files (ai.file@1, role 'artifact').
 *
 * A provider can answer with files beside its text: each entry names a Media object it already stored
 * (the reference shape), which is returned as it is. A provider that hands back the bytes themselves
 * (`data`/`b64`) goes to the existing Media uploader, private to the person on the turn.
 * When Media is unavailable, such a file is refused with files.store_unavailable and is never
 * put in the run output as inline bytes.
 */
const { AiError } = require('./util');

const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

function storedRef(file) {
    const id = String((file && file.id) || (file && file.storage && file.storage.key) || '');
    if (!MEDIA_ID.test(id)) return null;
    const name = String((file && file.name) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 255) || 'file';
    const mediaType = String((file && file.media_type) || 'application/octet-stream').split(';')[0].trim().slice(0, 255) || 'application/octet-stream';
    const size = Math.max(0, Math.floor(Number(file && file.size) || 0));
    return {
        id, name, media_type: mediaType, size,
        storage: { provider: 'media', key: id },
        access: { readers: Array.isArray(file && file.access && file.access.readers) && file.access.readers.length ? file.access.readers.map(String).slice(0, 50) : [] },
        read: { method: 'not_readable', reason: 'Stored by Media; read it by reference.' },
        role: 'artifact',
    };
}

/** The Media store for inline output bytes; a generated file belongs to the person on the turn. */
function storeOf(config, mediaStore = null) {
    const s = config && config.media && config.media.artifactStore;
    if (s && typeof s.put === 'function') return s;
    if (!mediaStore || typeof mediaStore.put !== 'function' || typeof mediaStore.configured !== 'function' || !mediaStore.configured()) return null;
    return { put: async ({ name, media_type: mediaType, bytes, subject }) => {
        if (!subject) throw new AiError(422, 'files.subject_required', 'a generated file needs a person on the turn so Media can keep it private to them');
        if (bytes.length > MAX_ARTIFACT_BYTES) throw new AiError(413, 'files.too_large', 'a generated file may be up to 10 MiB');
        const saved = await mediaStore.put({ bytes, mime: mediaType || 'application/octet-stream', filename: name || 'file', owner: subject,
            visibility: 'private', metadata: { origin: 'ai.turn.artifact' } });
        const ref = storedRef({ id: saved.media_id, name, media_type: mediaType, size: bytes.length, access: { readers: [subject] } });
        if (!ref) throw new AiError(502, 'files.store_invalid', 'Media did not return a valid file reference');
        return ref;
    } };
}

/**
 * The files a provider's message carries, as stored ai.file@1 artifacts.
 * message.artifacts (or message.files) is the list; each is either a Media reference or inline bytes.
 */
async function collectArtifacts(message, { store = null, subject = null } = {}) {
    const raw = message && (Array.isArray(message.artifacts) ? message.artifacts : Array.isArray(message.files) ? message.files : []);
    if (!raw.length) return [];
    if (raw.length > MAX_ARTIFACTS) throw new AiError(413, 'files.too_many', `a model may return at most ${MAX_ARTIFACTS} files`);
    const out = [];
    for (const file of raw) {
        const ref = storedRef(file);
        if (ref) { out.push(ref); continue; }
        const bytes = Buffer.isBuffer(file && file.bytes) ? file.bytes
            : typeof (file && (file.data || file.b64)) === 'string' ? Buffer.from(file.data || file.b64, file.encoding === 'utf8' ? 'utf8' : 'base64')
                : null;
        if (!bytes) throw new AiError(422, 'files.invalid', `a model returned a file without bytes or a Media reference: ${String((file && file.name) || 'unnamed').slice(0, 80)}`);
        if (bytes.length > MAX_ARTIFACT_BYTES) throw new AiError(413, 'files.too_large', 'a generated file may be up to 10 MiB');
        if (!store) throw new AiError(503, 'files.store_unavailable', 'a model produced a file but AI has no Media store configured to keep it');
        out.push(await store.put({ name: file.name, media_type: file.media_type || file.type, bytes, subject }));
    }
    return out;
}

/** Turn a requested text answer into a private Media file with the same text as the answer. */
async function collectTextArtifact(text, request, { store = null, subject = null } = {}) {
    if (!request) return [];
    const name = String(request.name || '');
    if (!name || name.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(name)) throw new AiError(422, 'files.name_invalid', 'output_file.name must be a filename without a path');
    if (!['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(request.media_type)) throw new AiError(422, 'files.type_invalid', 'output_file.media_type must be a supported text type');
    if (typeof text !== 'string' || !text.length) throw new AiError(422, 'files.text_missing', 'the model returned no text to save as output_file');
    return collectArtifacts({ artifacts: [{ name, media_type: request.media_type, data: text, encoding: 'utf8' }] }, { store, subject });
}

module.exports = { collectArtifacts, collectTextArtifact, storeOf, MAX_ARTIFACTS };
